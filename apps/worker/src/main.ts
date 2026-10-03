import { createPrismaClient } from "@legaltech/database";
import { loadStorageEnv, S3StorageProvider } from "@legaltech/storage";
import { ClamAvProvider } from "./antivirus/clamav.js";
import { loadWorkerEnv } from "./config.js";
import {
  startPeriodicSweep,
  startPgBossForWorker,
  sweepUntreatedDocuments,
  workDocumentReprocesses,
  workDocumentScans,
} from "./queue.js";
import { assertOcrStartupPreconditions } from "./ocr/ocr-activation.js";
import type { OcrProvider } from "./ocr/ocr-provider.js";
import {
  enqueueOcr,
  sweepAbandonedOcr,
  workDocumentOcr,
  workDocumentOcrReprocesses,
} from "./ocr/ocr-queue.js";
import { PrismaOcrRepository } from "./ocr/ocr.repository.js";
import { PrismaScanRepository } from "./scan/scan.repository.js";

/**
 * Background worker (ADR-001): the document security treatment (`document.scan`). Runs as its
 * own database role (legaltech_worker) and reaches ClamAV inside our infrastructure only.
 */
const env = loadWorkerEnv();
const storageEnv = loadStorageEnv();
const log = (event: Record<string, unknown>) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), ...event }));

const prisma = createPrismaClient(env.WORKER_DATABASE_URL);

// OCR (DATABASE_SPEC.md, "OCR del documento"): the text is stored in PostgreSQL with each result
// (OCR-A10.5), but no provider is chosen yet (decision P4), so with OCR_ENABLED=true the worker
// refuses to start. With the OCR off (the default) nothing changes for the security treatment.
const ocrProvider: OcrProvider | null = null;
if (env.OCR_ENABLED) {
  await assertOcrStartupPreconditions({
    prisma,
    provider: ocrProvider,
    pdfEnabled: env.OCR_PDF_ENABLED,
    pdfP7Resolved: env.OCR_PDF_P7_RESOLVED,
  });
}

const boss = await startPgBossForWorker(env.WORKER_DATABASE_URL);
boss.on("error", (error: Error) =>
  log({ level: "error", source: "pg-boss", message: error.message }),
);

// Recovery (DATABASE_SPEC.md): at start, then every SCAN_SWEEP_INTERVAL_SECONDS; abandoned OCR
// claims too once the OCR runs.
const sweep = async () => {
  const scan = await sweepUntreatedDocuments(prisma, boss, {
    leaseSeconds: env.SCAN_LEASE_SECONDS,
    maxAttempts: env.SCAN_MAX_ATTEMPTS,
  });
  if (!env.OCR_ENABLED || !ocrProvider) return scan;
  const ocr = await sweepAbandonedOcr(prisma, boss, {
    leaseSeconds: env.OCR_LEASE_SECONDS!,
    maxAttempts: env.OCR_MAX_ATTEMPTS!,
    engine: (ocrProvider as OcrProvider).engine,
  });
  return {
    requeued: [...scan.requeued, ...ocr.requeued],
    failed: [...scan.failed, ...ocr.failed],
  };
};
const initial = await sweep();
log({
  level: "info",
  message: "worker started",
  requeued: initial.requeued.length,
  failed: initial.failed.length,
});
const stopSweep = startPeriodicSweep(sweep, env.SCAN_SWEEP_INTERVAL_SECONDS * 1000, log);

await workDocumentScans(
  boss,
  {
    // Once the OCR is on, the antivirus result decides the OCR state in the same transaction.
    repository: new PrismaScanRepository(
      prisma,
      env.OCR_ENABLED
        ? {
            pdfEnabled: env.OCR_PDF_ENABLED,
            enqueue: (tx, documentId) => enqueueOcr(boss, tx, documentId),
          }
        : null,
    ),
    storage: new S3StorageProvider(storageEnv),
    antivirus: new ClamAvProvider({
      host: env.CLAMAV_HOST,
      port: env.CLAMAV_PORT,
      timeoutMs: env.CLAMAV_TIMEOUT_MS,
    }),
    maxAttempts: env.SCAN_MAX_ATTEMPTS,
    leaseSeconds: env.SCAN_LEASE_SECONDS,
    log,
  },
  (event) => log({ level: "info", ...event }),
);

// An ADMIN's explicit reprocessing of a SCAN_FAILED document (requested through the API).
await workDocumentReprocesses(boss, prisma, (event) => log({ level: "info", ...event }));

if (env.OCR_ENABLED && ocrProvider) {
  await workDocumentOcr(
    boss,
    {
      repository: new PrismaOcrRepository(prisma, boss),
      storage: new S3StorageProvider(storageEnv),
      provider: ocrProvider,
      imageRepresentation: env.OCR_IMAGE_REPRESENTATION!,
      // A PDF only with PDF OCR on and, if the provider is external, P7 resolved (OCR-A7).
      pdfAllowed:
        env.OCR_PDF_ENABLED && (!(ocrProvider as OcrProvider).external || env.OCR_PDF_P7_RESOLVED),
      maxAttempts: env.OCR_MAX_ATTEMPTS!,
      leaseSeconds: env.OCR_LEASE_SECONDS!,
      maxPages: env.OCR_MAX_PAGES!,
      retryDelaySeconds: env.OCR_RETRY_DELAY_SECONDS!,
      log,
    },
    (event) => log({ level: "info", ...event }),
  );
  // An ADMIN's explicit reprocessing of a document whose OCR is FAILED.
  await workDocumentOcrReprocesses(boss, prisma, (event) => log({ level: "info", ...event }));
}

async function shutdown(signal: string): Promise<void> {
  log({ level: "info", message: "shutting down", signal });
  stopSweep();
  await boss.stop({ graceful: true });
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
