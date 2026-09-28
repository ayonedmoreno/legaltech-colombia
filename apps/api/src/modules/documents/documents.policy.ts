import { allow, deny, type Actor, type Decision } from "../../common/policy.js";

/**
 * Documents module policy (ADR-003). First Documents slice (Phase 3): only a `USER` uploads,
 * lists and downloads documents, and only those of their own cases (PROJECT_SPEC.md s.6:
 * "cargar documentos", "consultar expedientes"). Other roles are denied until their phases.
 */
export type DocumentAction = "document:upload" | "document:list" | "document:download";

/** Every document action names the owner of the case the documents belong to. */
export interface DocumentResource {
  caseOwnerId: string;
}

export function can(actor: Actor, action: DocumentAction, resource: DocumentResource): Decision {
  if (actor.status !== "ACTIVE") return deny("inactive_actor");
  if (actor.role !== "USER") return deny("role_not_allowed");

  switch (action) {
    case "document:upload":
    case "document:list":
    case "document:download":
      return resource.caseOwnerId === actor.id ? allow() : deny("not_owner");
    default:
      return deny("unknown_action");
  }
}
