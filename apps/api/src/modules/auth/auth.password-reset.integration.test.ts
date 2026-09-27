import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient } from "@legaltech/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "../../security/crypto.js";
import { createEmailComposers } from "../notifications/composers.js";
import { dispatchPendingEmails } from "../notifications/dispatch.js";
import type { EmailComposer } from "../notifications/notifications.types.js";
import { PrismaOutboxRepository } from "../notifications/outbox.repository.js";
import { MemoryEmailTransport } from "../notifications/transports.js";
import { PrismaAuthRepository } from "./auth.repository.js";
import type { AuditLogEntry, UserRecord } from "./auth.types.js";

/**
 * Password recovery against real PostgreSQL, as the application role (Sprint 1B, D5b-2).
 * Opt-in: runs only with INTEGRATION_DATABASE_URL.
 */
const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const MINUTE_MS = 60 * 1000;

describe.skipIf(!databaseUrl)("password recovery (PostgreSQL integration)", () => {
  let prisma: PrismaClient;
  let repository: PrismaAuthRepository;
  let outbox: PrismaOutboxRepository;

  beforeAll(() => {
    prisma = createPrismaClient(databaseUrl!);
    repository = new PrismaAuthRepository(prisma);
    outbox = new PrismaOutboxRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const newUser = () =>
    prisma.user.create({
      data: {
        email: `reset-${randomUUID()}@example.com`,
        passwordHash: "$argon2id$old-password-placeholder",
        fullName: "Integración",
      },
    });

  const session = (userId: string) =>
    prisma.session.create({
      data: {
        userId,
        tokenHash: sha256Hex(randomUUID()),
        csrfTokenHash: sha256Hex(randomUUID()),
        lastSeenAt: new Date(),
        idleExpiresAt: new Date(Date.now() + 60 * MINUTE_MS),
        absoluteExpiresAt: new Date(Date.now() + 120 * MINUTE_MS),
      },
    });

  const audit = (user: UserRecord): AuditLogEntry => ({
    actorUserId: user.id,
    actorRole: user.role,
    action: "auth.password.reset_completed",
    entityType: "User",
    entityId: user.id,
    requestId: randomUUID(),
    ip: "203.0.113.7",
    userAgent: "integration-test",
  });

  async function storedToken(userId: string, expiresAt = new Date(Date.now() + 30 * MINUTE_MS)) {
    const hash = sha256Hex(randomUUID());
    await prisma.passwordResetToken.create({ data: { userId, tokenHash: hash, expiresAt } });
    return hash;
  }

  it("resets in one transaction: password, tokens, sessions, notice and audit", async () => {
    const user = await newUser();
    const other = await newUser();
    await session(user.id);
    await session(user.id);
    const otherSession = await session(other.id);
    const hash = await storedToken(user.id);
    const outstanding = await storedToken(user.id);

    const result = await repository.resetPassword({
      tokenHash: hash,
      passwordHash: "$argon2id$new-password-placeholder",
      audit,
    });

    expect(result?.id).toBe(user.id);
    expect((await prisma.user.findUnique({ where: { id: user.id } }))?.passwordHash).toBe(
      "$argon2id$new-password-placeholder",
    );
    const sessions = await prisma.session.findMany({ where: { userId: user.id } });
    expect(sessions.map((s) => s.revokedReason)).toEqual(["PASSWORD_RESET", "PASSWORD_RESET"]);
    expect(
      (await prisma.session.findUnique({ where: { id: otherSession.id } }))?.revokedAt,
    ).toBeNull();
    const tokens = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(tokens.every((t) => t.usedAt !== null)).toBe(true); // both, `outstanding` included
    expect(tokens.map((t) => t.tokenHash).sort()).toEqual([hash, outstanding].sort());
    expect(
      await prisma.emailOutbox.findMany({ where: { userId: user.id }, select: { kind: true } }),
    ).toEqual([{ kind: "PASSWORD_RESET_COMPLETED" }]);
    expect(
      await prisma.auditLog.count({
        where: { action: "auth.password.reset_completed", actorUserId: user.id },
      }),
    ).toBe(1);

    // Used: a second reset with the same token changes nothing.
    expect(
      await repository.resetPassword({ tokenHash: hash, passwordHash: "$argon2id$x", audit }),
    ).toBeNull();
    expect((await prisma.user.findUnique({ where: { id: user.id } }))?.passwordHash).toBe(
      "$argon2id$new-password-placeholder",
    );
  });

  it("rejects an expired token on PostgreSQL time, changing nothing", async () => {
    const user = await newUser();
    const [row] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const hash = await storedToken(user.id, new Date(row!.now.getTime() - 1_000));

    expect(
      await repository.resetPassword({ tokenHash: hash, passwordHash: "$argon2id$x", audit }),
    ).toBeNull();
    expect((await prisma.user.findUnique({ where: { id: user.id } }))?.passwordHash).toBe(
      "$argon2id$old-password-placeholder",
    );
    expect(await prisma.emailOutbox.count({ where: { userId: user.id } })).toBe(0);
  });

  it("lets only one of two concurrent resets use the same token", async () => {
    const user = await newUser();
    const hash = await storedToken(user.id);

    const results = await Promise.all([
      repository.resetPassword({ tokenHash: hash, passwordHash: "$argon2id$a", audit }),
      repository.resetPassword({ tokenHash: hash, passwordHash: "$argon2id$b", audit }),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(
      await prisma.emailOutbox.count({
        where: { userId: user.id, kind: "PASSWORD_RESET_COMPLETED" },
      }),
    ).toBe(1);
  });

  it("dispatches the reset email storing only the token hash, the newer replacing the older", async () => {
    const user = await newUser();
    await prisma.emailOutbox.create({ data: { kind: "PASSWORD_RESET", userId: user.id } });
    await prisma.emailOutbox.create({ data: { kind: "PASSWORD_RESET", userId: user.id } });
    const real = createEmailComposers({
      appOrigin: "http://localhost:3000",
      emailVerificationTokenTtlMs: 24 * 60 * MINUTE_MS,
      passwordResetTokenTtlMs: 30 * MINUTE_MS,
    });
    const onlyThisUser: EmailComposer = async (entry, scope) => {
      if (entry.userId !== user.id) throw new Error("not this test's entry");
      return real.PASSWORD_RESET!(entry, scope);
    };
    const transport = new MemoryEmailTransport();

    await dispatchPendingEmails(
      outbox,
      transport,
      { PASSWORD_RESET: onlyThisUser },
      {
        limit: 1_000,
      },
    );

    const raw = transport.sent.map((m) => /#token=([A-Za-z0-9_-]+)/.exec(m.text)![1]!);
    expect(raw).toHaveLength(2);
    const tokens = await prisma.passwordResetToken.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    expect(tokens.map((t) => t.tokenHash)).toEqual(raw.map((r) => sha256Hex(r)));
    expect(tokens[0]!.usedAt).toBeInstanceOf(Date); // replaced by the newer one (P7)
    expect(tokens[1]!.usedAt).toBeNull();
  });

  it("serializes reset requests per email hash, so a limit on recent requests holds", async () => {
    const emailHash = sha256Hex(`nobody-${randomUUID()}@example.com`);
    const allowed = 3;

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () =>
        repository.runPasswordResetRequest(emailHash, 24 * 60 * MINUTE_MS, async (scope) => {
          if (scope.recentRequests >= allowed) return "throttled";
          // Widen the window between reading the count and writing (see the resend test).
          await new Promise((resolve) => setTimeout(resolve, 150));
          await scope.writeAuditLog({
            actorUserId: null,
            actorRole: null,
            action: "auth.password.reset_requested",
            metadata: { emailHash },
            requestId: randomUUID(),
            ip: "203.0.113.7",
            userAgent: "integration-test",
          });
          return "requested";
        }),
      ),
    );

    expect(outcomes.filter((o) => o === "requested")).toHaveLength(allowed);
    expect(
      await prisma.auditLog.count({
        where: {
          action: "auth.password.reset_requested",
          metadata: { path: ["emailHash"], equals: emailHash },
        },
      }),
    ).toBe(allowed);
  }, 20_000);
});
