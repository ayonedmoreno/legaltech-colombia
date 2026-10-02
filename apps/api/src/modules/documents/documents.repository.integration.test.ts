import { randomUUID } from "node:crypto";
import { DOCUMENT_QUOTA_BYTES } from "@legaltech/contracts";
import { createPrismaClient, type PrismaClient } from "@legaltech/database";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBossJobQueue, startPgBossForApi, type JobQueue } from "../../jobs/job-queue.js";
import type { AuditLogEntry } from "../auth/auth.types.js";
import { PrismaCasesRepository } from "../cases/cases.repository.js";
import { PrismaDocumentsRepository } from "./documents.repository.js";
import type {
  CreateDocumentInput,
  CreateDocumentResult,
  DocumentRecord,
} from "./documents.types.js";

/**
 * PrismaDocumentsRepository against real PostgreSQL and pg-boss, as the application role (opt-in
 * through INTEGRATION_DATABASE_URL; never a development database: audit_logs rows cannot be
 * deleted). The jobs are read back as the worker role (INTEGRATION_WORKER_DATABASE_URL): the
 * application role can only enqueue them.
 */
const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const workerDatabaseUrl = process.env.INTEGRATION_WORKER_DATABASE_URL;

/** The created document, or a failure naming what came back instead. */
function created(result: CreateDocumentResult): DocumentRecord {
  if (result.kind !== "created") throw new Error(`expected a created document, got ${result.kind}`);
  return result.document;
}

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

  /** Jobs of a queue for a document (read as the worker role). */
  async function jobs(queue: string, documentId: string): Promise<number> {
    const [row] = await workerPrisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*) AS count FROM pgboss.job_common
      WHERE name = ${queue} AND data->>'documentId' = ${documentId}`;
    return Number(row!.count);
  }
  const scanJobs = (documentId: string) => jobs("document.scan", documentId);

  async function newCase(userId: string) {
    const record = await cases.createCase({
      userId,
      type: "OTHER",
      audit: (r) => ({
        actorUserId: userId,
        actorRole: "USER",
        action: "case.created",
        entityType: "Case",
        entityId: r.id,
        requestId: null,
        ip: null,
        userAgent: null,
      }),
    });
    return record.id;
  }

  async function userWithCase() {
    const user = await prisma.user.create({
      data: {
        email: `it-${randomUUID()}@example.com`,
        passwordHash: "$argon2id$integration-test-placeholder",
        fullName: "Integración",
      },
    });
    return { userId: user.id, caseId: await newCase(user.id) };
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
      quotaBytes: DOCUMENT_QUOTA_BYTES,
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

    const document = created(await repository.createDocument(data));

    expect(document).toMatchObject({
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
    expect(event!.occurredAt.getTime()).toBe(document.createdAt.getTime());
    expect(JSON.stringify(event)).not.toContain("comparendo");
  });

  it("writes nothing for a case that is not the user's", async () => {
    const owner = await userWithCase();
    const intruder = await userWithCase();
    const data = input({ userId: intruder.userId, caseId: owner.caseId });

    expect(await repository.createDocument(data)).toEqual({ kind: "case_not_writable" });
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
    const failingQueue: JobQueue = {
      enqueueDocumentScan: () => Promise.reject(new Error("queue unavailable")),
      enqueueDocumentReprocess: () => Promise.reject(new Error("queue unavailable")),
      enqueueDocumentOcrReprocess: () => Promise.reject(new Error("not used")),
    };
    const failing = new PrismaDocumentsRepository(prisma, failingQueue);
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
    const doc = created(await repository.createDocument(input(owner)));
    const secondCase = await newCase(owner.userId);

    expect(
      (await repository.listOwnCaseDocuments(owner.caseId, owner.userId)).map((d) => d.id),
    ).toEqual([doc.id]);
    expect(await repository.listOwnCaseDocuments(owner.caseId, other.userId)).toEqual([]);
    expect((await repository.findOwnDocument(doc.id, owner.caseId, owner.userId))?.id).toBe(doc.id);
    expect(await repository.findOwnDocument(doc.id, owner.caseId, other.userId)).toBeNull();
    expect(await repository.findOwnDocument(doc.id, secondCase, owner.userId)).toBeNull();
  });

  it("the application role can neither change nor delete a document, nor mark it CLEAN", async () => {
    const owner = await userWithCase();
    const doc = created(await repository.createDocument(input(owner)));
    await expect(
      prisma.document.update({ where: { id: doc.id }, data: { fileName: "x.pdf" } }),
    ).rejects.toThrow();
    await expect(
      prisma.document.updateMany({ where: { id: doc.id }, data: { status: "CLEAN" } }),
    ).rejects.toThrow();
    await expect(prisma.document.delete({ where: { id: doc.id } })).rejects.toThrow();
  });

  describe("quota", () => {
    it("refuses a document that would take the user past the quota, writing nothing", async () => {
      const owner = await userWithCase();
      created(await repository.createDocument(input(owner, { fileSize: 600, quotaBytes: 1000 })));
      created(await repository.createDocument(input(owner, { fileSize: 400, quotaBytes: 1000 })));
      const over = input(owner, { fileSize: 1, quotaBytes: 1000 });

      expect(await repository.createDocument(over)).toEqual({ kind: "quota_exceeded" });
      expect(await prisma.document.count({ where: { id: over.id } })).toBe(0);
      expect(await events(over.id)).toHaveLength(0);
      expect(await scanJobs(over.id)).toBe(0);
      expect(await repository.usedBytes(owner.userId)).toBe(1000);
    });

    it("counts every document of the user, in all their cases and whatever its status", async () => {
      const owner = await userWithCase();
      const other = await userWithCase();
      const secondCase = await newCase(owner.userId);
      const failed = created(
        await repository.createDocument(input(owner, { fileSize: 500, quotaBytes: 1000 })),
      );
      // A document that ended INFECTED or SCAN_FAILED still exists, so it still counts.
      await workerPrisma.$executeRaw`UPDATE documents SET status = 'INFECTED' WHERE id = ${failed.id}::uuid`;
      created(await repository.createDocument(input(owner, { fileSize: 500, quotaBytes: 1000 })));

      expect(
        await repository.createDocument(
          input({ userId: owner.userId, caseId: secondCase }, { fileSize: 1, quotaBytes: 1000 }),
        ),
      ).toEqual({ kind: "quota_exceeded" });
      // Another user's space is their own.
      created(await repository.createDocument(input(other, { fileSize: 1000, quotaBytes: 1000 })));
    });

    it("lets concurrent uploads of one user fill the quota but never pass it", async () => {
      const owner = await userWithCase();
      // Five uploads of 300 bytes at once against 1000 bytes: exactly three fit.
      const attempts = Array.from({ length: 5 }, () =>
        input(owner, { fileSize: 300, quotaBytes: 1000 }),
      );

      const results = await Promise.all(attempts.map((a) => repository.createDocument(a)));

      expect(results.filter((r) => r.kind === "created")).toHaveLength(3);
      expect(results.filter((r) => r.kind === "quota_exceeded")).toHaveLength(2);
      expect(await repository.usedBytes(owner.userId)).toBe(900);
    });
  });

  describe("administration", () => {
    it("finds any document by id for an administrative action", async () => {
      const owner = await userWithCase();
      const doc = created(await repository.createDocument(input(owner)));

      expect((await repository.findDocumentForAdministration(doc.id))?.id).toBe(doc.id);
      expect(await repository.findDocumentForAdministration(randomUUID())).toBeNull();
    });

    it("records a reprocessing request and its job together, or neither", async () => {
      const owner = await userWithCase();
      const doc = created(await repository.createDocument(input(owner)));
      const admin = await prisma.user.create({
        data: {
          email: `it-admin-${randomUUID()}@example.com`,
          passwordHash: "$argon2id$integration-test-placeholder",
          fullName: "Admin",
          role: "ADMIN",
        },
      });
      const audit: AuditLogEntry = {
        actorUserId: admin.id,
        actorRole: "ADMIN",
        action: "document.reprocess_requested",
        entityType: "Document",
        entityId: doc.id,
        metadata: { reason: "ClamAV no disponible" },
        requestId: randomUUID(),
        ip: "203.0.113.9",
        userAgent: "integration-test",
      };
      const requested = () =>
        prisma.auditLog.findMany({
          where: { action: "document.reprocess_requested", entityId: doc.id },
        });

      const failing = new PrismaDocumentsRepository(prisma, {
        enqueueDocumentScan: () => Promise.resolve(),
        enqueueDocumentReprocess: () => Promise.reject(new Error("queue unavailable")),
        enqueueDocumentOcrReprocess: () => Promise.reject(new Error("not used")),
      });
      await expect(
        failing.requestReprocess({ documentId: doc.id, caseId: owner.caseId, audit }),
      ).rejects.toThrow("queue unavailable");
      expect(await requested()).toHaveLength(0);

      await repository.requestReprocess({ documentId: doc.id, caseId: owner.caseId, audit });
      const [event] = await requested();
      expect(event).toMatchObject({
        actorUserId: admin.id,
        actorRole: "ADMIN",
        caseId: owner.caseId,
        metadata: { reason: "ClamAV no disponible" },
      });
      expect(await jobs("document.reprocess", doc.id)).toBe(1);
    });

    it("records an OCR reprocessing request and its own job together, or neither", async () => {
      const owner = await userWithCase();
      const doc = created(await repository.createDocument(input(owner)));
      const admin = await prisma.user.create({
        data: {
          email: `it-admin-${randomUUID()}@example.com`,
          passwordHash: "$argon2id$integration-test-placeholder",
          fullName: "Admin",
          role: "ADMIN",
        },
      });
      const audit: AuditLogEntry = {
        actorUserId: admin.id,
        actorRole: "ADMIN",
        action: "document.ocr_reprocess_requested",
        entityType: "Document",
        entityId: doc.id,
        metadata: { reason: "Proveedor de OCR no disponible" },
        requestId: randomUUID(),
        ip: "203.0.113.9",
        userAgent: "integration-test",
      };
      const requested = () =>
        prisma.auditLog.findMany({
          where: { action: "document.ocr_reprocess_requested", entityId: doc.id },
        });

      const failing = new PrismaDocumentsRepository(prisma, {
        enqueueDocumentScan: () => Promise.resolve(),
        enqueueDocumentReprocess: () => Promise.reject(new Error("not used")),
        enqueueDocumentOcrReprocess: () => Promise.reject(new Error("queue unavailable")),
      });
      await expect(
        failing.requestOcrReprocess({ documentId: doc.id, caseId: owner.caseId, audit }),
      ).rejects.toThrow("queue unavailable");
      expect(await requested()).toHaveLength(0);

      await repository.requestOcrReprocess({ documentId: doc.id, caseId: owner.caseId, audit });
      const [event] = await requested();
      expect(event).toMatchObject({
        actorUserId: admin.id,
        actorRole: "ADMIN",
        caseId: owner.caseId,
        metadata: { reason: "Proveedor de OCR no disponible" },
      });
      expect(await jobs("document.ocr_reprocess", doc.id)).toBe(1);
      // Its own queue: never the security treatment's.
      expect(await jobs("document.reprocess", doc.id)).toBe(0);
    });
  });
});
