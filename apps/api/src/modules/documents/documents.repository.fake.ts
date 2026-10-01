import type { AuditLogEntry } from "../auth/auth.types.js";
import type { FakeCasesRepository } from "../cases/cases.repository.fake.js";
import type {
  CreateDocumentInput,
  CreateDocumentResult,
  DocumentRecord,
  DocumentsRepository,
  RequestReprocessInput,
} from "./documents.types.js";

/**
 * In-memory DocumentsRepository for tests, sharing the fake cases (in PostgreSQL they are
 * tables of the same database). Mirrors the Prisma transaction: the audit event is recorded
 * first, so a failure stores nothing. Calls run one at a time, as the per-user lock makes them
 * in PostgreSQL.
 */
export class FakeDocumentsRepository implements DocumentsRepository {
  readonly documents = new Map<string, DocumentRecord>();
  readonly auditLog: AuditLogEntry[] = [];
  /** Documents whose `document.scan` job was enqueued (with their row, in the same transaction). */
  readonly enqueuedScans: string[] = [];
  /** Documents whose `document.reprocess` job was enqueued (with the request's event). */
  readonly enqueuedReprocesses: string[] = [];
  /** Test hook: stands in for PostgreSQL's clock. */
  clock: () => Date = () => new Date();

  constructor(private readonly cases: FakeCasesRepository) {}

  async createDocument(input: CreateDocumentInput): Promise<CreateDocumentResult> {
    const found = this.cases.cases.get(input.caseId);
    if (!found || found.userId !== input.userId || found.status !== "DRAFT") {
      return { kind: "case_not_writable" };
    }
    if ((await this.usedBytes(input.userId)) + input.fileSize > input.quotaBytes) {
      return { kind: "quota_exceeded" };
    }
    const created: DocumentRecord = {
      id: input.id,
      caseId: input.caseId,
      fileName: input.fileName,
      fileType: input.fileType,
      storageKey: input.storageKey,
      fileSize: input.fileSize,
      uploadedByUserId: input.userId,
      createdAt: this.clock(),
      status: "PENDING_SCAN",
      ocrStatus: "NOT_STARTED",
      scanAttempts: 0,
      scanStartedAt: null,
      scannedAt: null,
      scanSignature: null,
      sanitizedStorageKey: null,
    };
    this.recordAudit({ ...input.audit(created), caseId: input.caseId });
    this.documents.set(created.id, created);
    this.enqueuedScans.push(created.id);
    return { kind: "created", document: { ...created } };
  }

  async usedBytes(userId: string): Promise<number> {
    let used = 0;
    for (const document of this.documents.values()) {
      if (this.cases.cases.get(document.caseId)?.userId === userId) used += document.fileSize;
    }
    return used;
  }

  async listOwnCaseDocuments(caseId: string, userId: string): Promise<DocumentRecord[]> {
    if (this.cases.cases.get(caseId)?.userId !== userId) return [];
    return [...this.documents.values()]
      .filter((document) => document.caseId === caseId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .map((document) => ({ ...document }));
  }

  async findOwnDocument(
    documentId: string,
    caseId: string,
    userId: string,
  ): Promise<DocumentRecord | null> {
    const document = this.documents.get(documentId);
    if (!document || document.caseId !== caseId) return null;
    if (this.cases.cases.get(caseId)?.userId !== userId) return null;
    return { ...document };
  }

  async findDocumentForAdministration(documentId: string): Promise<DocumentRecord | null> {
    const document = this.documents.get(documentId);
    return document ? { ...document } : null;
  }

  async requestReprocess(input: RequestReprocessInput): Promise<void> {
    this.recordAudit({ ...input.audit, caseId: input.caseId });
    this.enqueuedReprocesses.push(input.documentId);
  }

  /** Where every audit event is recorded; tests override it to make the audit write fail. */
  protected recordAudit(entry: AuditLogEntry): void {
    this.auditLog.push(entry);
  }
}
