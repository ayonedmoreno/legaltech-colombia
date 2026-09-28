import { describe, expect, it } from "vitest";
import {
  caseDetailResponseSchema,
  caseParamsSchema,
  caseStatusSchema,
  caseTypeSchema,
  createCaseRequestSchema,
} from "./index.js";

describe("case contracts", () => {
  it("has exactly the 7 case types and the 15 case states of PROJECT_SPEC", () => {
    expect(caseTypeSchema.options).toHaveLength(7);
    expect(caseStatusSchema.options).toHaveLength(15);
    expect(caseStatusSchema.options[0]).toBe("DRAFT");
  });

  it("accepts a creation request with a known type only", () => {
    expect(createCaseRequestSchema.safeParse({ type: "TRAFFIC_CITATION" }).success).toBe(true);
    expect(createCaseRequestSchema.safeParse({ type: "PARKING" }).success).toBe(false);
    expect(createCaseRequestSchema.safeParse({}).success).toBe(false);
  });

  it.each([{ status: "PAID" }, { userId: "7b1f5c2e-0d4a-4a4e-9a38-3d5c1f0e2b11" }])(
    "rejects fields the server sets (%o)",
    (extra) => {
      expect(createCaseRequestSchema.safeParse({ type: "OTHER", ...extra }).success).toBe(false);
    },
  );

  it("accepts only a UUID case id in the path", () => {
    expect(caseParamsSchema.safeParse({ caseId: "not-a-uuid" }).success).toBe(false);
    expect(
      caseParamsSchema.safeParse({ caseId: "7b1f5c2e-0d4a-4a4e-9a38-3d5c1f0e2b11" }).success,
    ).toBe(true);
  });

  it("validates a case detail with its creation entry (NULL → DRAFT)", () => {
    const at = "2026-09-27T12:00:00.000Z";
    const parsed = caseDetailResponseSchema.safeParse({
      case: {
        id: "7b1f5c2e-0d4a-4a4e-9a38-3d5c1f0e2b11",
        type: "OTHER",
        status: "DRAFT",
        createdAt: at,
        updatedAt: at,
      },
      statusHistory: [{ fromStatus: null, toStatus: "DRAFT", changedAt: at }],
    });
    expect(parsed.success).toBe(true);
  });
});
