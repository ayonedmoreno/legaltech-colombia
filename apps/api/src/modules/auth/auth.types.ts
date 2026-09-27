import type { Role, SessionRevokedReason, UserStatus } from "@legaltech/database";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string;
  role: Role;
  status: UserStatus;
  emailVerifiedAt: Date | null;
  createdAt: Date;
}

export interface SessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  csrfTokenHash: string;
  createdAt: Date;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
  revokedReason: SessionRevokedReason | null;
  /** When the session was rotated (ADR-002): it stays valid only for the grace period after. */
  rotatedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Thrown by AuthRepository.createUser when the email is already taken at insert time — a
 * concurrent registration won the race after this one's existence check. Keeps Prisma
 * error codes out of the service.
 */
export class DuplicateEmailError extends Error {
  constructor() {
    super("A user with this email already exists.");
    this.name = "DuplicateEmailError";
  }
}

/**
 * Thrown by AuthRepository.runLoginAttempt when a login attempt cannot be evaluated safely
 * (ADR-002, D3): the per-account lock was not obtained within its lock timeout, no pooled
 * connection was available, or the transaction could not start or expired. The login must not
 * be granted. Any other database error is not mapped to this and keeps its own behaviour.
 */
export class LoginAttemptUnavailableError extends Error {
  constructor() {
    super("The login attempt could not be evaluated.");
    this.name = "LoginAttemptUnavailableError";
  }
}

/**
 * What a login attempt sees while it holds the per-account lock, inside one transaction
 * (ADR-002, D3). Everything it writes through `writeAuditLog` commits together with the check,
 * or not at all.
 */
export interface LoginAttemptScope {
  /** `auth.login.failed` events for this email hash within the window, counted on PostgreSQL time. */
  recentFailures: number;
  /** When the most recent of those failures happened (PostgreSQL time); null if there is none. */
  lastFailureAt: Date | null;
  /** PostgreSQL `clock_timestamp()`, read after the lock was obtained. */
  now: Date;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  /** Writes an audit event in the attempt's transaction, dated `now`. */
  writeAuditLog(entry: AuditLogEntry): Promise<void>;
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  fullName: string;
}

/** What a verification-email resend sees while it holds the per-user lock, in one transaction. */
export interface EmailVerificationResendScope {
  /** Verification emails recorded for the user within the window (PostgreSQL time). */
  recentEmails: number;
  /** When the latest of them was recorded; null if there is none. */
  lastEmailAt: Date | null;
  /** PostgreSQL time, read after the lock was obtained. */
  now: Date;
  /** Records the intent to send one more verification email, in this transaction. */
  enqueueVerificationEmail(): Promise<void>;
}

/** What a password reset request sees while it holds the per-email lock, in one transaction. */
export interface PasswordResetRequestScope {
  /** `auth.password.reset_requested` events for this email hash within the window. */
  recentRequests: number;
  /** When the latest of them happened; null if there is none. */
  lastRequestAt: Date | null;
  /** PostgreSQL time, read after the lock was obtained. */
  now: Date;
  findUserByEmail(email: string): Promise<UserRecord | null>;
  /** Writes an audit event in this transaction, dated `now`. */
  writeAuditLog(entry: AuditLogEntry): Promise<void>;
  /** Records the intent to send a password reset email to the user, in this transaction. */
  enqueuePasswordResetEmail(userId: string): Promise<void>;
}

export interface CreateSessionInput {
  userId: string;
  /** Creation time on the API clock; the database default is used when omitted. */
  createdAt?: Date;
  tokenHash: string;
  csrfTokenHash: string;
  lastSeenAt: Date;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  ip: string | null;
  userAgent: string | null;
}

export interface TouchSessionInput {
  lastSeenAt: Date;
  idleExpiresAt: Date;
}

