import type { Case, CaseStatus, CaseType } from "@legaltech/contracts";

/**
 * Spanish labels of the case types and statuses (ARCHITECTURE_REPORT D4: code in English, UI in
 * Spanish). The types are the 7 of PROJECT_SPEC.md s.9 step 2; the records are typed by the
 * contracts, so a type or status added there without a label fails to compile.
 */
export const CASE_TYPE_LABELS: Record<CaseType, string> = {
  TRAFFIC_CITATION: "Comparendo",
  INFRACTION: "Infracción",
  PHOTO_ENFORCEMENT: "Fotodetección",
  TRANSPORT: "Transporte",
  NOTIFICATION: "Notificación",
  ADMINISTRATIVE_PROCEEDING: "Actuación administrativa",
  OTHER: "Otro",
};

/** The creation form offers the types in the order of PROJECT_SPEC.md s.9 step 2. */
export const CASE_TYPES = Object.keys(CASE_TYPE_LABELS) as CaseType[];

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  DRAFT: "Borrador",
  DOCUMENTS_PENDING: "Documentos pendientes",
  PRELIMINARY_ANALYSIS: "Análisis preliminar",
  PAYMENT_PENDING: "Pago pendiente",
  PAID: "Pagado",
  LEGAL_REVIEW: "Revisión jurídica",
  DOCUMENT_PREPARATION: "Preparación de documentos",
  READY_TO_FILE: "Listo para radicar",
  FILED: "Radicado",
  WAITING_RESPONSE: "En espera de respuesta",
  RESPONSE_RECEIVED: "Respuesta recibida",
  FOLLOW_UP: "Seguimiento",
  RESOLVED: "Resuelto",
  CLOSED: "Cerrado",
  CANCELLED: "Cancelado",
};

/**
 * Closed cases in /panel (Phase 2 decision D): `RESOLVED`, `CLOSED` and `CANCELLED`; every other
 * status is active. `CANCELLED` is not reachable yet but is already classified.
 */
const CLOSED_STATUSES: ReadonlySet<CaseStatus> = new Set(["RESOLVED", "CLOSED", "CANCELLED"]);

export function isClosedStatus(status: CaseStatus): boolean {
  return CLOSED_STATUSES.has(status);
}

/** Splits the user's cases into active and closed ones, keeping their order. */
export function splitByActivity(cases: Case[]): { active: Case[]; closed: Case[] } {
  return {
    active: cases.filter((c) => !isClosedStatus(c.status)),
    closed: cases.filter((c) => isClosedStatus(c.status)),
  };
}

/** A date shown to the user (Colombia), from the API's ISO-8601 value. */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("es-CO", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Bogota",
  });
}
