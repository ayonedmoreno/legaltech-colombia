import {
  DOCUMENT_OCR_REPROCESS_QUEUE,
  DOCUMENT_REPROCESS_QUEUE,
  DOCUMENT_SCAN_QUEUE,
  type DocumentOcrReprocessJob,
  type DocumentReprocessJob,
  type DocumentScanJob,
} from "@legaltech/contracts";
import { PgBoss } from "pg-boss";

/**
 * A SQL executor bound to the caller's open transaction: a job enqueued through it is committed or
 * rolled back together with the caller's own writes (pg-boss `send` with `db`).
 */
export interface TransactionSql {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/**
 * The job queue as the API sees it (ADR-001: pg-boss behind a `JobQueue` interface). The API only
 * enqueues; the worker (apps/worker) consumes.
 */
export interface JobQueue {
  /** Enqueues the security treatment of a document inside the caller's transaction. */
  enqueueDocumentScan(documentId: string, tx: TransactionSql): Promise<void>;
  /** Enqueues an ADMIN's reprocessing of a SCAN_FAILED document inside the caller's transaction. */
  enqueueDocumentReprocess(documentId: string, tx: TransactionSql): Promise<void>;
  /** Enqueues an ADMIN's reprocessing of a FAILED OCR inside the caller's transaction. */
  enqueueDocumentOcrReprocess(documentId: string, tx: TransactionSql): Promise<void>;
}

/**
 * pg-boss started for enqueueing only (DATABASE_SPEC.md, "Cola de trabajos"): it never runs DDL
 * (`migrate: false` only checks the schema version the owner installed), never supervises or
 * schedules, and persists nothing but jobs.
 */
export async function startPgBossForApi(connectionString: string): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString,
    migrate: false,
    supervise: false,
    schedule: false,
    persistWarnings: false,
    reindex: false,
  });
  await boss.start();
  return boss;
}

export class PgBossJobQueue implements JobQueue {
  constructor(private readonly boss: PgBoss) {}

  async enqueueDocumentScan(documentId: string, tx: TransactionSql): Promise<void> {
    const job: DocumentScanJob = { documentId };
    const id = await this.boss.send(DOCUMENT_SCAN_QUEUE, job, { db: tx });
    if (!id) throw new Error("the document.scan job was not enqueued");
  }

  async enqueueDocumentReprocess(documentId: string, tx: TransactionSql): Promise<void> {
    const job: DocumentReprocessJob = { documentId };
    const id = await this.boss.send(DOCUMENT_REPROCESS_QUEUE, job, { db: tx });
    if (!id) throw new Error("the document.reprocess job was not enqueued");
  }

  async enqueueDocumentOcrReprocess(documentId: string, tx: TransactionSql): Promise<void> {
    const job: DocumentOcrReprocessJob = { documentId };
    const id = await this.boss.send(DOCUMENT_OCR_REPROCESS_QUEUE, job, { db: tx });
    if (!id) throw new Error("the document.ocr_reprocess job was not enqueued");
  }
}
