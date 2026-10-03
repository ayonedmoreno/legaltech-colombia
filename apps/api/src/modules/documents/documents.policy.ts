import { allow, deny, type Actor, type Decision } from "../../common/policy.js";

/**
 * Documents module policy (ADR-003). A `USER` uploads, lists and downloads documents, only those
 * of their own cases (PROJECT_SPEC.md s.6: "cargar documentos", "consultar expedientes"). An
 * `ADMIN` may ask for a document whose treatment failed to be treated again
 * (`document:reprocess`; s.6 ADMIN: "administrar documentos"), an administrative action on
 * another user's data that is justified and audited, and likewise for a document whose OCR failed
 * (`document:reprocess_ocr`, decision OCR-A12): neither gives any access to the document's
 * content or text. The owner, and only the owner, reads the unverified OCR text of their own
 * documents (`document:read_ocr`, decisions OCR-A3 and OCR-A12). Every other role and action is
 * denied.
 */
export type DocumentAction =
  | "document:upload"
  | "document:list"
  | "document:download"
  | "document:read_ocr"
  | "document:reprocess"
  | "document:reprocess_ocr";

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
    case "document:read_ocr":
      if (actor.role !== "USER") return deny("role_not_allowed");
      return resource.caseOwnerId === actor.id ? allow() : deny("not_owner");
    case "document:reprocess":
    case "document:reprocess_ocr":
      // Not the owner's to decide: an operational action on any user's document.
      return actor.role === "ADMIN" ? allow() : deny("role_not_allowed");
    default:
      return deny("unknown_action");
  }
}
