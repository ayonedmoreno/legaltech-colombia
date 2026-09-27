import type { Session, User } from "@legaltech/contracts";
import type { SessionRecord, UserRecord } from "./auth.types.js";

/** Maps the internal user record to the public shape (API_SPEC.md). Never includes passwordHash. */
export function toPublicUser(user: UserRecord): User {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    emailVerified: user.emailVerifiedAt !== null,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * Maps a session record to its public shape (API_SPEC.md `Session`). Never includes the token
 * or CSRF hashes. `currentSessionId` is the session the request was made with.
 */
export function toPublicSession(session: SessionRecord, currentSessionId: string): Session {
  return {
    id: session.id,
    createdAt: session.createdAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    ip: session.ip,
    userAgent: session.userAgent,
    current: session.id === currentSessionId,
  };
}
