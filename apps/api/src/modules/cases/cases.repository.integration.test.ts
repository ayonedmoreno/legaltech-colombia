import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient } from "@legaltech/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditLogEntry } from "../auth/auth.types.js";
import { PrismaCasesRepository } from "./cases.repository.js";
import type { CaseRecord } from "./cases.types.js";

/**
 * PrismaCasesRepository against real PostgreSQL, as the application role (opt-in through
 * INTEGRATION_DATABASE_URL, like the other integration tests; never a development database:
 * the audit_logs rows written here cannot be deleted).
 */
const databaseUrl = process.env.INTEGRATION_DATABASE_URL;

describe.skipIf(!databaseUrl)("PrismaCasesRepository (PostgreSQL integration)", () => {
  let prisma: PrismaClient;
  let repository: PrismaCasesRepository;

  beforeAll(() => {
    prisma = createPrismaClient(databaseUrl!);
    repository = new PrismaCasesRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  function newUser() {
    return prisma.user.create({
      data: {
        email: `it-${randomUUID()}@example.com`,
        passwordHash: "$argon2id$integration-test-placeholder",
        fullName: "Integración",
      },
    });
  }

  const audit =
    (userId: string, ip = "203.0.113.7") =>
    (created: CaseRecord): AuditLogEntry => ({
      actorUserId: userId,
      actorRole: "USER",
      action: "case.created",
      entityType: "Case",
      entityId: created.id,
      caseId: created.id,
      newValue: { type: created.type, status: created.status },
      requestId: randomUUID(),
      ip,
      userAgent: "integration-test",
    });

  it("creates the case in DRAFT with its history entry and its event, at one PostgreSQL time", async () => {
    const user = await newUser();

    const created = await repository.createCase({
      userId: user.id,
      type: "ADMINISTRATIVE_PROCEEDING",
      audit: audit(user.id),
    });

    expect(created).toMatchObject({
      userId: user.id,
      type: "ADMINISTRATIVE_PROCEEDING",
      status: "DRAFT",
    });
    const history = await prisma.caseStatusHistory.findMany({ where: { caseId: created.id } });
    expect(history).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: "DRAFT", changedByUserId: user.id }),
    ]);
    const events = await prisma.auditLog.findMany({ where: { caseId: created.id } });
    expect(events).toEqual([
      expect.objectContaining({
        action: "case.created",
        actorUserId: user.id,
        entityType: "Case",
        entityId: created.id,
        newValue: { type: "ADMINISTRATIVE_PROCEEDING", status: "DRAFT" },
      }),
    ]);
    expect(history[0]!.changedAt.getTime()).toBe(created.createdAt.getTime());
    expect(events[0]!.occurredAt.getTime()).toBe(created.createdAt.getTime());
  });

  it("keeps nothing when the audit write fails (one transaction)", async () => {
    const user = await newUser();

    // An invalid inet value makes the audit INSERT fail inside the transaction.
    await expect(
      repository.createCase({ userId: user.id, type: "OTHER", audit: audit(user.id, "x") }),
    ).rejects.toThrow();

    expect(await prisma.case.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.caseStatusHistory.count({ where: { changedByUserId: user.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { actorUserId: user.id } })).toBe(0);
  });

  it("keeps nothing for an owner that does not exist", async () => {
    const ghost = randomUUID();
    await expect(
      repository.createCase({ userId: ghost, type: "OTHER", audit: audit(ghost) }),
    ).rejects.toThrow();
    expect(await prisma.case.count({ where: { userId: ghost } })).toBe(0);
  });

  it("lists only the user's own cases, most recent first", async () => {
    const user = await newUser();
    const other = await newUser();
    const first = await repository.createCase({
      userId: user.id,
      type: "INFRACTION",
      audit: audit(user.id),
    });
    const second = await repository.createCase({
      userId: user.id,
      type: "TRANSPORT",
      audit: audit(user.id),
    });
    await repository.createCase({ userId: other.id, type: "OTHER", audit: audit(other.id) });

    const listed = await repository.listOwnCases(user.id);

    expect(listed.map((c) => c.id)).toEqual([second.id, first.id]);
    expect(await repository.listOwnCases(randomUUID())).toEqual([]);
  });

  it("finds a case only for its owner (ADR-003 scope)", async () => {
    const user = await newUser();
    const other = await newUser();
    const created = await repository.createCase({
      userId: user.id,
      type: "NOTIFICATION",
      audit: audit(user.id),
    });

    const found = await repository.findOwnCase(created.id, user.id);
    expect(found?.case.id).toBe(created.id);
    expect(found?.statusHistory).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: "DRAFT", changedByUserId: user.id }),
    ]);
    expect(await repository.findOwnCase(created.id, other.id)).toBeNull();
    expect(await repository.findOwnCase(randomUUID(), user.id)).toBeNull();
  });

  it("the application role cannot change or delete a case or its history", async () => {
    const user = await newUser();
    const created = await repository.createCase({
      userId: user.id,
      type: "OTHER",
      audit: audit(user.id),
    });

    await expect(
      prisma.case.update({ where: { id: created.id }, data: { status: "PAID" } }),
    ).rejects.toThrow();
    await expect(
      prisma.caseStatusHistory.deleteMany({ where: { caseId: created.id } }),
    ).rejects.toThrow();
    expect((await prisma.case.findUnique({ where: { id: created.id } }))?.status).toBe("DRAFT");
  });
});
