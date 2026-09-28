import type { PrismaClient } from "@legaltech/database";
import { fromPrisma } from "pg-boss";
import type { JobQueue } from "../../jobs/job-queue.js";
import { auditLogData } from "../auth/auth.repository.js";
import type {
  CreateDocumentInput,
  DocumentRecord,
  DocumentsRepository,
} from "./documents.types.js";

/** Prisma-backed implementation of DocumentsRepository. */
export class PrismaDocumentsRepository implements DocumentsRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly jobs: JobQueue,
  ) {}

  async createDocument(input: CreateDocumentInput): Promise<DocumentRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      // The case must still be the user's and in DRAFT when the document is recorded.
      const owned = await tx.case.findFirst({
        where: { id: input.caseId, userId: input.userId, status: "DRAFT" },
        select: { id: true },
      });
      if (!owned) return null;

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
      return created;
    });
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
}
