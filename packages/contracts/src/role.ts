import { z } from "zod";

/** Mirrors the `Role` enum in packages/database/prisma/schema.prisma (ADR-003). */
export const roleSchema = z.enum(["USER", "PROFESSIONAL", "ADMIN", "SUPER_ADMIN"]);
export type Role = z.infer<typeof roleSchema>;
