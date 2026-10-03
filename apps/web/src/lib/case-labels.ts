import type {
  Case,
  CaseStatus,
  CaseType,
  DocumentFileType,
  DocumentOcrStatus,
  DocumentStatus,
} from "@legaltech/contracts";

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

export const DOCUMENT_FILE_TYPE_LABELS: Record<DocumentFileType, string> = {
  PDF: "PDF",
  JPEG: "Imagen JPEG",
  PNG: "Imagen PNG",
};

/** The security treatment of a document, as the user reads it (DATABASE_SPEC.md). */
export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  UPLOADED: "Pendiente de análisis",
  PENDING_SCAN: "Pendiente de análisis",
  SCANNING: "En análisis",
  CLEAN: "Disponible",
  INFECTED: "Bloqueado: se detectó una amenaza",
  SCAN_FAILED: "Bloqueado: no se pudo analizar",
};

/**
 * The OCR state of a document (DATABASE_SPEC.md, "OCR del documento"), for its owner. The text is
 * only ever shown with the warning that it is unverified (OCR_UNVERIFIED_WARNING).
 */
export const DOCUMENT_OCR_STATUS_LABELS: Record<DocumentOcrStatus, string> = {
  NOT_STARTED: "Texto no procesado",
  PENDING: "Texto pendiente de procesar",
  PROCESSING: "Procesando el texto",
  COMPLETED: "Texto disponible",
  FAILED: "No se pudo obtener el texto",
  NOT_APPLICABLE: "Sin procesamiento de texto",
  EXCLUDED: "Sin procesamiento de texto por ahora",
};

/** Always next to OCR text (decision OCR-A3): it is unverified and may contain errors. */
export const OCR_UNVERIFIED_WARNING =
  "Texto obtenido automáticamente a partir del documento. No está verificado y puede contener errores.";

/** Only a document that passed its security treatment can be downloaded (the API enforces it). */
export function isDownloadable(status: DocumentStatus): boolean {
  return status === "CLEAN";
}

/**
 * The upload limit: the system's one value (@legaltech/contracts, 10 MiB). The browser checks it
 * only to spare a useless upload; the API enforces it.
 */
export { DOCUMENT_MAX_BYTES } from "@legaltech/contracts";

/** A file size for people: bytes, KB or MB, with a comma decimal (Colombia). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit: "KB" | "MB" = "KB";
  if (value >= 1024) {
    value /= 1024;
    unit = "MB";
  }
  return `${value.toLocaleString("es-CO", { maximumFractionDigits: 1 })} ${unit}`;
}
