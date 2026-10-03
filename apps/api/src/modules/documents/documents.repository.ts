import type { PrismaClient } from "@legaltech/database";
import { fromPrisma } from "pg-boss";
import type { JobQueue } from "../../jobs/job-queue.js";
import { auditLogData, loginLockKey } from "../auth/auth.repository.js";
import type {
  CreateDocumentInput,
  CreateDocumentResult,
  DocumentOcrRead,
  DocumentRecord,
  DocumentsRepository,
  RequestReprocessInput,
} from "./documents.types.js";

/** Advisory-lock namespace of the per-user document quota: "DOCQ". */
export const DOCUMENT_QUOTA_LOCK_NAMESPACE = 0x444f4351;

/** Prisma-backed implementation of DocumentsRepository. */
export class PrismaDocumentsRepository implements DocumentsRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly jobs: JobQueue,
  ) {}

  async createDocument(input: CreateDocumentInput): Promise<CreateDocumentResult> {
    return this.prisma.$transaction(async (tx) => {
      // One upload at a time per user while the quota is checked and the row written, so two
      // concurrent uploads cannot both fit in the space left for one. Released at commit.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DOCUMENT_QUOTA_LOCK_NAMESPACE}::int, ${loginLockKey(input.userId.replace(/-/g, ""))}::int)`;

      // The case must still be the user's and in DRAFT when the document is recorded.
      const owned = await tx.case.findFirst({
        where: { id: input.caseId, userId: input.userId, status: "DRAFT" },
        select: { id: true },
      });
      if (!owned) return { kind: "case_not_writable" };

      // Read after the lock is held: every upload of this user committed before is counted.
      const [usage] = await tx.$queryRaw<Array<{ used: bigint }>>`
        SELECT coalesce(sum(d.file_size), 0)::bigint AS used
        FROM documents d JOIN cases c ON c.id = d.case_id
        WHERE c.user_id = ${input.userId}::uuid`;
      if (Number(usage!.used) + input.fileSize > input.quotaBytes) {
        return { kind: "quota_exceeded" };
      }

      // One PostgreSQL instant for the document and its event (as for cases).
      const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const now = row!.now;
      const created = await tx.document.create({
        data: {
          id: input.id,
          caseId: input.caseId,
          fileName: input.fileName,
          fileType: input.fileType,
          storageKey: input.storageKey,
          fileSize: input.fileSize,
          uploadedByUserId: input.userId,
          createdAt: now,
        },
      });
      await tx.auditLog.create({
        data: { ...auditLogData(input.audit(created)), caseId: input.caseId, occurredAt: now },
      });
      // The security treatment is queued with the row: a document never exists without its job.
      await this.jobs.enqueueDocumentScan(created.id, fromPrisma(tx));
      return { kind: "created", document: created };
    });
  }

  async usedBytes(userId: string): Promise<number> {
    const [usage] = await this.prisma.$queryRaw<Array<{ used: bigint }>>`
      SELECT coalesce(sum(d.file_size), 0)::bigint AS used
      FROM documents d JOIN cases c ON c.id = d.case_id
      WHERE c.user_id = ${userId}::uuid`;
    return Number(usage!.used);
  }

  async listOwnCaseDocuments(caseId: string, userId: string): Promise<DocumentRecord[]> {
    return this.prisma.document.findMany({
      where: { caseId, case: { userId } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }

  async findOwnDocument(
    documentId: string,
    caseId: string,
    userId: string,
  ): Promise<DocumentRecord | null> {
    return this.prisma.document.findFirst({ where: { id: documentId, caseId, case: { userId } } });
  }

  async findOwnDocumentOcr(
    documentId: string,
    caseId: string,
    userId: string,
  ): Promise<DocumentOcrRead | null> {
    const document = await this.prisma.document.findFirst({
      where: { id: documentId, caseId, case: { userId } },
      select: { ocrStatus: true },
    });
    if (!document) return null;
    if (document.ocrStatus !== "COMPLETED") return { ocrStatus: document.ocrStatus, pages: [] };
    // The ownership and the COMPLETED state are checked again in the same statement that reads the
    // text, and only the latest completed execution is read (decisions OCR-A10.3 and OCR-A12).
    const rows = await this.prisma.$queryRaw<Array<{ page_number: number; text: string }>>`
      SELECT p.page_number, p.text
      FROM ocr_result_pages p
      WHERE p.ocr_result_id = (
        SELECT r.id
        FROM ocr_results r
        JOIN documents d ON d.id = r.document_id
        JOIN cases c ON c.id = d.case_id
        WHERE r.document_id = ${documentId}::uuid
          AND d.case_id = ${caseId}::uuid
          AND c.user_id = ${userId}::uuid
          AND d.ocr_status = 'COMPLETED'
          AND r.outcome = 'COMPLETED'
        ORDER BY r.finished_at DESC, r.id DESC
        LIMIT 1)
      ORDER BY p.page_number`;
    return {
      ocrStatus: "COMPLETED",
      pages: rows.map((row) => ({ number: row.page_number, text: row.text })),
    };
  }

  async findDocumentForAdministration(documentId: string): Promise<DocumentRecord | null> {
    return this.prisma.document.findUnique({ where: { id: documentId } });
  }

  async requestReprocess(input: RequestReprocessInput): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      await tx.auditLog.create({
        data: { ...auditLogData(input.audit), caseId: input.caseId, occurredAt: row!.now },
      });
      await this.jobs.enqueueDocumentReprocess(input.documentId, fromPrisma(tx));
    });
  }

  async requestOcrReprocess(input: RequestReprocessInput): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      await tx.auditLog.create({
        data: { ...auditLogData(input.audit), caseId: input.caseId, occurredAt: row!.now },
      });
      await this.jobs.enqueueDocumentOcrReprocess(input.documentId, fromPrisma(tx));
    });
  }
}
