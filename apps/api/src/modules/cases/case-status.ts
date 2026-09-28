import type { CaseStatus } from "@legaltech/database";

/**
 * Case state machine (DATABASE_SPEC.md, "Estados y transiciones del caso"; ARCHITECTURE_REPORT
 * finding 11). A pure domain layer: no database, no endpoints, no other modules.
 *
 * The matrix holds only the documented transitions T1-T10: T4 is explicit in PROJECT_SPEC.md
 * (s.9 step 9, s.23) and the rest are inferred directly from the order of s.8 and s.9. **None is
 * enabled**: each one is enabled, with its trigger, permission, history entry and
 * `case.status_changed` event, by the phase that owns its real trigger. What the documents leave
 * open (V1-V8: FOLLOW_UP, RESOLVED/CLOSED, cancellation, going back, leaving without acting…) is
 * deliberately absent, not decided here.
 */

/** Every case starts here (s.8, first initial state; T0, `POST /api/cases`). */
export const INITIAL_CASE_STATUS: CaseStatus = "DRAFT";

/** `explicit`: stated by the documents; `inferred`: follows directly from the order of s.8/s.9. */
export type TransitionBasis = "explicit" | "inferred";

/**
 * Who the documents say triggers it. `pending` when they do not say: it is decided by the phase
 * that enables the transition. No transition is ever triggered by the case's user (s.6: the
 * user "consulta estados").
 */
export type TransitionActor = "system" | "professional" | "pending";

/** The phase that owns the real trigger (PROJECT_SPEC.md s.34 names). */
export type TransitionPhase =
  "questionnaire_or_documents" | "documents" | "pricing" | "payments" | "professionals";

export type TransitionId = "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7" | "T8" | "T9" | "T10";

export interface CaseTransition {
  id: TransitionId;
  from: CaseStatus;
  to: CaseStatus;
  basis: TransitionBasis;
  /** The documented trigger, with its source. */
  trigger: string;
  actor: TransitionActor;
  phase: TransitionPhase;
  /** Whether the transition can happen now. False for all of them in this slice. */
  enabled: boolean;
}

export const CASE_TRANSITIONS: readonly CaseTransition[] = Object.freeze(
  (
    [
      {
        id: "T1",
        from: "DRAFT",
        to: "DOCUMENTS_PENDING",
        basis: "inferred",
        trigger: "Datos iniciales completos (s.9 paso 3)",
        actor: "pending",
        phase: "questionnaire_or_documents",
        enabled: false,
      },
      {
        id: "T2",
        from: "DOCUMENTS_PENDING",
        to: "PRELIMINARY_ANALYSIS",
        basis: "inferred",
        trigger: "Documentos cargados; el sistema realiza OCR y extracción (s.9 pasos 4-5)",
        actor: "system",
        phase: "documents",
        enabled: false,
      },
      {
        id: "T3",
        from: "PRELIMINARY_ANALYSIS",
        to: "PAYMENT_PENDING",
        basis: "inferred",
        trigger: "Valoración y oferta (s.5; s.9 paso 7)",
        actor: "pending",
        phase: "pricing",
        enabled: false,
      },
      {
        id: "T4",
        from: "PAYMENT_PENDING",
        to: "PAID",
        basis: "explicit",
        trigger: "Webhook de pago verificado, nunca el frontend (s.9 paso 9; s.23)",
        actor: "system",
        phase: "payments",
        enabled: false,
      },
      {
        id: "T5",
        from: "PAID",
        to: "LEGAL_REVIEW",
        basis: "inferred",
        trigger: "Apertura formal y gestión (s.9 pasos 9-10)",
        actor: "pending",
        phase: "professionals",
        enabled: false,
      },
      {
        id: "T6",
        from: "LEGAL_REVIEW",
        to: "DOCUMENT_PREPARATION",
        basis: "inferred",
        trigger: "Análisis completo (s.9 paso 10; s.6 PROFESSIONAL: actualizar estados)",
        actor: "professional",
        phase: "professionals",
        enabled: false,
      },
      {
        id: "T7",
        from: "DOCUMENT_PREPARATION",
        to: "READY_TO_FILE",
        basis: "inferred",
        trigger: "Documentos aprobados (s.9 paso 11; s.6 PROFESSIONAL: aprobar documentos)",
        actor: "professional",
        phase: "professionals",
        enabled: false,
      },
      {
        id: "T8",
        from: "READY_TO_FILE",
        to: "FILED",
        basis: "inferred",
        trigger: "Actuación registrada (s.6 PROFESSIONAL: registrar actuaciones); requiere V8",
        actor: "professional",
        phase: "professionals",
        enabled: false,
      },
      {
        id: "T9",
        from: "FILED",
        to: "WAITING_RESPONSE",
        basis: "inferred",
        trigger: "Actuación radicada (s.9 paso 12)",
        actor: "pending",
        phase: "professionals",
        enabled: false,
      },
      {
        id: "T10",
        from: "WAITING_RESPONSE",
        to: "RESPONSE_RECEIVED",
        basis: "inferred",
        trigger: "Respuesta incorporada al expediente (s.9 paso 13)",
        actor: "professional",
        phase: "professionals",
        enabled: false,
      },
    ] satisfies CaseTransition[]
  ).map((transition) => Object.freeze(transition)),
);

/** The documented transitions out of a status, enabled or not (empty for most statuses). */
export function documentedTransitions(from: CaseStatus): readonly CaseTransition[] {
  return CASE_TRANSITIONS.filter((transition) => transition.from === from);
}

/** Whether the case may move from `from` to `to` now: documented and enabled. */
export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return CASE_TRANSITIONS.some(
    (transition) => transition.from === from && transition.to === to && transition.enabled,
  );
}

/** A status change the state machine does not allow (not documented, or not enabled yet). */
export class InvalidCaseTransitionError extends Error {
  readonly from: CaseStatus;
  readonly to: CaseStatus;

  constructor(from: CaseStatus, to: CaseStatus) {
    super(`Case status transition not allowed: ${from} -> ${to}`);
    this.name = "InvalidCaseTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** The transition from `from` to `to`, or InvalidCaseTransitionError when it is not allowed now. */
export function assertTransition(from: CaseStatus, to: CaseStatus): CaseTransition {
  const transition = CASE_TRANSITIONS.find(
    (candidate) => candidate.from === from && candidate.to === to && candidate.enabled,
  );
  if (!transition) throw new InvalidCaseTransitionError(from, to);
  return transition;
}
