import { hash, verify } from "@node-rs/argon2";

/**
 * Argon2id parameters (ADR-002). @node-rs/argon2 uses Argon2id by default, so the algorithm is
 * not passed explicitly (its `Algorithm` type is an ambient const enum that this project's
 * `isolatedModules` setting cannot reference); a test asserts the `$argon2id$` prefix.
 * Cost values follow the OWASP Password Storage Cheat Sheet baseline for Argon2id
 * (m=19 MiB, t=2, p=1); recalibrate against production hardware before launch (ADR-002).
 */
const HASH_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, HASH_OPTIONS);
}

/** Never throws: an invalid or foreign hash format is treated as "does not match". */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}
