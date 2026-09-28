import type { DocumentFileType } from "@legaltech/database";

/** A document the worker has claimed for its security treatment. */
export interface ScanClaim {
  documentId: string;
  caseId: string;
  fileType: DocumentFileType;
  storageKey: string;
  fileSize: number;
  /** Treatments started, this one included. */
  attempts: number;
  /**
   * `scan_started_at` as PostgreSQL wrote it (full microsecond precision, as text): the fencing
   * token. Only the holder of the current claim can record a result or release it.
   */
  token: string;
}

/**
 * The document table as the worker sees it (DATABASE_SPEC.md, "Tratamiento de seguridad del
 * documento"). Every transition is one conditional statement, and every result is written with
 * its audit event in one transaction.
 */
export interface ScanRepository {
  /**
   * Claims a document for treatment: PENDING_SCAN (or a SCANNING claim older than the lease) →
   * SCANNING, one more attempt. Null when there is nothing to do (already treated, being treated
   * by another worker, or unknown): the job is then a no-op.
   */
  claim(documentId: string, leaseSeconds: number): Promise<ScanClaim | null>;
  /** SCANNING → CLEAN (with the derived copy for images) + `document.scan_clean`. */
  markClean(claim: ScanClaim, sanitizedStorageKey: string | null): Promise<boolean>;
  /** SCANNING → INFECTED + `document.scan_infected` (with the signature). */
  markInfected(claim: ScanClaim, signature: string): Promise<boolean>;
  /** SCANNING → SCAN_FAILED + `document.scan_failed` (no attempts left). */
  markFailed(claim: ScanClaim): Promise<boolean>;
  /** SCANNING → PENDING_SCAN: a transient error, the job will be retried. */
  release(claim: ScanClaim): Promise<boolean>;
}
