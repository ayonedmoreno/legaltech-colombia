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
  /** Builds the `document.uploaded` event once the row exists. */
  audit: (created: DocumentRecord) => AuditLogEntry;
}

/**
 * Persistence of document metadata: Prisma at runtime, in memory in tests. Every query names
 * the owner of the case (ADR-003): a document is only ever found through its own case, and a
 * case only through its owner.
 */
export interface DocumentsRepository {
  /**
   * In one transaction: checks that the case is still the user's and in `DRAFT`, stores the
   * document (`PENDING_SCAN`, `NOT_STARTED`), writes its audit event with `case_id` and enqueues
   * its `document.scan` job, all at one PostgreSQL time. Returns null, writing nothing, when the
   * case is no longer an owned `DRAFT`.
   */
  createDocument(input: CreateDocumentInput): Promise<DocumentRecord | null>;
  /** The documents of one of the user's cases, most recent first (empty for anyone else's). */
  listOwnCaseDocuments(caseId: string, userId: string): Promise<DocumentRecord[]>;
  /** One document of one of the user's cases, or null (unknown, other case, other owner). */
  findOwnDocument(
    documentId: string,
    caseId: string,
    userId: string,
  ): Promise<DocumentRecord | null>;
}
