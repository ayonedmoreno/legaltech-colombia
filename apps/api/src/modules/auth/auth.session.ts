import type { Role } from "@legaltech/database";
import { generateOpaqueToken, sha256Hex, tokenMatchesHash } from "../../security/crypto.js";
import type { AuthRepository, SessionRecord, UserRecord } from "./auth.types.js";

/** A function that returns the current time. Injected so tests can control expiry deterministically. */
export type Clock = () => Date;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Session durations by role (ADR-002: "valores iniciales propuestos, a confirmar").
 * Internal roles get shorter sessions because their accounts carry more privilege.
 */
const SESSION_DURATIONS: Record<Role, { idleMs: number; absoluteMs: number }> = {
  USER: { idleMs: 7 * DAY_MS, absoluteMs: 30 * DAY_MS },
  PROFESSIONAL: { idleMs: 1 * DAY_MS, absoluteMs: 7 * DAY_MS },
  ADMIN: { idleMs: 1 * DAY_MS, absoluteMs: 7 * DAY_MS },
  SUPER_ADMIN: { idleMs: 12 * HOUR_MS, absoluteMs: 3 * DAY_MS },
};

export interface CreatedSession {
  session: SessionRecord;
  sessionRaw: string;
  csrfRaw: string;
}

export interface LoadedSession {
  session: SessionRecord;
}

export async function createSessionForUser(
  repository: AuthRepository,
  user: Pick<UserRecord, "id" | "role">,
  context: { ip: string | null; userAgent: string | null },
  clock: Clock = () => new Date(),
): Promise<CreatedSession> {
  const sessionToken = generateOpaqueToken();
  const csrfToken = generateOpaqueToken();
  const now = clock();
  const durations = SESSION_DURATIONS[user.role];

  const session = await repository.createSession({
    userId: user.id,
    tokenHash: sessionToken.hash,
    csrfTokenHash: csrfToken.hash,
    lastSeenAt: now,
    idleExpiresAt: new Date(now.getTime() + durations.idleMs),
    absoluteExpiresAt: new Date(now.getTime() + durations.absoluteMs),
    ip: context.ip,
    userAgent: context.userAgent,
  });

  return { session, sessionRaw: sessionToken.raw, csrfRaw: csrfToken.raw };
}

/**
 * Loads a session by its raw cookie token and checks it is currently valid: not revoked,
 * within its idle window and within its absolute lifetime (DATABASE_SPEC.md). A valid
 * session has its idle window slid forward and `lastSeenAt` updated (sliding expiration),
 * re-using the idle window length the session already had so this does not need to know
 * the user's role; the absolute expiry never changes. Returns null for any invalid or
 * missing token — never throws, so callers can treat "no session" uniformly.
 */
export async function loadValidSession(
  repository: AuthRepository,
  rawToken: string | undefined,
  clock: Clock = () => new Date(),
): Promise<LoadedSession | null> {
  if (!rawToken) return null;

  const session = await repository.findSessionByTokenHash(sha256Hex(rawToken));
  if (!session) return null;
  if (session.revokedAt) return null;

  const now = clock();
  if (now.getTime() >= session.idleExpiresAt.getTime()) return null;
  if (now.getTime() >= session.absoluteExpiresAt.getTime()) return null;

  const idleWindowMs = session.idleExpiresAt.getTime() - session.lastSeenAt.getTime();
  const slidIdleExpiresAt = new Date(
    Math.min(now.getTime() + idleWindowMs, session.absoluteExpiresAt.getTime()),
  );
  await repository.touchSession(session.id, { lastSeenAt: now, idleExpiresAt: slidIdleExpiresAt });

  return { session };
}

export function csrfTokenMatchesSession(session: SessionRecord, rawCsrfToken: string): boolean {
  return tokenMatchesHash(rawCsrfToken, session.csrfTokenHash);
}
