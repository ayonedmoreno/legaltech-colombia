import { randomUUID } from "node:crypto";
import { DuplicateEmailError } from "./auth.types.js";
import type {
  AuditLogEntry,
  AuthRepository,
  CreateSessionInput,
  CreateUserInput,
  SessionRecord,
  TouchSessionInput,
  UserRecord,
} from "./auth.types.js";
import type { SessionRevokedReason } from "@legaltech/database";

/**
 * In-memory AuthRepository used by tests. Mirrors the constraints of the real schema
 * closely enough to exercise auth.service (unique email, one-way revocation) without a
 * database. Not a substitute for integration tests against real PostgreSQL.
 */
export class FakeAuthRepository implements AuthRepository {
  readonly users = new Map<string, UserRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  readonly auditLog: AuditLogEntry[] = [];
  private readonly auditOccurredAt: Date[] = [];
  /** Test hook: overrides "now" for countRecentFailedLogins. Defaults to the real clock. */
  clock: () => Date = () => new Date();

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    for (const user of this.users.values()) {
      if (user.email === email) return user;
    }
    return null;
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    // Checked synchronously, with no await between check and insert, so it is atomic like
    // the real unique index; throws what PrismaAuthRepository maps a P2002 to.
    if ([...this.users.values()].some((user) => user.email === input.email)) {
      throw new DuplicateEmailError();
    }
    const user: UserRecord = {
      id: randomUUID(),
      email: input.email,
      passwordHash: input.passwordHash,
      fullName: input.fullName,
      role: "USER",
      status: "ACTIVE",
      emailVerifiedAt: null,
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    return user;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const session: SessionRecord = {
      id: randomUUID(),
      userId: input.userId,
      tokenHash: input.tokenHash,
      csrfTokenHash: input.csrfTokenHash,
      createdAt: new Date(),
      lastSeenAt: input.lastSeenAt,
      idleExpiresAt: input.idleExpiresAt,
      absoluteExpiresAt: input.absoluteExpiresAt,
      revokedAt: null,
      revokedReason: null,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    for (const session of this.sessions.values()) {
      if (session.tokenHash === tokenHash) return session;
    }
    return null;
  }

  async touchSession(id: string, patch: TouchSessionInput): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.lastSeenAt = patch.lastSeenAt;
    session.idleExpiresAt = patch.idleExpiresAt;
  }

  async rotateSessionCsrf(id: string, csrfTokenHash: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.csrfTokenHash = csrfTokenHash;
  }

  async revokeSession(id: string, reason: SessionRevokedReason): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || session.revokedAt) return;
    session.revokedAt = new Date();
    session.revokedReason = reason;
  }

  async countRecentFailedLogins(emailHash: string, since: Date): Promise<number> {
    return this.auditLog.filter(
      (e, i) =>
        e.action === "auth.login.failed" &&
        e.metadata?.emailHash === emailHash &&
        this.auditOccurredAt[i]!.getTime() > since.getTime(),
    ).length;
  }

  async writeAuditLog(entry: AuditLogEntry): Promise<void> {
    this.auditLog.push(entry);
    this.auditOccurredAt.push(this.clock());
  }
}
