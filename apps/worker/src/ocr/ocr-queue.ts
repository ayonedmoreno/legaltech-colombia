import { randomUUID } from "node:crypto";
import {
  DOCUMENT_OCR_QUEUE,
  DOCUMENT_OCR_REPROCESS_QUEUE,
  documentOcrJobSchema,
  documentOcrReprocessJobSchema,
  type DocumentOcrJob,
} from "@legaltech/contracts";
import type { Prisma, PrismaClient } from "@legaltech/database";
import { fromPrisma, type PgBoss } from "pg-boss";
import { ocrDocument, type OcrDocumentDeps } from "./ocr-document.js";

type Tx = Prisma.TransactionClient;

/** Enqueues a document's `document.ocr` job inside the caller's transaction. */
export async function enqueueOcr(boss: PgBoss, tx: Tx, documentId: string): Promise<void> {
  const job: DocumentOcrJob = { documentId };
  const jobId = await boss.send(DOCUMENT_OCR_QUEUE, job, { db: fromPrisma(tx) });
  if (!jobId) throw new Error("a document.ocr job was not enqueued");
}

/** Registers the document.ocr handler. A job whose payload is not a document id fails for good. */
export async function workDocumentOcr(
  boss: PgBoss,
  deps: OcrDocumentDeps,
  log: (event: Record<string, unknown>) => void,
  options: { pollingIntervalSeconds?: number } = {},
): Promise<void> {
  await boss.work(
    DOCUMENT_OCR_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2 },
    async ([job]) => {
      const payload = documentOcrJobSchema.safeParse(job!.data);
      if (!payload.success) throw new Error("invalid document.ocr payload");
      const outcome = await ocrDocument(deps, payload.data.documentId);
      // Ids only: never a file name, content or text in the logs.
      log({ job: job!.id, document: payload.data.documentId, ocr: outcome });
    },
  );
}

export interface OcrSweepOptions {
  /** A PROCESSING claim older than this is abandoned (its worker died). */
  leaseSeconds: number;
  /** OCR executions started per document; an abandoned claim at this count ends FAILED. */
  maxAttempts: number;
  /** The engine recorded on the OcrResult of an abandoned execution. */
  engine: string;
}

export interface OcrSweepResult {
  requeued: string[];
  failed: string[];
}

/**
 * Recovery of abandoned OCR claims (DATABASE_SPEC.md, "OCR del documento"), as for the security
 * treatment: a PROCESSING document whose claim outlived the lease goes back to PENDING with a new
 * job while attempts are left, or ends FAILED with its OcrResult (code `abandoned`) and its
 * `document.ocr_failed` event. Rows are locked with SKIP LOCKED and the condition is checked again
 * on the locked row, so several workers sweeping at once act on each document once.
 */
export async function sweepAbandonedOcr(
  prisma: PrismaClient,
  boss: PgBoss,
  options: OcrSweepOptions,
): Promise<OcrSweepResult> {
  return prisma.$transaction(async (tx) => {
    const abandoned = await tx.$queryRaw<
      Array<{ id: string; case_id: string; ocr_attempts: number; token: string; now: Date }>
    >`
      SELECT id, case_id, ocr_attempts, ocr_started_at::text AS token, clock_timestamp() AS now
      FROM documents
      WHERE ocr_status = 'PROCESSING'
        AND ocr_started_at < clock_timestamp() - make_interval(secs => ${options.leaseSeconds})
      FOR UPDATE SKIP LOCKED`;

    const requeued: string[] = [];
    const failed: string[] = [];
    for (const row of abandoned) {
      if (row.ocr_attempts >= options.maxAttempts) {
        await tx.$executeRaw`
          UPDATE documents SET ocr_status = 'FAILED' WHERE id = ${row.id}::uuid`;
        await tx.$executeRaw`
          INSERT INTO ocr_results (id, document_id, outcome, engine, attempts, started_at,
                                   finished_at, error_code)
          VALUES (${randomUUID()}::uuid, ${row.id}::uuid, 'FAILED', ${options.engine},
                  ${row.ocr_attempts}, ${row.token}::timestamptz, ${row.now}, 'abandoned')`;
        // The system acts: no actor. Never the file name nor any text.
        await tx.$executeRaw`
          INSERT INTO audit_logs (action, entity_type, entity_id, case_id, new_value, occurred_at)
          VALUES ('document.ocr_failed', 'Document', ${row.id}, ${row.case_id}::uuid,
                  ${JSON.stringify({ status: "FAILED", code: "abandoned", attempts: row.ocr_attempts })}::jsonb,
                  ${row.now})`;
        failed.push(row.id);
      } else {
        await tx.$executeRaw`
          UPDATE documents SET ocr_status = 'PENDING', ocr_started_at = NULL
          WHERE id = ${row.id}::uuid`;
        await enqueueOcr(boss, tx, row.id);
        requeued.push(row.id);
      }
    }
    return { requeued, failed };
  });
}

/**
 * An ADMIN's explicit OCR reprocessing (decision OCR-A11, point 5; as DEC-16 for the antivirus):
 * in one transaction, a CLEAN document whose OCR is still FAILED goes back to PENDING with a new
 * round of attempts, a `document.ocr` job and its `document.ocr_reprocessed` event. Any other
 * state changes nothing. The row is locked and its state checked again on the locked row, so
 * concurrent reprocessings act once. It never reads or returns any text.
 */
export async function reprocessOcr(
  prisma: PrismaClient,
  boss: PgBoss,
  documentId: string,
): Promise<"reprocessed" | "skipped"> {
  return prisma.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<
      Array<{ id: string; case_id: string; previous_attempts: number; now: Date }>
    >`
      WITH target AS (
        SELECT id, case_id, ocr_attempts FROM documents
        WHERE id = ${documentId}::uuid AND status = 'CLEAN' AND ocr_status = 'FAILED'
        FOR UPDATE)
      UPDATE documents d
      SET ocr_status = 'PENDING', ocr_attempts = 0, ocr_started_at = NULL
      FROM target t
      WHERE d.id = t.id
      RETURNING d.id, t.case_id, t.ocr_attempts AS previous_attempts, clock_timestamp() AS now`;
    if (!row) return "skipped";

    await enqueueOcr(boss, tx, row.id);
    // The system acts (the ADMIN's request was audited by the API). Never any text.
    await tx.$executeRaw`
      INSERT INTO audit_logs (action, entity_type, entity_id, case_id, new_value, occurred_at)
      VALUES ('document.ocr_reprocessed', 'Document', ${row.id}, ${row.case_id}::uuid,
              ${JSON.stringify({ status: "PENDING", previousAttempts: row.previous_attempts })}::jsonb,
              ${row.now})`;
    return "reprocessed";
  });
}

/** Registers the document.ocr_reprocess handler. A payload that is not a document id fails. */
export async function workDocumentOcrReprocesses(
  boss: PgBoss,
  prisma: PrismaClient,
  log: (event: Record<string, unknown>) => void,
  options: { pollingIntervalSeconds?: number } = {},
): Promise<void> {
  await boss.work(
    DOCUMENT_OCR_REPROCESS_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2 },
    async ([job]) => {
      const payload = documentOcrReprocessJobSchema.safeParse(job!.data);
      if (!payload.success) throw new Error("invalid document.ocr_reprocess payload");
      const outcome = await reprocessOcr(prisma, boss, payload.data.documentId);
      log({ job: job!.id, document: payload.data.documentId, ocrReprocess: outcome });
    },
  );
}
