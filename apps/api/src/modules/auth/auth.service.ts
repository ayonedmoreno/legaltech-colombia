import { HttpError } from "../../common/http-error.js";
import type { Actor } from "../../common/policy.js";
import { dummyPasswordHash, hashPassword, verifyPassword } from "../../security/password.js";
import { sha256Hex } from "../../security/crypto.js";
import {
  FORGOT_EMAIL_LIMIT,
  RESEND_ACCOUNT_LIMIT,
  remainingProgressiveDelayMs,
} from "./auth.email-settings.js";
import { toPublicSession, toPublicUser } from "./auth.mapper.js";
import { can } from "./auth.policy.js";
import {
  createSessionForUser,
  csrfTokenMatchesSession,
  isRotationDue,
  loadValidSession,
  rotateSessionForUser,
} from "./auth.session.js";
import type { Clock } from "./auth.session.js";
import { DuplicateEmailError, LoginAttemptUnavailableError } from "./auth.types.js";
import type { AuditLogEntry, AuthRepository, SessionRecord, UserRecord } from "./auth.types.js";
import type { Session, User } from "@legaltech/contracts";

export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface AuthServiceOptions {
  repository: AuthRepository;
  /** Whether the process runs in production (ADR-002: MFA barrier for internal roles). */
  isProduction: boolean;
  clock?: Clock;
  /**
   * Failed logins per account allowed within the window before the progressive delay applies
   * (ADR-002, D3: 5 by default).
   */
  accountLoginAttemptLimit?: number;
  /** Window in which failed logins count towards the per-account limit (ADR-002, D3: 24 h). */
  accountLoginWindowMs?: number;
}

export interface LoginResult {
  user: User;
  sessionRaw: string;
  csrfRaw: string;
}

export interface CurrentUserResult {
  user: User;
  session: SessionRecord;
  /** The same user as seen by policies (ADR-003). */
  actor: Actor;
}

/** ADR-002 D3 (P-1): first delay once the per-account limit is reached, and its cap. */
const LOGIN_DELAY_BASE_MS = 30_000;
const LOGIN_DELAY_CAP_MS = 900_000;

/** How a login attempt ended, decided inside the per-account attempt and acted on after it. */
type LoginOutcome =
  | { kind: "throttled"; retryAfterSeconds: number }
  | { kind: "invalid_credentials" }
  | { kind: "mfa_required" }
  | { kind: "granted"; user: UserRecord };

/** The `auth.login.failed` event: counts towards the per-account limit (ADR-002). */
function loginFailure(
  user: UserRecord | null,
  emailHash: string,
  context: RequestContext,
  reason?: string,
): AuditLogEntry {
  return {
    actorUserId: user?.id ?? null,
    actorRole: user?.role ?? null,
    action: "auth.login.failed",
    entityType: user ? "User" : null,
    entityId: user?.id ?? null,
    metadata: { emailHash, ...(reason ? { reason } : {}) },
    requestId: context.requestId,
    ip: context.ip,
    userAgent: context.userAgent,
  };
}

/**
 * The `auth.login.rate_limited` event (ADR-002, D3): a login refused by the per-account limit.
 * No actor and no entity, so it does not reveal whether the account exists; it does not count
 * towards the limit.
 */
function loginRateLimited(
  emailHash: string,
  retryAfterSeconds: number,
  context: RequestContext,
): AuditLogEntry {
  return {
    actorUserId: null,
    actorRole: null,
    action: "auth.login.rate_limited",
    entityType: null,
    entityId: null,
    metadata: { emailHash, retryAfterSeconds },
    requestId: context.requestId,
    ip: context.ip,
    userAgent: context.userAgent,
  };
}

