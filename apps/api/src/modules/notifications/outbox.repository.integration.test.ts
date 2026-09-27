import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient } from "@legaltech/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatchPendingEmails } from "./dispatch.js";
import type { EmailComposer } from "./notifications.types.js";
import { PrismaOutboxRepository, enqueueEmail } from "./outbox.repository.js";
import { MemoryEmailTransport } from "./transports.js";

/**
 * The email outbox against real PostgreSQL, as the application role (Sprint 1B decision C2).
 * Opt-in like the auth repository integration tests: runs only with INTEGRATION_DATABASE_URL.
 */
const databaseUrl = process.env.INTEGRATION_DATABASE_URL;

describe.skipIf(!databaseUrl)("email outbox (PostgreSQL integration)", () => {
  let prisma: PrismaClient;
  let repository: PrismaOutboxRepository;

  beforeAll(() => {
    prisma = createPrismaClient(databaseUrl!);
    repository = new PrismaOutboxRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function newUser() {
    return prisma.user.create({
      data: {
        email: `outbox-${randomUUID()}@example.com`,
        passwordHash: "$argon2id$integration-test-placeholder",
        fullName: "Integración",
      },
    });
  }

  /** Other tests share the database: only this test's users' entries are dispatched. */
  function onlyFor(userIds: string[], composer: EmailComposer): EmailComposer {
    return async (entry, scope) => {
      if (!userIds.includes(entry.userId)) throw new Error("not this test's entry");
      return composer(entry, scope);
    };
  }

  const toUser: EmailComposer = async (entry, scope) => ({
    to: (await scope.findUserEmail(entry.userId))!,
    subject: "Verifica tu correo",
    text: `entry ${entry.id}`,
  });

  it("records the intent only if the transaction that causes it commits", async () => {
    const user = await newUser();

    await expect(
      prisma.$transaction(async (tx) => {
        await enqueueEmail(tx, "EMAIL_VERIFICATION", user.id);
        throw new Error("the causing change fails");
      }),
    ).rejects.toThrow("the causing change fails");
    expect(await prisma.emailOutbox.count({ where: { userId: user.id } })).toBe(0);

    await prisma.$transaction(async (tx) => {
      await enqueueEmail(tx, "EMAIL_VERIFICATION", user.id);
    });
    const stored = await prisma.emailOutbox.findMany({ where: { userId: user.id } });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "EMAIL_VERIFICATION", sentAt: null });
    expect(Object.keys(stored[0]!).sort()).toEqual(["createdAt", "id", "kind", "sentAt", "userId"]);
  });

  it("dispatches pending entries once, marks them sent, and leaves failures pending", async () => {
    const ok = await newUser();
    const failing = await newUser();
    await enqueueEmail(prisma, "EMAIL_VERIFICATION", ok.id);
    await enqueueEmail(prisma, "PASSWORD_RESET", failing.id);
    const transport = new MemoryEmailTransport();
    const composers = {
      EMAIL_VERIFICATION: onlyFor([ok.id], toUser),
      PASSWORD_RESET: onlyFor([failing.id], async () => {
        throw new Error("cannot compose");
      }),
    };

    await dispatchPendingEmails(repository, transport, composers, { limit: 1_000 });

    expect(transport.sent.filter((m) => m.to === ok.email)).toHaveLength(1);
    const sent = await prisma.emailOutbox.findFirst({ where: { userId: ok.id } });
    expect(sent?.sentAt).toBeInstanceOf(Date);
    const pending = await prisma.emailOutbox.findFirst({ where: { userId: failing.id } });
    expect(pending?.sentAt).toBeNull();

    // A second run does not send the sent entry again.
    const again = new MemoryEmailTransport();
    await dispatchPendingEmails(repository, again, composers, { limit: 1_000 });
    expect(again.sent.filter((m) => m.to === ok.email)).toHaveLength(0);
  });

  it("never lets two concurrent dispatchers send the same entry", async () => {
    const user = await newUser();
    for (let i = 0; i < 5; i++) await enqueueEmail(prisma, "EMAIL_VERIFICATION", user.id);
    const transport = new MemoryEmailTransport();
    const slow: EmailComposer = onlyFor([user.id], async (entry, scope) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return toUser(entry, scope);
    });

    await Promise.all([
      dispatchPendingEmails(repository, transport, { EMAIL_VERIFICATION: slow }, { limit: 1_000 }),
      dispatchPendingEmails(repository, transport, { EMAIL_VERIFICATION: slow }, { limit: 1_000 }),
    ]);

    const texts = transport.sent.filter((m) => m.to === user.email).map((m) => m.text);
    expect(texts).toHaveLength(5);
    expect(new Set(texts).size).toBe(5);
    expect(await prisma.emailOutbox.count({ where: { userId: user.id, sentAt: null } })).toBe(0);
  }, 30_000);
});
