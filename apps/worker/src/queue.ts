import { DOCUMENT_SCAN_QUEUE, documentScanJobSchema } from "@legaltech/contracts";
import type { PrismaClient } from "@legaltech/database";
import { fromPrisma, PgBoss } from "pg-boss";
import { scanDocument, type ScanDocumentDeps } from "./scan/scan-document.js";

/**
 * pg-boss for the worker (DATABASE_SPEC.md, "Cola de trabajos"): consumes jobs and supervises
 * them (expiry, retention: DML only). It never runs DDL: the owner installed the schema and the
 * queue (`migrate: false` only checks the version), and index rebuilds and stats partitions
 * are off.
 */
export async function startPgBossForWorker(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString,
    migrate: false,
    schedule: false,
    supervise: true,
    persistWarnings: false,
    persistQueueStats: false,
    reindex: false,
  });
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

/**
 * Documents that need a (new) job when the worker starts, each put back in the queue in the same
 * transaction as its status: UPLOADED ones (stored before the antivirus existed) become
 * PENDING_SCAN, and SCANNING ones whose claim outlived the lease (their worker died after the job
 * ran out of retries) are queued again. A duplicate job is harmless: claims are conditional.
 */
export async function requeueUntreatedDocuments(
  prisma: PrismaClient,
  boss: PgBoss,
  leaseSeconds: number,
): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE documents SET status = 'PENDING_SCAN', scan_started_at = NULL
      WHERE status = 'UPLOADED'
         OR (status = 'SCANNING'
             AND scan_started_at < clock_timestamp() - make_interval(secs => ${leaseSeconds}))
      RETURNING id`;
    for (const { id } of rows) {
      const jobId = await boss.send(
        DOCUMENT_SCAN_QUEUE,
        { documentId: id },
        { db: fromPrisma(tx) },
      );
      if (!jobId) throw new Error("a document.scan job was not enqueued");
    }
    return rows.length;
  });
}
