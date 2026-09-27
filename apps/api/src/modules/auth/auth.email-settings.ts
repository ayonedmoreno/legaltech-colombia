/**
 * Values for the Sprint 1B email flows (decisions P4 and P5).
 *
 * Approved on 2026-09-27 as the definitive values (ADR-002 asks for "expiración corta" and a
 * progressive delay, without numbers). Kept here, in one place; API_SPEC.md shows the same values.
 */
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** P4a: how long an email verification link stays valid. */
export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * HOUR_MS;

/** P5a: per-IP limit of `POST /api/auth/email/verification/resend` (like registration). */
export const RESEND_IP_LIMIT = { max: 5, windowMs: 10 * MINUTE_MS } as const;

/**
 * P5a: per-account limit of the resend, with the progressive delay ADR-002 requires ("retardo
 * progresivo"), in the form D3 uses for login: with F verification emails for the user in the
 * window and F >= `free`, the next one must wait min(base · 2^(F − free), cap) from the latest.
 * The initial email sent at registration counts as one of them.
 */
export const RESEND_ACCOUNT_LIMIT = {
  free: 3,
  windowMs: 24 * HOUR_MS,
  baseDelayMs: 30 * 1000,
  capDelayMs: 15 * MINUTE_MS,
} as const;

/**
 * Time still to wait under a progressive delay (0 or less: allowed). `count` events in the
 * window, the latest at `lastAt`; with fewer than `free`, nothing to wait.
 */
export function remainingProgressiveDelayMs(
  count: number,
  lastAt: Date | null,
  now: Date,
  limit: { free: number; baseDelayMs: number; capDelayMs: number },
): number {
  if (count < limit.free || lastAt === null) return 0;
  const delayMs = Math.min(limit.baseDelayMs * 2 ** (count - limit.free), limit.capDelayMs);
  return lastAt.getTime() + delayMs - now.getTime();
}

/** P4b: how long a password reset link stays valid. */
export const PASSWORD_RESET_TOKEN_TTL_MS = 30 * MINUTE_MS;

/** P5b: per-IP limit of `POST /api/auth/password/forgot` (like registration). */
export const FORGOT_IP_LIMIT = { max: 5, windowMs: 10 * MINUTE_MS } as const;

/**
 * P5b: per-email limit of the reset request, with ADR-002's progressive delay, counted like the
 * login limit (D3): `auth.password.reset_requested` events for the email hash, so an unknown
 * address is limited exactly like a registered one and the answer reveals nothing.
 */
export const FORGOT_EMAIL_LIMIT = {
  free: 3,
  windowMs: 24 * HOUR_MS,
  baseDelayMs: 30 * 1000,
  capDelayMs: 15 * MINUTE_MS,
} as const;

/**
 * P5c: per-IP limit of `POST /api/auth/password/reset`. Every request hashes the new password
 * with Argon2id before the token is checked, so the endpoint is limited like the forgot request.
 */
export const RESET_IP_LIMIT = { max: 5, windowMs: 10 * MINUTE_MS } as const;
