import type { PrismaClient } from "@legaltech/database";
import type { OcrProvider } from "./ocr-provider.js";

export interface OcrActivationResult {
  /** CLEAN documents that predate the activation: EXCLUDED (no backfill; decision OCR-A6). */
  excluded: number;
  /** INFECTED documents: NOT_APPLICABLE (definitive). */
  notApplicable: number;
}

/**
 * The OCR activation (decisions OCR-A11 and OCR-A12): an explicit step of the owner, never a
 * migration, run with the worker stopped. Only rows still NOT_STARTED change: CLEAN → EXCLUDED,
 * INFECTED → NOT_APPLICABLE; SCAN_FAILED, PENDING_SCAN, SCANNING and UPLOADED stay NOT_STARTED
 * (they may still reach CLEAN, and then enter the OCR by the normal path). The invariant is checked
 * in the same transaction: if it does not hold, nothing is committed.
 */
export async function activateOcr(prisma: PrismaClient): Promise<OcrActivationResult> {
  return prisma.$transaction(async (tx) => {
    const excluded = await tx.$executeRaw`
      UPDATE documents SET ocr_status = 'EXCLUDED'
      WHERE status = 'CLEAN' AND ocr_status = 'NOT_STARTED'`;
    const notApplicable = await tx.$executeRaw`
      UPDATE documents SET ocr_status = 'NOT_APPLICABLE'
      WHERE status = 'INFECTED' AND ocr_status = 'NOT_STARTED'`;
    const violations = await countViolations(tx);
    if (violations > 0) {
      throw new Error(`OCR activation invariant does not hold (${violations} documents)`);
    }
    return { excluded, notApplicable };
  });
}

/**
 * The activation invariant (decision OCR-A12): with the OCR active, no CLEAN document is left with
 * ocr_status NOT_STARTED. Returns how many documents break it.
 */
export async function countOcrInvariantViolations(prisma: PrismaClient): Promise<number> {
  return countViolations(prisma);
}

async function countViolations(db: Pick<PrismaClient, "$queryRaw">): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count FROM documents
    WHERE status = 'CLEAN' AND ocr_status = 'NOT_STARTED'`;
  return Number(row!.count);
}

export interface OcrStartupCheck {
  prisma: PrismaClient;
  provider: OcrProvider | null;
  pdfEnabled: boolean;
  /** Whether P7 (PDF metadata) is resolved, so a PDF may go to an external provider. */
  pdfP7Resolved: boolean;
}

/**
 * What must hold before a worker runs the OCR. Each failure stops the worker with a reason that
 * names the missing decision or condition, never any document data.
 */
export async function assertOcrStartupPreconditions(check: OcrStartupCheck): Promise<void> {
  if (!check.provider) {
    throw new Error("OCR cannot start: no OCR provider is configured (decision P4 is open)");
  }
  // A PDF never goes to a third party before P7 is resolved (decision OCR-A7).
  if (check.pdfEnabled && check.provider.external && !check.pdfP7Resolved) {
    throw new Error(
      "OCR cannot start: PDF OCR with an external provider requires P7 to be resolved",
    );
  }
  const violations = await countOcrInvariantViolations(check.prisma);
  if (violations > 0) {
    throw new Error(
      `OCR cannot start: ${violations} CLEAN documents have ocr_status NOT_STARTED; run the OCR activation first`,
    );
  }
}
