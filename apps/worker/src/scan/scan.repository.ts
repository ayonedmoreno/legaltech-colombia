import type { Prisma, PrismaClient } from "@legaltech/database";
import type { ScanClaim, ScanRepository } from "./scan.types.js";

type Tx = Prisma.TransactionClient;

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
  constructor(private readonly prisma: PrismaClient) {}

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
      const count = await tx.$executeRaw`
        UPDATE documents
        SET status = ${status}::document_status,
            scanned_at = ${now},
            scan_signature = ${extra.signature ?? null},
            sanitized_storage_key = ${extra.sanitizedStorageKey ?? null}
        WHERE id = ${claim.documentId}::uuid
          AND status = 'SCANNING'
          AND scan_started_at = ${claim.token}::timestamptz`;
      if (count !== 1) return false;
      // The system acts: no actor. Never the file name (personal data stays out of audit).
      await tx.$executeRaw`
        INSERT INTO audit_logs (action, entity_type, entity_id, case_id, new_value, occurred_at)
        VALUES (${action}, 'Document', ${claim.documentId}, ${claim.caseId}::uuid,
                ${JSON.stringify(newValue)}::jsonb, ${now})`;
      return true;
    });
  }
}
