import { HttpError } from "../../common/http-error.js";
import type { Actor } from "../../common/policy.js";
import { dummyPasswordHash, hashPassword, verifyPassword } from "../../security/password.js";
import { sha256Hex } from "../../security/crypto.js";
import { toPublicUser } from "./auth.mapper.js";
import { can } from "./auth.policy.js";
import { createSessionForUser, csrfTokenMatchesSession, loadValidSession } from "./auth.session.js";
import type { Clock } from "./auth.session.js";
import { DuplicateEmailError } from "./auth.types.js";
import type { AuthRepository, SessionRecord, UserRecord } from "./auth.types.js";
import type { User } from "@legaltech/contracts";

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
  /** Failed-login attempts allowed per account within the window, before throttling (ADR-002). */
  accountLoginAttemptLimit?: number;
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
    this.accountLoginWindowMs = options.accountLoginWindowMs ?? 15 * 60 * 1000;
  }

  /**
   * Creates a user with role USER. Always succeeds from the caller's point of view, even
   * when the email is already registered: this avoids account enumeration through the
   * registration endpoint (API_SPEC.md). Email verification is designed but not implemented
   * yet (API_SPEC.md, "Diseñados, no implementados"); no verification token is issued.
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
      user = await this.repository.createUser({
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
  ): Promise<LoginResult> {
    const email = normalizeEmail(input.email);
    const emailHash = sha256Hex(email);
    const since = new Date(this.clock().getTime() - this.accountLoginWindowMs);

    const recentFailures = await this.repository.countRecentFailedLogins(emailHash, since);
    if (recentFailures >= this.accountLoginAttemptLimit) {
      throw new HttpError(429, "RATE_LIMITED", "Demasiados intentos. Inténtalo más tarde.", {
        headers: { "Retry-After": String(Math.ceil(this.accountLoginWindowMs / 1000)) },
      });
    }

    const user = await this.repository.findUserByEmail(email);
    // Always run exactly one Argon2id verification, against a dummy hash when there is no
    // such user, so an unknown email is not answered measurably faster than a wrong password.
    const passwordOk = await verifyPassword(
      user?.passwordHash ?? (await dummyPasswordHash()),
      input.password,
    );

    if (!user || !passwordOk || user.status !== "ACTIVE") {
      await this.recordLoginFailure(user, emailHash, context);
      throw new HttpError(401, "INVALID_CREDENTIALS", "Credenciales inválidas.");
    }

    if (this.isProduction && (user.role === "ADMIN" || user.role === "SUPER_ADMIN")) {
      // ADR-002: fail closed. MFA is not implemented yet (out of scope for this Sprint), so
      // no ADMIN/SUPER_ADMIN session can be created in production until it is.
      await this.recordLoginFailure(user, emailHash, context, "mfa_required_production");
      throw new HttpError(
        403,
        "FORBIDDEN",
        "El inicio de sesión para este rol requiere autenticación multifactor, aún no disponible.",
      );
    }

    const { sessionRaw, csrfRaw } = await createSessionForUser(
      this.repository,
      user,
      { ip: context.ip, userAgent: context.userAgent },
      this.clock,
    );

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

  private async recordLoginFailure(
    user: UserRecord | null,
    emailHash: string,
    context: RequestContext,
    reason?: string,
  ): Promise<void> {
    await this.repository.writeAuditLog({
      actorUserId: user?.id ?? null,
      actorRole: user?.role ?? null,
      action: "auth.login.failed",
      entityType: user ? "User" : null,
      entityId: user?.id ?? null,
      metadata: { emailHash, ...(reason ? { reason } : {}) },
      requestId: context.requestId,
      ip: context.ip,
      userAgent: context.userAgent,
    });
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
   * Always succeeds from the caller's point of view, even for a missing, already-revoked
   * or expired session (API_SPEC.md, `POST /api/auth/logout`: 204 also when the session is
   * no longer valid).
   */
  async logout(sessionRawToken: string | undefined, context: RequestContext): Promise<void> {
    const loaded = await loadValidSession(this.repository, sessionRawToken, this.clock);
    if (!loaded) return;

    await this.repository.revokeSession(loaded.session.id, "LOGOUT");

    const user = await this.findUserById(loaded.session.userId);
    await this.repository.writeAuditLog({
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