/** Lowercased, trimmed form stored in the database (matches the `users_email_normalized_chk` constraint). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class AuthService {
  private readonly repository: AuthRepository;
  private readonly isProduction: boolean;
  private readonly clock: Clock;
  private readonly accountLoginAttemptLimit: number;
  private readonly accountLoginWindowMs: number;

  constructor(options: AuthServiceOptions) {
    this.repository = options.repository;
    this.isProduction = options.isProduction;
    this.clock = options.clock ?? (() => new Date());
    this.accountLoginAttemptLimit = options.accountLoginAttemptLimit ?? 5;
    this.accountLoginWindowMs = options.accountLoginWindowMs ?? 24 * 60 * 60 * 1000;
  }

  /**
   * ADR-002 (D3): once an account has F failed logins in the window, with F at or above the
   * limit, its next attempt must wait D = min(30 s · 2^(F − limit), 900 s) from the most recent
   * failure. Returns how long is still left to wait (0 or less: the attempt may proceed). Both
   * times come from PostgreSQL, read inside the attempt's transaction.
   */
  private remainingLoginDelayMs(failures: number, lastFailureAt: Date | null, now: Date): number {
    if (failures < this.accountLoginAttemptLimit || lastFailureAt === null) return 0;
    const delayMs = Math.min(
      LOGIN_DELAY_BASE_MS * 2 ** (failures - this.accountLoginAttemptLimit),
      LOGIN_DELAY_CAP_MS,
    );
    return lastFailureAt.getTime() + delayMs - now.getTime();
  }

  /**
   * Creates a user with role USER. Always succeeds from the caller's point of view, even
   * when the email is already registered: this avoids account enumeration through the
   * registration endpoint (API_SPEC.md). A new account gets its initial verification email in
   * the same transaction (Sprint 1B decision P6): the outbox records the intent, and the token
   * is only generated when the email is dispatched. A duplicate registration sends nothing.
   */
  async register(
    input: { email: string; password: string; fullName: string },
    context: RequestContext,
  ): Promise<void> {
    const email = normalizeEmail(input.email);
    // Hashed before the existence check, on both paths: skipping Argon2id for a duplicate
    // email would make that response measurably faster and reveal the account exists.
    const passwordHash = await hashPassword(input.password);
    const existing = await this.repository.findUserByEmail(email);

    if (existing) {
      await this.auditDuplicateRegistration(existing.id, context);
      return;
    }

    let user: UserRecord;
    try {
      user = await this.repository.createUserWithEmailVerification({
        email,
        passwordHash,
        fullName: input.fullName.trim(),
      });
    } catch (error) {
      if (!(error instanceof DuplicateEmailError)) throw error;
      // A concurrent registration for the same email was inserted between the check above
      // and this insert. It is a duplicate like any other: same audit event, same 202.
      const winner = await this.repository.findUserByEmail(email);
      await this.auditDuplicateRegistration(winner?.id ?? null, context);
      return;
    }

    await this.repository.writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      action: "auth.register",
      entityType: "User",
      entityId: user.id,
      metadata: { outcome: "created" },
      requestId: context.requestId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  private async auditDuplicateRegistration(
    existingUserId: string | null,
    context: RequestContext,
  ): Promise<void> {
    await this.repository.writeAuditLog({
      actorUserId: null,
      actorRole: null,
      action: "auth.register",
      entityType: "User",
      entityId: existingUserId,
      metadata: { outcome: "duplicate" },
      requestId: context.requestId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  async login(
    input: { email: string; password: string },
    context: RequestContext,
    previousSessionRaw?: string,
  ): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    const emailHash = sha256Hex(email);

    // ADR-002 (D3): the limit check, the password verification and the failure record run as
    // one attempt per account, serialized in the database, so concurrent attempts cannot both
    // pass the limit. The outcome is only acted on after that attempt has committed.
    let outcome: LoginOutcome;
    try {
      outcome = await this.repository.runLoginAttempt(
        emailHash,
        this.accountLoginWindowMs,
        async (attempt): Promise<LoginOutcome> => {
          const remainingMs = this.remainingLoginDelayMs(
            attempt.recentFailures,
            attempt.lastFailureAt,
            attempt.now,
          );
          if (remainingMs > 0) {
            const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
            // Written in the attempt's transaction: it exists only if the refusal commits.
            await attempt.writeAuditLog(loginRateLimited(emailHash, retryAfterSeconds, context));
            return { kind: "throttled", retryAfterSeconds };
          }

          const user = await attempt.findUserByEmail(email);
          // Always run exactly one Argon2id verification, against a dummy hash when there is no
          // such user, so an unknown email is not answered measurably faster than a wrong password.
          const passwordOk = await verifyPassword(
            user?.passwordHash ?? (await dummyPasswordHash()),
            input.password,
          );

          if (!user || !passwordOk || user.status !== "ACTIVE") {
            await attempt.writeAuditLog(loginFailure(user, emailHash, context));
            return { kind: "invalid_credentials" };
          }

          if (this.isProduction && (user.role === "ADMIN" || user.role === "SUPER_ADMIN")) {
            // ADR-002: fail closed. MFA is not implemented yet (out of scope for this Sprint), so
            // no ADMIN/SUPER_ADMIN session can be created in production until it is.
            await attempt.writeAuditLog(
              loginFailure(user, emailHash, context, "mfa_required_production"),
            );
            return { kind: "mfa_required" };
          }

          return { kind: "granted", user };
        },
      );
    } catch (error) {
      if (error instanceof LoginAttemptUnavailableError) {
        throw new HttpError(
          503,
          "SERVICE_UNAVAILABLE",
          "Servicio no disponible temporalmente. Inténtalo más tarde.",
          { headers: { "Retry-After": "1" } },
        );
      }
      throw error;
    }

    if (outcome.kind === "throttled") {
      // ADR-002 (D3): the same message as the per-IP limit.
      throw new HttpError(429, "RATE_LIMITED", "Demasiadas solicitudes. Inténtalo más tarde.", {
        headers: { "Retry-After": String(outcome.retryAfterSeconds) },
      });
    }
    if (outcome.kind === "invalid_credentials") {
      throw new HttpError(401, "INVALID_CREDENTIALS", "Credenciales inválidas.");
    }
    if (outcome.kind === "mfa_required") {
      throw new HttpError(
        403,
        "FORBIDDEN",
        "El inicio de sesión para este rol requiere autenticación multifactor, aún no disponible.",
      );
    }
    const { user } = outcome;

    const { sessionRaw, csrfRaw } = await createSessionForUser(
      this.repository,
      user,
      { ip: context.ip, userAgent: context.userAgent },
      this.clock,
    );
    // ADR-002: rotation on login (decision P12). A session this browser already held is revoked
    // with ROTATED once the new one exists; a failed login leaves it untouched.
    if (previousSessionRaw) {
      const previous = await this.repository.findSessionByTokenHash(sha256Hex(previousSessionRaw));
      if (previous) await this.repository.revokeSession(previous.id, "ROTATED");
    }

    await this.repository.writeAuditLog({
      actorUserId: user.id,
      actorRole: user.role,
      action: "auth.login.success",
      entityType: "User",
      entityId: user.id,
      requestId: context.requestId,
      ip: context.ip,
      userAgent: context.userAgent,
    });

    return { user: toPublicUser(user), sessionRaw, csrfRaw };
  }

  /**
   * Loads and validates the current session and its user. Returns null for any reason the
   * caller should treat as "not authenticated": missing/invalid/expired/revoked session, or
   * a suspended user — a suspended user must not be able to use an otherwise-valid session.
   */
  async currentUser(sessionRawToken: string | undefined): Promise<CurrentUserResult | null> {
    const loaded = await loadValidSession(this.repository, sessionRawToken, this.clock);
    if (!loaded) return null;

    const user = await this.findUserById(loaded.session.userId);
    if (!user || user.status !== "ACTIVE") return null;

    return {
      user: toPublicUser(user),
      session: loaded.session,
      actor: { id: user.id, role: user.role, status: user.status },
    };
  }

  /**
   * GET /api/auth/me: the current user's own profile, authorized by the auth policy's
   * `user:read` (ADR-003). A denied read answers 404, never 403, so it does not confirm that
   * the resource exists.
   */
  async readOwnProfile(sessionRawToken: string | undefined): Promise<User> {
    const current = await this.currentUser(sessionRawToken);
    if (!current) {
      throw new HttpError(401, "UNAUTHENTICATED", "Se requiere autenticación.");
    }
    if (!can(current.actor, "user:read", { id: current.user.id }).allowed) {
      throw new HttpError(404, "NOT_FOUND", "Recurso no encontrado.");
    }
    return current.user;
  }

  /**
   * GET /api/auth/sessions: the current user's own valid sessions, with the one this request
   * was made with marked `current`. Authorized by the auth policy's `session:list` (ADR-003);
   * a denied list answers 404, never 403, like `readOwnProfile`. The repository is always
   * scoped to the actor, so another user's sessions can never be listed.
   */
  async listOwnSessions(sessionRawToken: string | undefined): Promise<Session[]> {
    const current = await this.currentUser(sessionRawToken);
    if (!current) {
      throw new HttpError(401, "UNAUTHENTICATED", "Se requiere autenticación.");
    }
    if (!can(current.actor, "session:list", { userId: current.user.id }).allowed) {
      throw new HttpError(404, "NOT_FOUND", "Recurso no encontrado.");
    }
    const sessions = await this.repository.listActiveSessions(current.user.id, this.clock());
    return sessions.map((session) => toPublicSession(session, current.session.id));
  }

  /**
   * POST /api/auth/session/rotate (ADR-002: rotation "periódicamente durante el uso"; decisions
   * P10/P11): renews the current session once it is due for its role — a new identifier and CSRF
   * token, the same absolute expiry — and leaves the previous one valid for the grace period.
   * Not due, or already rotated by a concurrent request: nothing changes. Authorized by
   * `session:revoke` on the user's own session (ADR-003). Not audited (decision P9). The caller
   * has authenticated the request and checked its CSRF token.
   */
  async rotateSession(
    current: CurrentUserResult,
    context: RequestContext,
  ): Promise<{ rotated: false } | { rotated: true; sessionRaw: string; csrfRaw: string }> {
    if (!can(current.actor, "session:revoke", { userId: current.user.id }).allowed) {
      throw new HttpError(404, "NOT_FOUND", "Recurso no encontrado.");
    }
    if (!isRotationDue(current.session, current.actor.role, this.clock())) {
      return { rotated: false };
    }
    const created = await rotateSessionForUser(
      this.repository,
      current.session,
      { id: current.user.id, role: current.actor.role },
      { ip: context.ip, userAgent: context.userAgent },
      this.clock,
    );
    return created
      ? { rotated: true, sessionRaw: created.sessionRaw, csrfRaw: created.csrfRaw }
      : { rotated: false };
  }

  /**
   * POST /api/auth/email/verify (ADR-002 "Verificación de email"): consumes the token from the
   * link — one use, not expired — and marks the email verified. Unknown, used and expired tokens
   * all answer the same 400, without telling them apart (API_SPEC.md).
   */
  async verifyEmail(token: string, context: RequestContext): Promise<void> {
    // The use of the token, the verification and its event in one transaction: all or nothing.
    const userId = await this.repository.consumeEmailVerificationToken(
      sha256Hex(token),
      (user) => ({
        actorUserId: user.id,
        actorRole: user.role,
        action: "auth.email.verified",
        entityType: "User",
        entityId: user.id,
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
      }),
    );
    if (!userId) {
      throw new HttpError(400, "INVALID_OR_EXPIRED_TOKEN", "El enlace no es válido o ha caducado.");
    }
  }

  /**
   * POST /api/auth/email/verification/resend (ADR-002 "Reenvío de verificación con rate limit"):
   * records one more verification email for the current user, under the per-account progressive
   * delay (ADR-002; values in auth.email-settings.ts), evaluated under a per-user lock. An address
   * already verified gets nothing new. The caller has authenticated the request, checked its
   * CSRF token and applied the per-IP limit.
   */
  async resendEmailVerification(current: CurrentUserResult): Promise<void> {
    if (current.user.emailVerified) return;

    let outcome: { kind: "throttled"; retryAfterSeconds: number } | { kind: "enqueued" };
    try {
      outcome = await this.repository.runEmailVerificationResend(
        current.user.id,
        RESEND_ACCOUNT_LIMIT.windowMs,
        async (scope) => {
          const remainingMs = remainingProgressiveDelayMs(
            scope.recentEmails,
            scope.lastEmailAt,
            scope.now,
            RESEND_ACCOUNT_LIMIT,
          );
          if (remainingMs > 0) {
            return {
              kind: "throttled",
              retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
            };
          }
          await scope.enqueueVerificationEmail();
          return { kind: "enqueued" };
        },
      );
    } catch (error) {
      if (error instanceof LoginAttemptUnavailableError) {
        throw new HttpError(
          503,
          "SERVICE_UNAVAILABLE",
          "Servicio no disponible temporalmente. Inténtalo más tarde.",
          { headers: { "Retry-After": "1" } },
        );
      }
      throw error;
    }

    if (outcome.kind === "throttled") {
      throw new HttpError(429, "RATE_LIMITED", "Demasiadas solicitudes. Inténtalo más tarde.", {
        headers: { "Retry-After": String(outcome.retryAfterSeconds) },
      });
    }
  }

  /**
   * POST /api/auth/password/forgot (ADR-002 "Recuperación segura"): always the same answer,
   * whether or not the address is registered (no enumeration). Under the per-email progressive
   * delay (ADR-002; values in auth.email-settings.ts), counted from `auth.password.reset_requested`
   * events by email hash — so an unknown address is limited exactly like a registered one — and
   * evaluated under a per-email lock, like the login limit (D3). A registered address gets the
   * reset email recorded in the outbox; its token is only generated when the email is dispatched.
   */
  async forgotPassword(input: { email: string }, context: RequestContext): Promise<void> {
    const email = normalizeEmail(input.email);
    const emailHash = sha256Hex(email);

    let outcome: { kind: "throttled"; retryAfterSeconds: number } | { kind: "requested" };
    try {
      outcome = await this.repository.runPasswordResetRequest(
        emailHash,
        FORGOT_EMAIL_LIMIT.windowMs,
        async (scope) => {
          const remainingMs = remainingProgressiveDelayMs(
            scope.recentRequests,
            scope.lastRequestAt,
            scope.now,
            FORGOT_EMAIL_LIMIT,
          );
          if (remainingMs > 0) {
            return {
              kind: "throttled",
              retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
            };
          }
          const user = await scope.findUserByEmail(email);
          await scope.writeAuditLog({
            actorUserId: user?.id ?? null,
            actorRole: user?.role ?? null,
            action: "auth.password.reset_requested",
            entityType: user ? "User" : null,
            entityId: user?.id ?? null,
            metadata: { emailHash },
            requestId: context.requestId,
            ip: context.ip,
            userAgent: context.userAgent,
          });
          if (user) await scope.enqueuePasswordResetEmail(user.id);
          return { kind: "requested" };
        },
      );
    } catch (error) {
      if (error instanceof LoginAttemptUnavailableError) {
        throw new HttpError(
          503,
          "SERVICE_UNAVAILABLE",
          "Servicio no disponible temporalmente. Inténtalo más tarde.",
          { headers: { "Retry-After": "1" } },
        );
      }
      throw error;
    }

    if (outcome.kind === "throttled") {
      throw new HttpError(429, "RATE_LIMITED", "Demasiadas solicitudes. Inténtalo más tarde.", {
        headers: { "Retry-After": String(outcome.retryAfterSeconds) },
      });
    }
  }

  /**
   * POST /api/auth/password/reset (ADR-002): sets a new password with the token from the reset
   * link. The new password is hashed first, so every request costs the same whether or not its
   * token is valid. Everything else happens in one transaction: the token is used, the password
   * replaced, every session of the user revoked with `PASSWORD_RESET`, the notice email recorded
   * and `auth.password.reset_completed` audited. An unusable token changes nothing and answers
   * the same 400 whatever the reason.
   */
  async resetPassword(
    input: { token: string; newPassword: string },
    context: RequestContext,
  ): Promise<void> {
    const passwordHash = await hashPassword(input.newPassword);
    const user = await this.repository.resetPassword({
      tokenHash: sha256Hex(input.token),
      passwordHash,
      audit: (target) => ({
        actorUserId: target.id,
        actorRole: target.role,
        action: "auth.password.reset_completed",
        entityType: "User",
        entityId: target.id,
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
      }),
    });
    if (!user) {
      throw new HttpError(400, "INVALID_OR_EXPIRED_TOKEN", "El enlace no es válido o ha caducado.");
    }
  }

  /**
   * DELETE /api/auth/sessions/:sessionId: revokes one of the current user's own sessions
   * (ADR-002 "revocación de una sesión propia por ID"), with reason `LOGOUT`. Authorized by the
   * auth policy's `session:revoke` (ADR-003), and the revocation itself is scoped to the user in
   * the repository: another user's session, an unknown id, and a session already revoked or
   * expired all answer the same 404, so none of them is confirmed to exist. The caller has
   * already authenticated the request and checked its CSRF token.
   */
  async revokeOwnSession(
    current: CurrentUserResult,
    sessionId: string,
    context: RequestContext,
  ): Promise<{ revokedCurrent: boolean }> {
    if (!can(current.actor, "session:revoke", { userId: current.user.id }).allowed) {
      throw new HttpError(404, "NOT_FOUND", "Recurso no encontrado.");
    }
    // The revocation and its event in one transaction (H1): both, or neither.
    const revoked = await this.repository.revokeOwnSession(
      sessionId,
      current.user.id,
      this.clock(),
      "LOGOUT",
      {
        actorUserId: current.user.id,
        actorRole: current.user.role,
        action: "auth.session.revoked",
        entityType: "Session",
        entityId: sessionId,
        requestId: context.requestId,
        ip: context.ip,
        userAgent: context.userAgent,
      },
    );
    if (!revoked) {
      throw new HttpError(404, "NOT_FOUND", "Recurso no encontrado.");
    }
    return { revokedCurrent: sessionId === current.session.id };
  }

  /**
   * POST /api/auth/logout-all: revokes every session of the current user, the current one
   * included (ADR-002 "cierre de todas las sesiones"), with reason `LOGOUT_ALL`. Authorized by
   * the auth policy's `session:revoke` on the user's own sessions (ADR-003); the revocation is
   * scoped to the user in the repository, so no other user's session can be touched. The caller
   * has already authenticated the request and checked its CSRF token.
   */
  async logoutAll(current: CurrentUserResult, context: RequestContext): Promise<void> {
    if (!can(current.actor, "session:revoke", { userId: current.user.id }).allowed) {
      throw new HttpError(404, "NOT_FOUND", "Recurso no encontrado.");
    }
    // The revocations and their event in one transaction (H1).
    await this.repository.revokeAllOwnSessions(current.user.id, "LOGOUT_ALL", {
      actorUserId: current.user.id,
      actorRole: current.user.role,
      action: "auth.logout_all",
      entityType: "User",
      entityId: current.user.id,
      requestId: context.requestId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  /**
   * Always succeeds from the caller's point of view, even for a missing, already-revoked
   * or expired session (API_SPEC.md, `POST /api/auth/logout`: 204 also when the session is
   * no longer valid).
   */
  async logout(sessionRawToken: string | undefined, context: RequestContext): Promise<void> {
    const loaded = await loadValidSession(this.repository, sessionRawToken, this.clock);
    if (!loaded) return;

    const user = await this.findUserById(loaded.session.userId);
    // The revocation and its event in one transaction; a session revoked concurrently in the
    // meantime is left as it is, with no second event (H1).
    await this.repository.revokeSession(loaded.session.id, "LOGOUT", {
      actorUserId: loaded.session.userId,
      actorRole: user?.role ?? null,
      action: "auth.logout",
      entityType: "Session",
      entityId: loaded.session.id,
      requestId: context.requestId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
  }

  /**
   * Precomputes the dummy Argon2id hash used for logins with an unknown email. Called once
   * while the app starts (buildApp), so the first such login costs the same as every later
   * one instead of also paying for the hash (~20 ms) that would otherwise reveal it.
   */
  async warmUp(): Promise<void> {
    await dummyPasswordHash();
  }

  verifyCsrf(session: SessionRecord, rawCsrfToken: string | undefined): boolean {
    if (!rawCsrfToken) return false;
    return csrfTokenMatchesSession(session, rawCsrfToken);
  }

  async rotateCsrfToken(sessionId: string, csrfTokenHash: string): Promise<void> {
    await this.repository.rotateSessionCsrf(sessionId, csrfTokenHash);
  }

  private async findUserById(userId: string): Promise<UserRecord | null> {
    return this.repository.findUserById(userId);
  }
}
