import type { AuditLogEntry } from "../auth/auth.types.js";
import type { FakeCasesRepository } from "../cases/cases.repository.fake.js";
import type {
  CreateDocumentInput,
  DocumentRecord,
  DocumentsRepository,
} from "./documents.types.js";

/**
 * In-memory DocumentsRepository for tests, sharing the fake cases (in PostgreSQL they are
 * tables of the same database). Mirrors the Prisma transaction: the audit event is recorded
 * first, so a failure stores nothing.
 */
export class FakeDocumentsRepository implements DocumentsRepository {
  readonly documents = new Map<string, DocumentRecord>();
  readonly auditLog: AuditLogEntry[] = [];
  /** Test hook: stands in for PostgreSQL's clock. */
  clock: () => Date = () => new Date();

  constructor(private readonly cases: FakeCasesRepository) {}

  async createDocument(input: CreateDocumentInput): Promise<DocumentRecord | null> {
    const found = this.cases.cases.get(input.caseId);
    if (!found || found.userId !== input.userId || found.status !== "DRAFT") return null;
    const created: DocumentRecord = {
      id: input.id,
      caseId: input.caseId,
      fileName: input.fileName,
      fileType: input.fileType,
      storageKey: input.storageKey,
      fileSize: input.fileSize,
      uploadedByUserId: input.userId,
      createdAt: this.clock(),
      status: "UPLOADED",
      ocrStatus: "NOT_STARTED",
    };
    this.recordAudit({ ...input.audit(created), caseId: input.caseId });
    this.documents.set(created.id, created);
    return { ...created };
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

  /** Where every audit event is recorded; tests override it to make the audit write fail. */
  protected recordAudit(entry: AuditLogEntry): void {
    this.auditLog.push(entry);
  }
}
