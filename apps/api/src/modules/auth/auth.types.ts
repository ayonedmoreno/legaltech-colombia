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

export interface CreateSessionInput {
  userId: string;
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
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  touchSession(id: string, patch: TouchSessionInput): Promise<void>;
  rotateSessionCsrf(id: string, csrfTokenHash: string): Promise<void>;
  revokeSession(id: string, reason: SessionRevokedReason): Promise<void>;
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
