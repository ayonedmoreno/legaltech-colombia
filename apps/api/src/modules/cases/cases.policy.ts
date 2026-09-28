import { allow, deny, type Actor, type Decision } from "../../common/policy.js";

/**
 * Cases module policy (ADR-003). First Case slice (Phase 2): only a `USER` creates, lists and
 * reads cases, and only their own (PROJECT_SPEC.md s.6: "crear casos", "consultar
 * expedientes"). PROFESSIONAL (assigned cases), ADMIN and SUPER_ADMIN get their rules with their
 * phases; until then they are denied (deny by default).
 */
export type CaseAction = "case:create" | "case:list" | "case:read";

/** Every case action names the owner of the case(s) it acts on. */
export interface CaseResource {
  userId: string;
}

export function can(actor: Actor, action: CaseAction, resource: CaseResource): Decision {
  // A suspended user never acts, whatever the action.
  if (actor.status !== "ACTIVE") return deny("inactive_actor");
  if (actor.role !== "USER") return deny("role_not_allowed");

  switch (action) {
    case "case:create":
    case "case:list":
    case "case:read":
      return resource.userId === actor.id ? allow() : deny("not_owner");
    default:
      return deny("unknown_action");
  }
}
