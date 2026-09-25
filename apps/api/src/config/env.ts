import { z } from "zod";

function isBareOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Compared verbatim with the browser's Origin header (auth.origin.ts), so it must be
  // exactly a serialized origin. Rejected rather than normalized: a trailing slash or path
  // would otherwise make every same-origin check fail at runtime.
  APP_ORIGIN: z
    .string()
    .url()
    .refine(isBareOrigin, {
      message:
        "must be a bare origin (scheme://host[:port]) with no trailing slash, path, query or fragment",
    }),
  DATABASE_URL: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates and returns the runtime configuration.
 * Error messages list variable names and reasons only, never their values.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return parsed.data;
}
