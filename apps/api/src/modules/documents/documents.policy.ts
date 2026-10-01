import { allow, deny, type Actor, type Decision } from "../../common/policy.js";

/**
 * Documents module policy (ADR-003). A `USER` uploads, lists and downloads documents, only those
 * of their own cases (PROJECT_SPEC.md s.6: "cargar documentos", "consultar expedientes"). An
 * `ADMIN` may ask for a document whose treatment failed to be treated again
 * (`document:reprocess`; s.6 ADMIN: "administrar documentos"), an administrative action on
 * another user's data that is justified and audited. Every other role and action is denied.
 */
export type DocumentAction =
  "document:upload" | "document:list" | "document:download" | "document:reprocess";

/** Every document action names the owner of the case the documents belong to. */
export interface DocumentResource {
  caseOwnerId: string;
}

export function can(actor: Actor, action: DocumentAction, resource: DocumentResource): Decision {
  if (actor.status !== "ACTIVE") return deny("inactive_actor");

  switch (action) {
    case "document:upload":
    case "document:list":
    case "document:download":
      if (actor.role !== "USER") return deny("role_not_allowed");
      return resource.caseOwnerId === actor.id ? allow() : deny("not_owner");
    case "document:reprocess":
      // Not the owner's to decide: an operational action on any user's document.
      return actor.role === "ADMIN" ? allow() : deny("role_not_allowed");
    default:
      return deny("unknown_action");
  }
}
