import { randomUUID } from "node:crypto";
import { DuplicateEmailError } from "./auth.types.js";
import type {
  AuditLogEntry,
  AuthRepository,
  CreateSessionInput,
  CreateUserInput,
  LoginAttemptScope,
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
  private readonly loginLocks = new Map<string, Promise<void>>();
  /** Test hook: stands in for PostgreSQL's clock (audit times, login-limit window). */
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

  /**
   * Mirrors PrismaAuthRepository.runLoginAttempt: attempts for the same email hash run one at a
   * time, in arrival order (the advisory lock); "now" comes from `clock` (PostgreSQL time); and
   * the attempt's audit writes are applied only if it completes (the transaction commits).
   */
  async runLoginAttempt<T>(
    emailHash: string,
    windowMs: number,
    attempt: (scope: LoginAttemptScope) => Promise<T>,
  ): Promise<T> {
    const previous = this.loginLocks.get(emailHash) ?? Promise.resolve();
    let release!: () => void;
    const held = previous.then(() => new Promise<void>((resolve) => (release = resolve)));
    this.loginLocks.set(emailHash, held);
    await previous;
    try {
      const now = this.clock();
      const recentFailures = this.auditLog.filter(
        (e, i) =>
          e.action === "auth.login.failed" &&
          e.metadata?.emailHash === emailHash &&
          this.auditOccurredAt[i]!.getTime() > now.getTime() - windowMs,
      ).length;
      const pending: AuditLogEntry[] = [];
      const result = await attempt({
        recentFailures,
        now,
        findUserByEmail: (email) => this.findUserByEmail(email),
        writeAuditLog: async (entry) => {
          pending.push(entry);
        },
      });
      for (const entry of pending) {
        this.auditLog.push(entry);
        this.auditOccurredAt.push(now);
      }
      return result;
    } finally {
      release();
      if (this.loginLocks.get(emailHash) === held) this.loginLocks.delete(emailHash);
    }
  }

  async writeAuditLog(entry: AuditLogEntry): Promise<void> {
    this.auditLog.push(entry);
    this.auditOccurredAt.push(this.clock());
  }
}
