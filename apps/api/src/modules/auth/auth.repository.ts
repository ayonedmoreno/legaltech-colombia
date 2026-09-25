import type { Prisma, PrismaClient } from "@legaltech/database";
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

/** Prisma-backed implementation of AuthRepository. Only this file imports @prisma/client types for auth. */
export class PrismaAuthRepository implements AuthRepository {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async findUserById(id: string): Promise<UserRecord | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    return this.prisma.user.create({ data: input });
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    return this.prisma.session.create({ data: input });
  }

  async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    return this.prisma.session.findUnique({ where: { tokenHash } });
  }

  async touchSession(id: string, patch: TouchSessionInput): Promise<void> {
    await this.prisma.session.update({ where: { id }, data: patch });
  }

  async rotateSessionCsrf(id: string, csrfTokenHash: string): Promise<void> {
    await this.prisma.session.update({ where: { id }, data: { csrfTokenHash } });
  }

  async revokeSession(id: string, reason: SessionRevokedReason): Promise<void> {
    // Only ever revoke a session that is not already revoked: revocation is a one-way
    // transition and the reason for the first revocation must not be overwritten.
    await this.prisma.session.updateMany({
      where: { id, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  async countRecentFailedLogins(emailHash: string, since: Date): Promise<number> {
    return this.prisma.auditLog.count({
      where: {
        action: "auth.login.failed",
        occurredAt: { gt: since },
        metadata: { path: ["emailHash"], equals: emailHash },
      },
    });
  }

  async writeAuditLog(entry: AuditLogEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorUserId: entry.actorUserId,
        actorRole: entry.actorRole,
        action: entry.action,
        entityType: entry.entityType ?? undefined,
        entityId: entry.entityId ?? undefined,
        metadata: (entry.metadata as Prisma.InputJsonObject | undefined) ?? undefined,
        requestId: entry.requestId,
        ip: entry.ip,
        userAgent: entry.userAgent,
      },
    });
  }
}
