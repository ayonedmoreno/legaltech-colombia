import type { Prisma, PrismaClient } from "@legaltech/database";
import type { ScanClaim, ScanRepository } from "./scan.types.js";

type Tx = Prisma.TransactionClient;

/**
 * The OCR as the security treatment sees it once activated (decision OCR-A11, point 1): the
 * document's OCR state is written in the same transaction as the antivirus result, so a CLEAN
 * document never exists with an undecided OCR state. Absent (the default) while the OCR is off:
 * the OCR state then stays NOT_STARTED, and the activation script resolves it later.
 */
export interface ScanOcrActivation {
  /** Whether a CLEAN PDF enters the OCR (decision OCR-A7); otherwise it is EXCLUDED. */
  pdfEnabled: boolean;
  /** Enqueues the document's `document.ocr` job inside the caller's transaction. */
  enqueue(tx: Tx, documentId: string): Promise<void>;
}

interface ClaimRow {
  id: string;
  case_id: string;
  file_type: ScanClaim["fileType"];
  storage_key: string;
  file_size: number;
  scan_attempts: number;
  token: string;
}

/**
 * Prisma-backed ScanRepository, as the worker role: SELECT on documents, UPDATE on its scan
 * columns only, and INSERT (without RETURNING: it cannot read) on audit_logs.
 */
export class PrismaScanRepository implements ScanRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ocr: ScanOcrActivation | null = null,
  ) {}

  async claim(documentId: string, leaseSeconds: number): Promise<ScanClaim | null> {
    // One conditional statement: two workers cannot both claim the same document.
    const [row] = await this.prisma.$queryRaw<ClaimRow[]>`
      UPDATE documents
      SET status = 'SCANNING',
          scan_attempts = scan_attempts + 1,
          scan_started_at = clock_timestamp()
      WHERE id = ${documentId}::uuid
        AND (
          status = 'PENDING_SCAN'
          OR (status = 'SCANNING'
              AND scan_started_at < clock_timestamp() - make_interval(secs => ${leaseSeconds}))
        )
      RETURNING id, case_id, file_type, storage_key, file_size, scan_attempts,
                scan_started_at::text AS token`;
    if (!row) return null;
    return {
      documentId: row.id,
      caseId: row.case_id,
      fileType: row.file_type,
      storageKey: row.storage_key,
      fileSize: row.file_size,
      attempts: row.scan_attempts,
      token: row.token,
    };
  }

  async markClean(claim: ScanClaim, sanitizedStorageKey: string | null): Promise<boolean> {
    return this.finish(
      claim,
      "CLEAN",
      "document.scan_clean",
      { status: "CLEAN" },
      {
        sanitizedStorageKey,
      },
    );
  }

  async markInfected(claim: ScanClaim, signature: string): Promise<boolean> {
    return this.finish(
      claim,
      "INFECTED",
      "document.scan_infected",
      { status: "INFECTED", signature },
      { signature },
    );
  }

  async markFailed(claim: ScanClaim): Promise<boolean> {
    return this.finish(claim, "SCAN_FAILED", "document.scan_failed", {
      status: "SCAN_FAILED",
      attempts: claim.attempts,
    });
  }

  async release(claim: ScanClaim): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE documents SET status = 'PENDING_SCAN', scan_started_at = NULL
      WHERE id = ${claim.documentId}::uuid
        AND status = 'SCANNING'
        AND scan_started_at = ${claim.token}::timestamptz`;
    return count === 1;
  }

  /**
   * Records a final result and its audit event in one transaction, at one PostgreSQL instant,
   * only while the claim is still ours (status SCANNING and the same scan_started_at).
   */
  private async finish(
    claim: ScanClaim,
    status: "CLEAN" | "INFECTED" | "SCAN_FAILED",
    action: string,
    newValue: Record<string, unknown>,
    extra: { sanitizedStorageKey?: string | null; signature?: string } = {},
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx: Tx) => {
      const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const now = clock!.now;
      const ocrStatus = this.ocrStatusFor(claim, status);
      const count = ocrStatus
        ? await tx.$executeRaw`
            UPDATE documents
            SET status = ${status}::document_status,
                scanned_at = ${now},
                scan_signature = ${extra.signature ?? null},
                sanitized_storage_key = ${extra.sanitizedStorageKey ?? null},
                ocr_status = ${ocrStatus}::document_ocr_status
            WHERE id = ${claim.documentId}::uuid
              AND status = 'SCANNING'
              AND scan_started_at = ${claim.token}::timestamptz`
        : await tx.$executeRaw`
            UPDATE documents
            SET status = ${status}::document_status,
                scanned_at = ${now},
                scan_signature = ${extra.signature ?? null},
                sanitized_storage_key = ${extra.sanitizedStorageKey ?? null}
            WHERE id = ${claim.documentId}::uuid
              AND status = 'SCANNING'
              AND scan_started_at = ${claim.token}::timestamptz`;
      if (count !== 1) return false;
      // A CLEAN document in the OCR's scope gets its job with its result (decision OCR-A11).
      if (ocrStatus === "PENDING") await this.ocr!.enqueue(tx, claim.documentId);
      // The system acts: no actor. Never the file name (personal data stays out of audit).
      await tx.$executeRaw`
        INSERT INTO audit_logs (action, entity_type, entity_id, case_id, new_value, occurred_at)
        VALUES (${action}, 'Document', ${claim.documentId}, ${claim.caseId}::uuid,
                ${JSON.stringify(newValue)}::jsonb, ${now})`;
      return true;
    });
  }

  /**
   * The OCR state a result implies once the OCR is active (decisions OCR-A6, OCR-A7, OCR-A10.2):
   * CLEAN → PENDING, or EXCLUDED for a PDF the OCR may not process; INFECTED → NOT_APPLICABLE;
   * SCAN_FAILED leaves it NOT_STARTED (a reprocessing may still make the document CLEAN). Null
   * while the OCR is off, or when the state does not change.
   */
  private ocrStatusFor(
    claim: ScanClaim,
    status: "CLEAN" | "INFECTED" | "SCAN_FAILED",
  ): "PENDING" | "EXCLUDED" | "NOT_APPLICABLE" | null {
    if (!this.ocr) return null;
    if (status === "INFECTED") return "NOT_APPLICABLE";
    if (status !== "CLEAN") return null;
    return claim.fileType === "PDF" && !this.ocr.pdfEnabled ? "EXCLUDED" : "PENDING";
  }
}
