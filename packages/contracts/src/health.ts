import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "unavailable"]),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
