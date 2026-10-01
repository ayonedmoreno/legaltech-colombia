import type { DocumentFileType, DocumentOcrStatus, DocumentStatus } from "@legaltech/database";
import type { AuditLogEntry } from "../auth/auth.types.js";

/** A document's metadata as stored (DATABASE_SPEC.md `documents`); the file is in storage. */
export interface DocumentRecord {
  id: string;
  caseId: string;
  fileName: string;
  fileType: DocumentFileType;
  storageKey: string;
  fileSize: number;
  uploadedByUserId: string;
  createdAt: Date;
  status: DocumentStatus;
  ocrStatus: DocumentOcrStatus;
  scanAttempts: number;
  scanStartedAt: Date | null;
  scannedAt: Date | null;
  scanSignature: string | null;
  /** Derived copy without identifying metadata (JPEG/PNG), written by the worker. */
  sanitizedStorageKey: string | null;
}

export interface CreateDocumentInput {
  id: string;
  caseId: string;
  /** The uploader, who must own the case. */
  userId: string;
  fileName: string;
  fileType: DocumentFileType;
  storageKey: string;
  fileSize: number;
  /** The user's space quota in bytes (DOCUMENT_QUOTA_BYTES), checked under a per-user lock. */
  quotaBytes: number;
  /** Builds the `document.uploaded` event once the row exists. */
  audit: (created: DocumentRecord) => AuditLogEntry;
}

/** How a document creation ended. */
export type CreateDocumentResult =
  | { kind: "created"; document: DocumentRecord }
  /** The case is no longer an owned `DRAFT`. */
  | { kind: "case_not_writable" }
  /** The user's documents would exceed the quota with this one. */
  | { kind: "quota_exceeded" };

export interface RequestReprocessInput {
  documentId: string;
  caseId: string;
  /** The `document.reprocess_requested` event, with the ADMIN as actor and the justification. */
  audit: AuditLogEntry;
}

/**
 * Persistence of document metadata: Prisma at runtime, in memory in tests. Every query a user's
 * request makes names the owner of the case (ADR-003): a document is only ever found through its
 * own case, and a case only through its owner. The one exception is an administrative action,
 * authorized by the policy, justified and audited (findDocumentForAdministration).
 */
export interface DocumentsRepository {
  /**
   * In one transaction, serialized per user: checks that the case is still the user's and in
   * `DRAFT` and that the user's documents plus this one stay within the quota, stores the
   * document (`PENDING_SCAN`, `NOT_STARTED`), writes its audit event with `case_id` and enqueues
   * its `document.scan` job, all at one PostgreSQL time. Writes nothing otherwise.
   */
  createDocument(input: CreateDocumentInput): Promise<CreateDocumentResult>;
  /** Bytes taken by the user's documents (original files, whatever their status). */
  usedBytes(userId: string): Promise<number>;
  /** The documents of one of the user's cases, most recent first (empty for anyone else's). */
  listOwnCaseDocuments(caseId: string, userId: string): Promise<DocumentRecord[]>;
  /** One document of one of the user's cases, or null (unknown, other case, other owner). */
  findOwnDocument(
    documentId: string,
    caseId: string,
    userId: string,
  ): Promise<DocumentRecord | null>;
  /**
   * Any document by id, whoever owns it: only for an administrative action already authorized by
   * the policy, justified and audited (ADR-003, ADMIN). Never used for a user's own requests.
   */
  findDocumentForAdministration(documentId: string): Promise<DocumentRecord | null>;
  /** In one transaction: the request's audit event and its `document.reprocess` job. */
  requestReprocess(input: RequestReprocessInput): Promise<void>;
}
