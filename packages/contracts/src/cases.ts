import { z } from "zod";

/**
 * Mirrors the `CaseType` enum in packages/database/prisma/schema.prisma: the 7 case types of
 * PROJECT_SPEC.md s.9 step 2 (comparendo, infracción, fotodetección, transporte, notificación,
 * actuación administrativa, otro).
 */
export const caseTypeSchema = z.enum([
  "TRAFFIC_CITATION",
  "INFRACTION",
  "PHOTO_ENFORCEMENT",
  "TRANSPORT",
  "NOTIFICATION",
  "ADMINISTRATIVE_PROCEEDING",
  "OTHER",
]);
export type CaseType = z.infer<typeof caseTypeSchema>;

/**
 * Mirrors the `CaseStatus` enum: the 15 initial states of PROJECT_SPEC.md s.8. In the first Case
 * slice only `DRAFT` is reachable (API_SPEC.md).
 */
export const caseStatusSchema = z.enum([
  "DRAFT",
  "DOCUMENTS_PENDING",
  "PRELIMINARY_ANALYSIS",
  "PAYMENT_PENDING",
  "PAID",
  "LEGAL_REVIEW",
  "DOCUMENT_PREPARATION",
  "READY_TO_FILE",
  "FILED",
  "WAITING_RESPONSE",
  "RESPONSE_RECEIVED",
  "FOLLOW_UP",
  "RESOLVED",
  "CLOSED",
  "CANCELLED",
]);
export type CaseStatus = z.infer<typeof caseStatusSchema>;

/** Public shape of one of the user's own cases (API_SPEC.md `Case`). The owner is never sent. */
export const caseSchema = z.object({
  id: z.string().uuid(),
  type: caseTypeSchema,
  status: caseStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Case = z.infer<typeof caseSchema>;

/** One entry of a case's status history (API_SPEC.md `CaseStatusChange`). */
export const caseStatusChangeSchema = z.object({
  fromStatus: caseStatusSchema.nullable(),
  toStatus: caseStatusSchema,
  changedAt: z.string().datetime(),
});
export type CaseStatusChange = z.infer<typeof caseStatusChangeSchema>;

/**
 * Body of `POST /api/cases`: the type only. The status and the owner are set by the server, so
 * any other field is rejected.
 */
export const createCaseRequestSchema = z.object({ type: caseTypeSchema }).strict();
export type CreateCaseRequest = z.infer<typeof createCaseRequestSchema>;

export const caseResponseSchema = z.object({ case: caseSchema });
export type CaseResponse = z.infer<typeof caseResponseSchema>;

export const casesResponseSchema = z.object({ cases: z.array(caseSchema) });
export type CasesResponse = z.infer<typeof casesResponseSchema>;

export const caseDetailResponseSchema = z.object({
  case: caseSchema,
  statusHistory: z.array(caseStatusChangeSchema),
});
export type CaseDetailResponse = z.infer<typeof caseDetailResponseSchema>;

/** Path parameters of `GET /api/cases/:caseId`. */
export const caseParamsSchema = z.object({ caseId: z.string().uuid() }).strict();
export type CaseParams = z.infer<typeof caseParamsSchema>;
