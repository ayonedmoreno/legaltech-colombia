import { isIP } from "node:net";
import { z } from "zod";

function isBareOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

/** A single IP address or a CIDR range (`10.0.0.0/8`, `fd00::/8`); no presets or wildcards. */
function isIpOrCidr(entry: string): boolean {
  const [address, prefix, ...rest] = entry.split("/");
  const family = isIP(address ?? "");
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Compared verbatim with the browser's Origin header (auth.origin.ts), so it must be
  // exactly a serialized origin. Rejected rather than normalized: a trailing slash or path
  // would otherwise make every same-origin check fail at runtime.
  APP_ORIGIN: z.string().url().refine(isBareOrigin, {
    message:
      "must be a bare origin (scheme://host[:port]) with no trailing slash, path, query or fragment",
  }),
  DATABASE_URL: z.string().min(1),
  // Addresses of reverse proxies whose X-Forwarded-For the API may trust (comma-separated IPs
  // or CIDRs). Empty by default: request.ip is then always the TCP peer. The Next.js rewrite
  // (ADR-002) neither adds the client IP nor strips a client-sent X-Forwarded-For, so trusting
  // it alone would let any client pick its own IP. Only set this once an edge proxy that sets
  // X-Forwarded-For sits in front of the web app (deployment topology, P3).
  API_TRUST_PROXY: z
    .string()
    .default("")
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    .refine((entries) => entries.every(isIpOrCidr), {
      message: "must be a comma-separated list of IP addresses or CIDR ranges",
    }),
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
