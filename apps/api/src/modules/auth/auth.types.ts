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
 * (full Prisma-backed integration tests, with testcontainers, are a follow-up — see
 * the Sprint 1B report).
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
  countRecentFailedLogins(emailHash: string, since: Date): Promise<number>;
  writeAuditLog(entry: AuditLogEntry): Promise<void>;
}
