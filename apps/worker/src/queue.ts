import { DOCUMENT_SCAN_QUEUE, documentScanJobSchema } from "@legaltech/contracts";
import type { PrismaClient } from "@legaltech/database";
import { fromPrisma, PgBoss } from "pg-boss";
import { scanDocument, type ScanDocumentDeps } from "./scan/scan-document.js";

/**
 * pg-boss for the worker (DATABASE_SPEC.md, "Cola de trabajos"): consumes jobs and supervises
 * them (expiry, retention: DML only). It never runs DDL: the owner installed the schema and the
 * queue (`migrate: false` only checks the version), and index rebuilds and stats partitions
 * are off. Cron (`schedule`) and persisted warnings are off too: the role has no privileges on
 * their tables (migration worker_pgboss_least_privilege).
 */
export const WORKER_BOSS_OPTIONS = {
  migrate: false,
  schedule: false,
  supervise: true,
  persistWarnings: false,
  persistQueueStats: false,
  reindex: false,
} as const;

export async function startPgBossForWorker(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString, ...WORKER_BOSS_OPTIONS });
  await boss.start();
  return boss;
}

/** Registers the document.scan handler. A job whose payload is not a document id fails for good. */
export async function workDocumentScans(
  boss: PgBoss,
  deps: ScanDocumentDeps,
  log: (event: Record<string, unknown>) => void,
  options: { pollingIntervalSeconds?: number } = {},
): Promise<void> {
  await boss.work(
    DOCUMENT_SCAN_QUEUE,
    { batchSize: 1, pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2 },
    async ([job]) => {
      const payload = documentScanJobSchema.safeParse(job!.data);
      if (!payload.success) throw new Error("invalid document.scan payload");
      const outcome = await scanDocument(deps, payload.data.documentId);
      // Ids only: never a file name or content in the logs.
      log({ job: job!.id, document: payload.data.documentId, outcome });
    },
  );
}

export interface SweepOptions {
  /** A SCANNING claim older than this is abandoned (its worker died). */
  leaseSeconds: number;
  /** Treatments started per document; an abandoned claim at this count ends SCAN_FAILED. */
  maxAttempts: number;
}

export interface SweepResult {
  /** Documents put back in PENDING_SCAN with a new job. */
  requeued: string[];
  /** Abandoned claims with no attempts left, now SCAN_FAILED. */
  failed: string[];
}

/**
 * Recovery of documents whose job can no longer move them (DATABASE_SPEC.md, "Tratamiento de
 * seguridad del documento"): run when the worker starts and then periodically. In one transaction:
 * - a SCANNING document whose claim outlived the lease and used up its attempts ends SCAN_FAILED,
 *   with its `document.scan_failed` event (a file that kills the worker is not retried forever);
 * - an UPLOADED document (stored before the antivirus existed), or an abandoned SCANNING one with
 *   attempts left, goes back to PENDING_SCAN with a new job.
 * Rows are locked with SKIP LOCKED and the condition is checked again on the locked row, so
 * several workers sweeping at once act on each document once and never wait on each other; a
 * worker still holding an old claim can no longer record a result (its token is gone).
 * A duplicate job is harmless: claims are conditional too. It is job recovery, not a Case change.
 */
export async function sweepUntreatedDocuments(
  prisma: PrismaClient,
  boss: PgBoss,
  options: SweepOptions,
): Promise<SweepResult> {
  return prisma.$transaction(async (tx) => {
    const failed = await tx.$queryRaw<
      Array<{ id: string; case_id: string; scan_attempts: number; scanned_at: Date }>
    >`
      UPDATE documents SET status = 'SCAN_FAILED', scanned_at = clock_timestamp()
      WHERE id IN (
        SELECT id FROM documents
        WHERE status = 'SCANNING'
          AND scan_started_at < clock_timestamp() - make_interval(secs => ${options.leaseSeconds})
          AND scan_attempts >= ${options.maxAttempts}
        FOR UPDATE SKIP LOCKED)
      RETURNING id, case_id, scan_attempts, scanned_at`;
    for (const row of failed) {
      // The system acts: no actor. Never the file name (personal data stays out of audit).
      await tx.$executeRaw`
        INSERT INTO audit_logs (action, entity_type, entity_id, case_id, new_value, occurred_at)
        VALUES ('document.scan_failed', 'Document', ${row.id}, ${row.case_id}::uuid,
                ${JSON.stringify({ status: "SCAN_FAILED", attempts: row.scan_attempts })}::jsonb,
                ${row.scanned_at})`;
    }

    const requeued = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE documents SET status = 'PENDING_SCAN', scan_started_at = NULL
      WHERE id IN (
        SELECT id FROM documents
        WHERE status = 'UPLOADED'
           OR (status = 'SCANNING'
               AND scan_started_at < clock_timestamp() - make_interval(secs => ${options.leaseSeconds})
               AND scan_attempts < ${options.maxAttempts})
        FOR UPDATE SKIP LOCKED)
      RETURNING id`;
    for (const { id } of requeued) {
      const jobId = await boss.send(
        DOCUMENT_SCAN_QUEUE,
        { documentId: id },
        { db: fromPrisma(tx) },
      );
      if (!jobId) throw new Error("a document.scan job was not enqueued");
    }
    return { requeued: requeued.map((row) => row.id), failed: failed.map((row) => row.id) };
  });
}

/**
 * Runs `sweep` every `intervalMs`, never two at once (a slow sweep skips the next tick). A failed
 * sweep is logged and the next tick tries again. Returns a function that stops it.
 */
export function startPeriodicSweep(
  sweep: () => Promise<SweepResult>,
  intervalMs: number,
  log: (event: Record<string, unknown>) => void,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sweep()
      .then(({ requeued, failed }) => {
        if (requeued.length || failed.length) {
          log({
            level: "info",
            message: "sweep",
            requeued: requeued.length,
            failed: failed.length,
          });
        }
      })
      .catch((error: unknown) =>
        log({
          level: "error",
          message: "sweep failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
