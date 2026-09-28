import { randomUUID } from "node:crypto";
import { createPrismaClient, type PrismaClient } from "@legaltech/database";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBossJobQueue, startPgBossForApi } from "../../jobs/job-queue.js";
import type { AuditLogEntry } from "../auth/auth.types.js";
import { PrismaCasesRepository } from "../cases/cases.repository.js";
import { PrismaDocumentsRepository } from "./documents.repository.js";
import type { CreateDocumentInput, DocumentRecord } from "./documents.types.js";

/**
 * PrismaDocumentsRepository against real PostgreSQL and pg-boss, as the application role (opt-in
 * through INTEGRATION_DATABASE_URL; never a development database: audit_logs rows cannot be
 * deleted). The jobs are read back as the worker role (INTEGRATION_WORKER_DATABASE_URL): the
 * application role can only enqueue them.
 */
const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const workerDatabaseUrl = process.env.INTEGRATION_WORKER_DATABASE_URL;

describe.skipIf(!databaseUrl)("PrismaDocumentsRepository (PostgreSQL integration)", () => {
  let prisma: PrismaClient;
  let workerPrisma: PrismaClient;
  let boss: PgBoss;
  let repository: PrismaDocumentsRepository;
  let cases: PrismaCasesRepository;

  beforeAll(async () => {
    if (!workerDatabaseUrl) throw new Error("INTEGRATION_WORKER_DATABASE_URL must be set too");
    prisma = createPrismaClient(databaseUrl!);
    workerPrisma = createPrismaClient(workerDatabaseUrl);
    boss = await startPgBossForApi(databaseUrl!);
    repository = new PrismaDocumentsRepository(prisma, new PgBossJobQueue(boss));
    cases = new PrismaCasesRepository(prisma);
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await prisma?.$disconnect();
    await workerPrisma?.$disconnect();
  });

  /** document.scan jobs of a document (read as the worker role). */
  async function scanJobs(documentId: string): Promise<number> {
    const [row] = await workerPrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM pgboss.job_common
      WHERE name = 'document.scan' AND data->>'documentId' = ${documentId}`;
    return Number(row!.count);
  }

  async function userWithCase() {
    const user = await prisma.user.create({
      data: {
        email: `it-${randomUUID()}@example.com`,
        passwordHash: "$argon2id$integration-test-placeholder",
        fullName: "Integración",
      },
    });
    const created = await cases.createCase({
      userId: user.id,
      type: "OTHER",
      audit: (record) => ({
        actorUserId: user.id,
        actorRole: "USER",
        action: "case.created",
        entityType: "Case",
        entityId: record.id,
        requestId: null,
        ip: null,
        userAgent: null,
      }),
    });
    return { userId: user.id, caseId: created.id };
  }

  function input(
    owner: { userId: string; caseId: string },
    overrides: Partial<CreateDocumentInput> = {},
  ): CreateDocumentInput {
    const id = randomUUID();
    return {
      id,
      caseId: owner.caseId,
      userId: owner.userId,
      fileName: "comparendo.pdf",
      fileType: "PDF",
      storageKey: `cases/${owner.caseId}/documents/${id}`,
      fileSize: 1234,
      audit: (record: DocumentRecord): AuditLogEntry => ({
        actorUserId: owner.userId,
        actorRole: "USER",
        action: "document.uploaded",
        entityType: "Document",
        entityId: record.id,
        newValue: { fileType: record.fileType, fileSize: record.fileSize, status: record.status },
        requestId: randomUUID(),
        ip: "203.0.113.7",
        userAgent: "integration-test",
      }),
      ...overrides,
    };
  }

  const events = (documentId: string) =>
    prisma.auditLog.findMany({ where: { action: "document.uploaded", entityId: documentId } });

  it("stores the document PENDING_SCAN / NOT_STARTED with its event, case_id and scan job", async () => {
    const owner = await userWithCase();
    const data = input(owner);

    const created = await repository.createDocument(data);

    expect(created).toMatchObject({
      id: data.id,
      caseId: owner.caseId,
      uploadedByUserId: owner.userId,
      status: "PENDING_SCAN",
      ocrStatus: "NOT_STARTED",
      scanAttempts: 0,
      sanitizedStorageKey: null,
    });
    expect(await scanJobs(data.id)).toBe(1);
    const [event] = await events(data.id);
    expect(event).toMatchObject({ caseId: owner.caseId, actorUserId: owner.userId });
    expect(event!.occurredAt.getTime()).toBe(created!.createdAt.getTime());
    expect(JSON.stringify(event)).not.toContain("comparendo");
  });

  it("writes nothing for a case that is not the user's", async () => {
    const owner = await userWithCase();
    const intruder = await userWithCase();
    const data = input({ userId: intruder.userId, caseId: owner.caseId });

    expect(await repository.createDocument(data)).toBeNull();
    expect(await prisma.document.count({ where: { id: data.id } })).toBe(0);
    expect(await events(data.id)).toHaveLength(0);
    expect(await scanJobs(data.id)).toBe(0);
  });

  it("keeps nothing when the audit write fails: no row, no job (one transaction)", async () => {
    const owner = await userWithCase();
    const base = input(owner);
    const data = {
      ...base,
      audit: (record: DocumentRecord) => ({ ...base.audit(record), ip: "x" }),
    };

    await expect(repository.createDocument(data)).rejects.toThrow();
    expect(await prisma.document.count({ where: { id: data.id } })).toBe(0);
    expect(await scanJobs(data.id)).toBe(0);
  });

  it("keeps nothing when the job cannot be enqueued (one transaction)", async () => {
    const owner = await userWithCase();
    const failing = new PrismaDocumentsRepository(prisma, {
      enqueueDocumentScan: () => Promise.reject(new Error("queue unavailable")),
    });
    const data = input(owner);

    await expect(failing.createDocument(data)).rejects.toThrow("queue unavailable");
    expect(await prisma.document.count({ where: { id: data.id } })).toBe(0);
    expect(await events(data.id)).toHaveLength(0);
  });

  it("rejects an empty file and a reused storage key", async () => {
    const owner = await userWithCase();
    await expect(repository.createDocument(input(owner, { fileSize: 0 }))).rejects.toThrow();
    const first = input(owner);
    await repository.createDocument(first);
    await expect(
      repository.createDocument(input(owner, { storageKey: first.storageKey })),
    ).rejects.toThrow();
  });

  it("finds and lists documents only through their own case and its owner", async () => {
    const owner = await userWithCase();
    const other = await userWithCase();
    const doc = (await repository.createDocument(input(owner)))!;
    const secondCase = await cases.createCase({
      userId: owner.userId,
      type: "OTHER",
      audit: (record) => ({
        actorUserId: owner.userId,
        actorRole: "USER",
        action: "case.created",
        entityId: record.id,
        requestId: null,
        ip: null,
        userAgent: null,
      }),
    });

    expect(
      (await repository.listOwnCaseDocuments(owner.caseId, owner.userId)).map((d) => d.id),
    ).toEqual([doc.id]);
    expect(await repository.listOwnCaseDocuments(owner.caseId, other.userId)).toEqual([]);
    expect((await repository.findOwnDocument(doc.id, owner.caseId, owner.userId))?.id).toBe(doc.id);
    expect(await repository.findOwnDocument(doc.id, owner.caseId, other.userId)).toBeNull();
    expect(await repository.findOwnDocument(doc.id, secondCase.id, owner.userId)).toBeNull();
  });

  it("the application role can neither change nor delete a document, nor mark it CLEAN", async () => {
    const owner = await userWithCase();
    const doc = (await repository.createDocument(input(owner)))!;
    await expect(
      prisma.document.update({ where: { id: doc.id }, data: { fileName: "x.pdf" } }),
    ).rejects.toThrow();
    await expect(
      prisma.document.updateMany({ where: { id: doc.id }, data: { status: "CLEAN" } }),
    ).rejects.toThrow();
    await expect(prisma.document.delete({ where: { id: doc.id } })).rejects.toThrow();
  });
});
