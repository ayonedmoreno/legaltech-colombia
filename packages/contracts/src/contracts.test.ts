import { describe, expect, it } from "vitest";
import { apiErrorSchema, healthResponseSchema } from "./index.js";

describe("contracts", () => {
  it("accepts a valid error body and defaults details", () => {
    const parsed = apiErrorSchema.parse({
      error: { code: "NOT_FOUND", message: "Recurso no encontrado.", requestId: "req-1" },
    });
    expect(parsed.error.details).toEqual([]);
  });

  it("rejects an unknown error code", () => {
    const result = apiErrorSchema.safeParse({
      error: { code: "SOMETHING_ELSE", message: "x", requestId: "req-1" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts SERVICE_UNAVAILABLE (503 when the login attempt cannot be evaluated, ADR-002 D3)", () => {
    const result = apiErrorSchema.safeParse({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Servicio no disponible temporalmente. Inténtalo más tarde.",
        requestId: "req-1",
      },
    });
    expect(result.success).toBe(true);
  });

  it("validates the health response", () => {
    expect(healthResponseSchema.safeParse({ status: "ok" }).success).toBe(true);
    expect(healthResponseSchema.safeParse({ status: "down" }).success).toBe(false);
  });
});
