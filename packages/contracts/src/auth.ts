import { z } from "zod";
import { roleSchema } from "./role.js";

/** Public shape of a user, as returned by the API. Never includes passwordHash or token hashes. */
export const userSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  fullName: z.string(),
  role: roleSchema,
  emailVerified: z.boolean(),
  createdAt: z.string().datetime(),
});
export type User = z.infer<typeof userSchema>;

export const registerRequestSchema = z
  .object({
    email: z.string().trim().min(1).email(),
    password: z.string().min(12).max(128),
    fullName: z.string().trim().min(1).max(200),
  })
  .strict();
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const registerResponseSchema = z.object({ status: z.literal("accepted") });
export type RegisterResponse = z.infer<typeof registerResponseSchema>;

export const loginRequestSchema = z
  .object({
    email: z.string().trim().min(1).email(),
    password: z.string().min(1).max(128),
  })
  .strict();
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const loginResponseSchema = z.object({ user: userSchema });
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const meResponseSchema = z.object({ user: userSchema });
export type MeResponse = z.infer<typeof meResponseSchema>;

export const csrfResponseSchema = z.object({ csrfToken: z.string() });
export type CsrfResponse = z.infer<typeof csrfResponseSchema>;

/**
 * Public shape of one of the user's own sessions (API_SPEC.md `Session`). Never includes the
 * token or CSRF hashes; `current` marks the session the request was made with.
 */
export const sessionSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  current: z.boolean(),
});
export type Session = z.infer<typeof sessionSchema>;

export const sessionsResponseSchema = z.object({ sessions: z.array(sessionSchema) });
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;

/** Path parameters of `DELETE /api/auth/sessions/:sessionId`. */
export const revokeSessionParamsSchema = z.object({ sessionId: z.string().uuid() }).strict();
export type RevokeSessionParams = z.infer<typeof revokeSessionParamsSchema>;

/** Body of `POST /api/auth/email/verify`: the token from the verification link. */
export const verifyEmailRequestSchema = z.object({ token: z.string().min(1).max(256) }).strict();
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;

/** 202 answer of requests accepted for later processing (e.g. resending the verification email). */
export const acceptedResponseSchema = z.object({ status: z.literal("accepted") });
export type AcceptedResponse = z.infer<typeof acceptedResponseSchema>;

/** Body of `POST /api/auth/password/forgot`. */
export const forgotPasswordRequestSchema = z
  .object({ email: z.string().trim().min(1).email() })
  .strict();
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

/** Body of `POST /api/auth/password/reset`: the token from the reset link and the new password. */
export const resetPasswordRequestSchema = z
  .object({ token: z.string().min(1).max(256), newPassword: z.string().min(12).max(128) })
  .strict();
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

/** Answer of `POST /api/auth/session/rotate`: whether the session was renewed by this request. */
export const rotateSessionResponseSchema = z.object({ rotated: z.boolean() });
export type RotateSessionResponse = z.infer<typeof rotateSessionResponseSchema>;
