import { allow, deny, type Actor, type Decision } from "../../common/policy.js";

/**
 * Auth module policy (ADR-003). In Sprint 1 the matrix only covers authentication actions on
 * the actor's own resources, for every role: `user:read` on oneself (GET /api/auth/me) and
 * `session:list` / `session:revoke` on one's own sessions (endpoints designed in API_SPEC.md,
 * not implemented yet). Actions on other users' resources (e.g. ADMIN managing users) arrive
 * with their phase, together with their rules and cross-access tests.
 */
export type AuthAction = "user:read" | "session:list" | "session:revoke";

export interface AuthResources {
  "user:read": { id: string };
  "session:list": { userId: string };
  "session:revoke": { userId: string };
}

export function can<A extends AuthAction>(
  actor: Actor,
  action: A,
  resource: AuthResources[A],
): Decision {
  // A suspended user never acts, whatever the action (deny by default).
  if (actor.status !== "ACTIVE") return deny("inactive_actor");

  switch (action) {
    case "user:read": {
      const user = resource as AuthResources["user:read"];
      return user.id === actor.id ? allow() : deny("not_owner");
    }
    case "session:list":
    case "session:revoke": {
      const session = resource as AuthResources["session:list"];
      return session.userId === actor.id ? allow() : deny("not_owner");
    }
    default:
      return deny("unknown_action");
  }
}
