import { z } from "zod";

/**
 * Worker configuration. Storage comes from `loadStorageEnv` (@legaltech/storage). The database
 * connection is the worker's own role (legaltech_worker), never the application's.
 */
// Custom messages: an error names the variable and the reason, never the value received.
const flag = z
  .enum(["true", "false"], { errorMap: () => ({ message: "must be true or false" }) })
  .default("false")
  .transform((value) => value === "true");

/**
 * Values that come from the OCR provider evaluation (B5, B6, B7; docs/ocr-provider-evaluation.md):
 * no defaults. They are required only when the OCR is enabled.
 */
const OCR_REQUIRED = [
  "OCR_IMAGE_REPRESENTATION",
  "OCR_MAX_ATTEMPTS",
  "OCR_LEASE_SECONDS",
  "OCR_RETRY_DELAY_SECONDS",
  "OCR_MAX_PAGES",
] as const;

const workerEnvSchema = z
  .object({
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
    // How often the worker sweeps for abandoned claims and documents without a job.
    SCAN_SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
    // OCR (DATABASE_SPEC.md, "OCR del documento"): off by default. Turning it on is an explicit,
    // recorded step that follows the activation procedure (decisions OCR-A11 and OCR-A12).
    OCR_ENABLED: flag,
    // PDF OCR is off by default (decision OCR-A7); with an external provider it also needs P7.
    OCR_PDF_ENABLED: flag,
    OCR_PDF_P7_RESOLVED: flag,
    // Which representation of a JPEG or PNG the OCR processes (decision B3).
    OCR_IMAGE_REPRESENTATION: z
      .enum(["ORIGINAL", "SANITIZED"], {
        errorMap: () => ({ message: "must be ORIGINAL or SANITIZED" }),
      })
      .optional(),
    OCR_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).optional(),
    OCR_LEASE_SECONDS: z.coerce.number().int().min(60).max(3600).optional(),
    OCR_RETRY_DELAY_SECONDS: z.coerce.number().int().min(1).max(3600).optional(),
    OCR_MAX_PAGES: z.coerce.number().int().min(1).max(2000).optional(),
  })
  .superRefine((env, ctx) => {
    if (!env.OCR_ENABLED) return;
    for (const name of OCR_REQUIRED) {
      if (env[name] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: "required when OCR_ENABLED=true (set from the provider evaluation)",
        });
      }
    }
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
