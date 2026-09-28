import { z } from "zod";

/**
 * Object storage configuration (ADR-001 point 8). Separate from the main environment so the
 * test suite, which uses an in-memory storage, does not need it; the API refuses to start
 * without it. The production provider and region are pending (P3): only these values change.
 */
const storageEnvSchema = z
  .object({
    STORAGE_BUCKET: z.string().min(1),
    STORAGE_REGION: z.string().min(1).default("us-east-1"),
    // S3-compatible endpoint (SeaweedFS in development). Omitted for AWS S3.
    STORAGE_ENDPOINT: z.string().url().optional(),
    // Endpoint the browser uses to download (presigned URLs); defaults to STORAGE_ENDPOINT.
    STORAGE_PUBLIC_ENDPOINT: z.string().url().optional(),
    STORAGE_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
    // Both or neither: without them the SDK's default credential chain applies (e.g. a role).
    STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  })
  .refine((env) => Boolean(env.STORAGE_ACCESS_KEY_ID) === Boolean(env.STORAGE_SECRET_ACCESS_KEY), {
    message: "STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY must be set together",
    path: ["STORAGE_ACCESS_KEY_ID"],
  });

export type StorageEnv = z.infer<typeof storageEnvSchema>;

/** Validates the storage configuration; errors name variables and reasons, never values. */
export function loadStorageEnv(source: NodeJS.ProcessEnv = process.env): StorageEnv {
  const parsed = storageEnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid storage configuration: ${issues}`);
  }
  return parsed.data;
}
