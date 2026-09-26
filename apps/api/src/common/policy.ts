import type { Role, UserStatus } from "@legaltech/database";

/**
 * Shared vocabulary for module policies (ADR-003): `can(actor, action, resource?) -> Decision`.
 * Each module exposes its own policy built on these types; policies are pure functions with
 * no database access, deny by default, and are unit-tested.
 */

/** The authenticated user a policy decides for: identity, role and status only. */
export interface Actor {
  id: string;
  role: Role;
  status: UserStatus;
}

/** Why a request was denied. For tests and logs only; never sent to the client. */
export type DenyReason = "inactive_actor" | "not_owner" | "unknown_action";

export type Decision = { allowed: true } | { allowed: false; reason: DenyReason };

export const allow = (): Decision => ({ allowed: true });

export const deny = (reason: DenyReason): Decision => ({ allowed: false, reason });
