import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Cryptographically secure opaque token: high-entropy secret plus its stored hash. */
export interface OpaqueToken {
  raw: string;
  hash: string;
}

/** SHA-256 hex digest. Used for session tokens, CSRF tokens and email fingerprints in audit metadata. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Generates a 256-bit random token (URL-safe) and its SHA-256 hash. */
export function generateOpaqueToken(byteLength = 32): OpaqueToken {
  const raw = randomBytes(byteLength).toString("base64url");
  return { raw, hash: sha256Hex(raw) };
}

/** Constant-time comparison between a raw candidate token and a stored hash. */
export function tokenMatchesHash(raw: string, hash: string): boolean {
  const candidate = Buffer.from(sha256Hex(raw), "hex");
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