export interface AuditLogEntry {
  actorUserId: string | null;
  actorRole: Role | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Persistence boundary for the auth module. A Prisma-backed implementation
 * (auth.repository.ts) is used at runtime; an in-memory fake (auth.repository.fake.ts)
 * is used in tests, so the test suite does not need a real PostgreSQL instance
 * (the Prisma implementation is also tested against real PostgreSQL in
 * auth.repository.integration.test.ts, which CI runs after the migrations).
 */
export interface AuthRepository {
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  createUser(input: CreateUserInput): Promise<UserRecord>;
  /**
   * Creates a USER and records the intent to send the initial verification email in the same
   * transaction (Sprint 1B decision P6; outbox pattern): both or neither. Throws
   * DuplicateEmailError like `createUser`.
   */
  createUserWithEmailVerification(input: CreateUserInput): Promise<UserRecord>;
  /**
   * Consumes an email verification token atomically: it must exist, be unused and not be expired
   * (PostgreSQL time); it is marked used and the user's email verified, in one transaction.
   * Returns the user's id, or null when the token cannot be used, whatever the reason. With
   * `audit`, its event is written in the same transaction (with the PostgreSQL time of the use):
   * all of it is kept, or none.
   */
  consumeEmailVerificationToken(
    tokenHash: string,
    audit?: (user: UserRecord) => AuditLogEntry,
  ): Promise<string | null>;
  /**
   * Runs one resend of the verification email for a user, serialized per user (like the login
   * attempt, ADR-002 D3), so concurrent resends cannot both pass the per-account limit.
   */
  runEmailVerificationResend<T>(
    userId: string,
    windowMs: number,
    attempt: (scope: EmailVerificationResendScope) => Promise<T>,
  ): Promise<T>;
  /**
   * Runs one password reset request for an email hash, serialized per hash and in one
   * transaction, like the login attempt (ADR-002, D3): the per-email limit is counted from
   * `auth.password.reset_requested` events, so it applies to unknown addresses too. Throws
   * LoginAttemptUnavailableError when the request cannot be evaluated.
   */
  runPasswordResetRequest<T>(
    emailHash: string,
    windowMs: number,
    attempt: (scope: PasswordResetRequestScope) => Promise<T>,
  ): Promise<T>;
  /**
   * Resets a password with a reset token, in one transaction (ADR-002): the token must exist, be
   * unused and not be expired (PostgreSQL time); it and the user's other unused reset tokens are
   * marked used; the password hash is replaced; every session of the user is revoked with
   * `PASSWORD_RESET`; the notice email is recorded in the outbox; and the audit event built by
   * `audit` is written. Returns the user, or null when the token cannot be used (nothing done).
   */
  resetPassword(input: {
    tokenHash: string;
    passwordHash: string;
    audit: (user: UserRecord) => AuditLogEntry;
  }): Promise<UserRecord | null>;
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  /**
   * The user's currently valid sessions (DATABASE_SPEC.md: not revoked, and `now` before both
   * the idle and the absolute expiry), most recently used first. Always scoped to one user
   * (ADR-003): there is no way to list sessions without saying whose.
   */
  listActiveSessions(userId: string, now: Date): Promise<SessionRecord[]>;
  touchSession(id: string, patch: TouchSessionInput): Promise<void>;
  rotateSessionCsrf(id: string, csrfTokenHash: string): Promise<void>;
  /**
   * Revokes a session that is not revoked yet (revocation is one-way: the first reason and time
   * are kept). With `audit`, the event is written in the same transaction, and only if this call
   * revoked the session: both are kept, or neither, and a repeated revocation writes no second
   * event. Returns whether this call revoked it.
   */
  revokeSession(id: string, reason: SessionRevokedReason, audit?: AuditLogEntry): Promise<boolean>;
  /**
   * Revokes one of the user's own currently valid sessions (DATABASE_SPEC.md validity, as in
   * `listActiveSessions`). Scoped to the user (ADR-003): another user's session, an unknown id,
   * or a session already revoked or expired is left untouched and reported as `false`, so the
   * caller answers them all alike. With `audit`, as for `revokeSession`.
   */
  revokeOwnSession(
    sessionId: string,
    userId: string,
    now: Date,
    reason: SessionRevokedReason,
    audit?: AuditLogEntry,
  ): Promise<boolean>;
  /**
   * Revokes every session of the user that is not revoked yet, in one conditional statement,
   * and returns how many it revoked. Scoped to the user (ADR-003); sessions already revoked keep
   * their first reason and time (revocation is one-way). With `audit`, the event is written in the
   * same transaction, and only if at least one session was revoked (as for `revokeSession`).
   */
  revokeAllOwnSessions(
    userId: string,
    reason: SessionRevokedReason,
    audit?: AuditLogEntry,
  ): Promise<number>;
  /**
   * Rotates a session (ADR-002), in one transaction: the previous session is marked rotated at
   * `now` only if it belongs to the user and is neither revoked nor already rotated — so two
   * concurrent rotations of it cannot both happen —, the user's sessions whose grace period has
   * ended are revoked with `ROTATED`, and the new session is created. Returns the new session, or
   * null when the previous one could not be claimed (nothing changed).
   */
  rotateSession(input: {
    previousSessionId: string;
    userId: string;
    now: Date;
    graceMs: number;
    newSession: CreateSessionInput;
  }): Promise<SessionRecord | null>;
  /**
   * Runs one login attempt atomically for an email hash (ADR-002, D3): concurrent attempts for
   * the same hash are serialized, so no two of them can both pass the per-account limit. Throws
   * LoginAttemptUnavailableError when the attempt cannot be evaluated; the attempt's own errors
   * roll it back and propagate unchanged.
   */
  runLoginAttempt<T>(
    emailHash: string,
    windowMs: number,
    attempt: (scope: LoginAttemptScope) => Promise<T>,
  ): Promise<T>;
  writeAuditLog(entry: AuditLogEntry): Promise<void>;
}
