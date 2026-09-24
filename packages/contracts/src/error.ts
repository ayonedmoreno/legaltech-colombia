import { z } from "zod";

/** Stable, English error codes shared by the API and its clients (see API_SPEC.md). */
export const apiErrorCodeSchema = z.enum([
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "INVALID_CREDENTIALS",
  "INVALID_OR_EXPIRED_TOKEN",
  "CSRF_INVALID",
  "FORBIDDEN",
  "NOT_FOUND",
  "RATE_LIMITED",
  "INTERNAL_ERROR",
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    details: z.array(z.object({ field: z.string(), issue: z.string() })).default([]),
    requestId: z.string(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
