import { createPrismaClient } from "@legaltech/database";
import { loadStorageEnv, S3StorageProvider } from "@legaltech/storage";
import { ClamAvProvider } from "./antivirus/clamav.js";
import { loadWorkerEnv } from "./config.js";
import { requeueUntreatedDocuments, startPgBossForWorker, workDocumentScans } from "./queue.js";
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
const boss = await startPgBossForWorker(env.WORKER_DATABASE_URL);
boss.on("error", (error: Error) =>
  log({ level: "error", source: "pg-boss", message: error.message }),
);

const requeued = await requeueUntreatedDocuments(prisma, boss, env.SCAN_LEASE_SECONDS);
log({ level: "info", message: "worker started", requeued });

await workDocumentScans(
  boss,
  {
    repository: new PrismaScanRepository(prisma),
    storage: new S3StorageProvider(storageEnv),
    antivirus: new ClamAvProvider({
      host: env.CLAMAV_HOST,
      port: env.CLAMAV_PORT,
      timeoutMs: env.CLAMAV_TIMEOUT_MS,
    }),
    maxAttempts: env.SCAN_MAX_ATTEMPTS,
    leaseSeconds: env.SCAN_LEASE_SECONDS,
  },
  (event) => log({ level: "info", ...event }),
);

async function shutdown(signal: string): Promise<void> {
  log({ level: "info", message: "shutting down", signal });
  await boss.stop({ graceful: true });
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
