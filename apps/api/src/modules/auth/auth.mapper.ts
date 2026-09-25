import type { User } from "@legaltech/contracts";
import type { UserRecord } from "./auth.types.js";

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
