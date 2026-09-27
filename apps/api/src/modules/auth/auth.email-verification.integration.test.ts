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
import { DuplicateEmailError } from "./auth.types.js";

/**
 * Email verification against real PostgreSQL, as the application role (Sprint 1B, D5b-1).
 * Opt-in: runs only with INTEGRATION_DATABASE_URL.
 */
const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const HOUR_MS = 60 * 60 * 1000;

describe.skipIf(!databaseUrl)("email verification (PostgreSQL integration)", () => {
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

  const input = () => ({
    email: `verify-${randomUUID()}@example.com`,
    passwordHash: "$argon2id$integration-test-placeholder",
    fullName: "Integración",
  });

  /** Other tests share the database: only dispatch this user's entries. */
  function composersFor(userId: string) {
    const real = createEmailComposers({
      appOrigin: "http://localhost:3000",
      emailVerificationTokenTtlMs: 24 * HOUR_MS,
      passwordResetTokenTtlMs: HOUR_MS / 2,
    });
    const onlyThisUser: EmailComposer = async (entry, scope) => {
      if (entry.userId !== userId) throw new Error("not this test's entry");
      return real.EMAIL_VERIFICATION!(entry, scope);
    };
    return { EMAIL_VERIFICATION: onlyThisUser };
  }

  const tokenOf = (text: string) => /#token=([A-Za-z0-9_-]+)/.exec(text)![1]!;

  it("creates the user and its verification intent together, and neither on a duplicate", async () => {
    const data = input();
    const user = await repository.createUserWithEmailVerification(data);
    expect(
      await prisma.emailOutbox.findMany({ where: { userId: user.id }, select: { kind: true } }),
    ).toEqual([{ kind: "EMAIL_VERIFICATION" }]);

    await expect(repository.createUserWithEmailVerification(data)).rejects.toBeInstanceOf(
      DuplicateEmailError,
    );
    expect(await prisma.user.count({ where: { email: data.email } })).toBe(1);
    expect(await prisma.emailOutbox.count({ where: { userId: user.id } })).toBe(1);
  });

  it("stores only the token hash, invalidates earlier tokens, and consumes a token once", async () => {
    const user = await repository.createUserWithEmailVerification(input());
    const transport = new MemoryEmailTransport();
    await dispatchPendingEmails(outbox, transport, composersFor(user.id), { limit: 1_000 });
    const first = tokenOf(transport.sent.at(-1)!.text);

    await prisma.emailOutbox.create({ data: { kind: "EMAIL_VERIFICATION", userId: user.id } });
    await dispatchPendingEmails(outbox, transport, composersFor(user.id), { limit: 1_000 });
    const second = tokenOf(transport.sent.at(-1)!.text);

    const tokens = await prisma.emailVerificationToken.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    expect(tokens.map((t) => t.tokenHash)).toEqual([sha256Hex(first), sha256Hex(second)]);
    expect(tokens[0]!.usedAt).toBeInstanceOf(Date); // invalidated by the newer one (P7)
    expect(tokens[1]!.usedAt).toBeNull();
    expect(JSON.stringify(tokens)).not.toContain(first);

    expect(await repository.consumeEmailVerificationToken(sha256Hex(first))).toBeNull();
    expect(await repository.consumeEmailVerificationToken(sha256Hex(second))).toBe(user.id);
    expect(await repository.consumeEmailVerificationToken(sha256Hex(second))).toBeNull();
    const verified = await prisma.user.findUnique({ where: { id: user.id } });
    expect(verified?.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("writes its audit event in the same transaction: a failing write keeps nothing", async () => {
    const user = await repository.createUserWithEmailVerification(input());
    const hash = sha256Hex(randomUUID());
    await prisma.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + HOUR_MS) },
    });
    const audit =
      (ip: string) =>
      (u: { id: string; role: "USER" | "PROFESSIONAL" | "ADMIN" | "SUPER_ADMIN" }) => ({
        actorUserId: u.id,
        actorRole: u.role,
        action: "auth.email.verified",
        entityType: "User",
        entityId: u.id,
        requestId: randomUUID(),
        ip,
        userAgent: "integration-test",
      });
    const events = () =>
      prisma.auditLog.count({ where: { action: "auth.email.verified", entityId: user.id } });

    // An invalid inet value makes the INSERT fail inside the transaction.
    await expect(repository.consumeEmailVerificationToken(hash, audit("x"))).rejects.toThrow();
    expect((await prisma.user.findUnique({ where: { id: user.id } }))?.emailVerifiedAt).toBeNull();
    expect(
      (await prisma.emailVerificationToken.findUnique({ where: { tokenHash: hash } }))?.usedAt,
    ).toBeNull();
    expect(await events()).toBe(0);

    expect(await repository.consumeEmailVerificationToken(hash, audit("203.0.113.7"))).toBe(
      user.id,
    );
    const verified = await prisma.user.findUnique({ where: { id: user.id } });
    expect(verified?.emailVerifiedAt).toBeInstanceOf(Date);
    const [event] = await prisma.auditLog.findMany({
      where: { action: "auth.email.verified", entityId: user.id },
    });
    expect(await events()).toBe(1);
    // Same PostgreSQL time as the verification.
    expect(event?.occurredAt.getTime()).toBe(verified?.emailVerifiedAt?.getTime());
  });

  it("rejects an expired token on PostgreSQL time", async () => {
    const user = await repository.createUserWithEmailVerification(input());
    const hash = sha256Hex(randomUUID());
    const [row] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    await prisma.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hash, expiresAt: new Date(row!.now.getTime() - 1_000) },
    });

    expect(await repository.consumeEmailVerificationToken(hash)).toBeNull();
    expect((await prisma.user.findUnique({ where: { id: user.id } }))?.emailVerifiedAt).toBeNull();
  });

  it("lets only one of two concurrent requests use the same token", async () => {
    const user = await repository.createUserWithEmailVerification(input());
    const hash = sha256Hex(randomUUID());
    await prisma.emailVerificationToken.create({
      data: { userId: user.id, tokenHash: hash, expiresAt: new Date(Date.now() + HOUR_MS) },
    });

    const results = await Promise.all([
      repository.consumeEmailVerificationToken(hash),
      repository.consumeEmailVerificationToken(hash),
    ]);
    expect(results.filter((r) => r === user.id)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });

  it("serializes concurrent resends per user, so a limit on recent emails holds", async () => {
    const user = await repository.createUserWithEmailVerification(input()); // 1 email already
    const allowed = 3;

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () =>
        repository.runEmailVerificationResend(user.id, 24 * HOUR_MS, async (scope) => {
          if (scope.recentEmails >= allowed) return "throttled";
          // Widen the window between reading the count and writing: without the per-user lock,
          // concurrent resends would all read the same count here and all enqueue.
          await new Promise((resolve) => setTimeout(resolve, 150));
          await scope.enqueueVerificationEmail();
          return "enqueued";
        }),
      ),
    );

    expect(outcomes.filter((o) => o === "enqueued")).toHaveLength(allowed - 1);
    expect(
      await prisma.emailOutbox.count({ where: { userId: user.id, kind: "EMAIL_VERIFICATION" } }),
    ).toBe(allowed);
  }, 20_000);
});
