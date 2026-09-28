import { z } from "zod";

/**
 * Worker configuration. Storage comes from `loadStorageEnv` (@legaltech/storage). The database
 * connection is the worker's own role (legaltech_worker), never the application's.
 */
const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  WORKER_DATABASE_URL: z.string().min(1),
  CLAMAV_HOST: z.string().min(1).default("127.0.0.1"),
  CLAMAV_PORT: z.coerce.number().int().min(1).max(65535).default(3310),
  // Whole-scan budget for one document (10 MB at most): connect, stream and verdict.
  CLAMAV_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(60_000),
  // Treatments started per document before it is marked SCAN_FAILED.
  SCAN_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  // A SCANNING document older than this is taken to be abandoned (its worker died) and may be
  // claimed again. Below the queue's 15-minute job expiry, so a retried job can reclaim it.
  SCAN_LEASE_SECONDS: z.coerce.number().int().min(60).max(3600).default(600),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/** Validates the worker's configuration; errors name variables and reasons, never values. */
export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = workerEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid worker configuration: ${issues}`);
  }
  return parsed.data;
}
