import { randomUUID } from "node:crypto";
import { FakeOutboxRepository } from "../notifications/outbox.repository.fake.js";
import { DuplicateEmailError } from "./auth.types.js";
import type {
  AuditLogEntry,
  AuthRepository,
  CreateSessionInput,
  CreateUserInput,
  EmailVerificationResendScope,
  LoginAttemptScope,
  PasswordResetRequestScope,
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
  private readonly resendLocks = new Map<string, Promise<void>>();
  private readonly resetRequestLocks = new Map<string, Promise<void>>();
  /** Test hook: stands in for PostgreSQL's clock (audit times, login-limit window). */
  clock: () => Date = () => new Date();
  /**
   * The email outbox and verification tokens, in memory, sharing this repository's users and
   * clock (in PostgreSQL they are tables of the same database).
   */
  readonly outbox = new FakeOutboxRepository();

  constructor() {
    this.outbox.clock = () => this.clock();
    this.outbox.userEmailLookup = (userId) => this.users.get(userId)?.email ?? null;
  }

  async createUserWithEmailVerification(input: CreateUserInput): Promise<UserRecord> {
    const user = await this.createUser(input);
    this.outbox.enqueue("EMAIL_VERIFICATION", user.id);
    return user;
  }

  /** Mirrors the Prisma transaction: the audit event is recorded first, so a failure changes nothing. */
  async consumeEmailVerificationToken(
    tokenHash: string,
    audit?: (user: UserRecord) => AuditLogEntry,
  ): Promise<string | null> {
    const now = this.clock();
    const token = this.outbox.emailVerificationTokens.find(
      (t) =>
        t.tokenHash === tokenHash && t.usedAt === null && now.getTime() < t.expiresAt.getTime(),
    );
    if (!token) return null;
    const user = this.users.get(token.userId);
    if (audit && user) this.recordAudit(audit(user));
    token.usedAt = now;
    if (user && user.emailVerifiedAt === null) user.emailVerifiedAt = now;
    return token.userId;
  }

  /** Mirrors the Prisma version: serialized per user, and the enqueue applies only on success. */
  async runEmailVerificationResend<T>(
    userId: string,
    windowMs: number,
    attempt: (scope: EmailVerificationResendScope) => Promise<T>,
  ): Promise<T> {
    const previous = this.resendLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const held = previous.then(() => new Promise<void>((resolve) => (release = resolve)));
    this.resendLocks.set(userId, held);
    await previous;
    try {
      const now = this.clock();
      const recent = this.outbox.entries.filter(
        (e) =>
          e.userId === userId &&
          e.kind === "EMAIL_VERIFICATION" &&
          e.createdAt.getTime() > now.getTime() - windowMs,
      );
      let enqueues = 0;
      const result = await attempt({
        recentEmails: recent.length,
        lastEmailAt: recent.length
          ? new Date(Math.max(...recent.map((e) => e.createdAt.getTime())))
          : null,
        now,
        enqueueVerificationEmail: async () => {
          enqueues += 1;
        },
      });
      for (let i = 0; i < enqueues; i++) this.outbox.enqueue("EMAIL_VERIFICATION", userId);
      return result;
    } finally {
      release();
      if (this.resendLocks.get(userId) === held) this.resendLocks.delete(userId);
    }
  }

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

  /** Mirrors the Prisma version: serialized per email hash; writes apply only on success. */
  async runPasswordResetRequest<T>(
    emailHash: string,
    windowMs: number,
    attempt: (scope: PasswordResetRequestScope) => Promise<T>,
  ): Promise<T> {
    const previous = this.resetRequestLocks.get(emailHash) ?? Promise.resolve();
    let release!: () => void;
    const held = previous.then(() => new Promise<void>((resolve) => (release = resolve)));
    this.resetRequestLocks.set(emailHash, held);
    await previous;
    try {
      const now = this.clock();
      const requestTimes = this.auditOccurredAt.filter(
        (occurredAt, i) =>
          this.auditLog[i]!.action === "auth.password.reset_requested" &&
          this.auditLog[i]!.metadata?.emailHash === emailHash &&
          occurredAt.getTime() > now.getTime() - windowMs,
      );
      const pendingAudit: AuditLogEntry[] = [];
      const pendingEmails: string[] = [];
      const result = await attempt({
        recentRequests: requestTimes.length,
        lastRequestAt: requestTimes.length
          ? new Date(Math.max(...requestTimes.map((t) => t.getTime())))
          : null,
        now,
        findUserByEmail: (email) => this.findUserByEmail(email),
        writeAuditLog: async (entry) => {
          pendingAudit.push(entry);
        },
        enqueuePasswordResetEmail: async (userId) => {
          pendingEmails.push(userId);
        },
      });
      for (const entry of pendingAudit) {
        this.auditLog.push(entry);
        this.auditOccurredAt.push(now);
      }
      for (const userId of pendingEmails) this.outbox.enqueue("PASSWORD_RESET", userId);
      return result;
    } finally {
      release();
      if (this.resetRequestLocks.get(emailHash) === held) this.resetRequestLocks.delete(emailHash);
    }
  }

  async resetPassword(input: {
    tokenHash: string;
    passwordHash: string;
    audit: (user: UserRecord) => AuditLogEntry;
  }): Promise<UserRecord | null> {
    const now = this.clock();
    const token = this.outbox.passwordResetTokens.find(
      (t) =>
        t.tokenHash === input.tokenHash &&
        t.usedAt === null &&
        now.getTime() < t.expiresAt.getTime(),
    );
    if (!token) return null;
    const user = this.users.get(token.userId);
    if (!user) return null;
    for (const other of this.outbox.passwordResetTokens) {
      if (other.userId === user.id && other.usedAt === null) other.usedAt = now;
    }
    user.passwordHash = input.passwordHash;
    await this.revokeAllOwnSessions(user.id, "PASSWORD_RESET");
    this.outbox.enqueue("PASSWORD_RESET_COMPLETED", user.id);
    this.auditLog.push(input.audit(user));
    this.auditOccurredAt.push(now);
    return user;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const session: SessionRecord = {
      id: randomUUID(),
      userId: input.userId,
      tokenHash: input.tokenHash,
      csrfTokenHash: input.csrfTokenHash,
      createdAt: input.createdAt ?? this.clock(),
      lastSeenAt: input.lastSeenAt,
      idleExpiresAt: input.idleExpiresAt,
      absoluteExpiresAt: input.absoluteExpiresAt,
      revokedAt: null,
      revokedReason: null,
      rotatedAt: null,
      ip: input.ip,
      userAgent: input.userAgent,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async listActiveSessions(userId: string, now: Date): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter(
        (session) =>
          session.userId === userId &&
          session.revokedAt === null &&
          session.rotatedAt === null &&
          now.getTime() < session.idleExpiresAt.getTime() &&
          now.getTime() < session.absoluteExpiresAt.getTime(),
      )
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime() || a.id.localeCompare(b.id));
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

  /**
   * Mirrors the Prisma version's transaction: the audit event is recorded first, and the
   * revocation is applied only if that succeeded, so a failure leaves nothing behind.
   */
  async revokeSession(
    id: string,
    reason: SessionRevokedReason,
    audit?: AuditLogEntry,
  ): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session || session.revokedAt) return false;
    if (audit) this.recordAudit(audit);
    session.revokedAt = new Date();
    session.revokedReason = reason;
    return true;
  }

  async revokeOwnSession(
    sessionId: string,
    userId: string,
    now: Date,
    reason: SessionRevokedReason,
    audit?: AuditLogEntry,
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (
      !session ||
      session.userId !== userId ||
      session.revokedAt !== null ||
      now.getTime() >= session.idleExpiresAt.getTime() ||
      now.getTime() >= session.absoluteExpiresAt.getTime()
    ) {
      return false;
    }
    if (audit) this.recordAudit(audit);
    session.revokedAt = new Date();
    session.revokedReason = reason;
    return true;
  }

  async rotateSession(input: {
    previousSessionId: string;
    userId: string;
    now: Date;
    graceMs: number;
    newSession: CreateSessionInput;
  }): Promise<SessionRecord | null> {
    const previous = this.sessions.get(input.previousSessionId);
    if (
      !previous ||
      previous.userId !== input.userId ||
      previous.revokedAt !== null ||
      previous.rotatedAt !== null
    ) {
      return null;
    }
    previous.rotatedAt = input.now;
    for (const session of this.sessions.values()) {
      if (
        session.userId === input.userId &&
        session.revokedAt === null &&
        session.rotatedAt !== null &&
        session.rotatedAt.getTime() <= input.now.getTime() - input.graceMs
      ) {
        session.revokedAt = input.now;
        session.revokedReason = "ROTATED";
      }
    }
    return this.createSession(input.newSession);
  }

  async revokeAllOwnSessions(
    userId: string,
    reason: SessionRevokedReason,
    audit?: AuditLogEntry,
  ): Promise<number> {
    const targets = [...this.sessions.values()].filter(
      (session) => session.userId === userId && session.revokedAt === null,
    );
    if (targets.length > 0 && audit) this.recordAudit(audit);
    for (const session of targets) {
      session.revokedAt = new Date();
      session.revokedReason = reason;
    }
    return targets.length;
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
      const failureTimes = this.auditOccurredAt.filter(
        (occurredAt, i) =>
          this.auditLog[i]!.action === "auth.login.failed" &&
          this.auditLog[i]!.metadata?.emailHash === emailHash &&
          occurredAt.getTime() > now.getTime() - windowMs,
      );
      const pending: AuditLogEntry[] = [];
      const result = await attempt({
        recentFailures: failureTimes.length,
        lastFailureAt: failureTimes.length
          ? new Date(Math.max(...failureTimes.map((t) => t.getTime())))
          : null,
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
    this.recordAudit(entry);
  }

  /** Where every audit event is recorded; tests override it to make the audit write fail. */
  protected recordAudit(entry: AuditLogEntry): void {
    this.auditLog.push(entry);
    this.auditOccurredAt.push(this.clock());
  }
}
