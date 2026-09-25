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
