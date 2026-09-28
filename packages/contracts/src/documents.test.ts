import { describe, expect, it } from "vitest";
import { apiErrorSchema, documentFileNameSchema, documentParamsSchema } from "./index.js";

describe("document contracts", () => {
  it.each(["comparendo.pdf", "Foto del vehículo (1).jpg", "a".repeat(255)])(
    "accepts the file name %s",
    (name) => {
      expect(documentFileNameSchema.safeParse(name).success).toBe(true);
    },
  );

  it.each([
    "",
    "   ",
    "a".repeat(256),
    "../etc/passwd",
    "carpeta\\x.pdf",
    "a\u0000.pdf",
    "a\n.pdf",
  ])("rejects the file name %j", (name) => {
    expect(documentFileNameSchema.safeParse(name).success).toBe(false);
  });

  it("accepts only UUIDs as path parameters", () => {
    const id = "7b1f5c2e-0d4a-4a4e-9a38-3d5c1f0e2b11";
    expect(documentParamsSchema.safeParse({ caseId: id, documentId: id }).success).toBe(true);
    expect(documentParamsSchema.safeParse({ caseId: id, documentId: "x" }).success).toBe(false);
  });

  it("has an error code for a body over the endpoint's limit", () => {
    const body = { error: { code: "PAYLOAD_TOO_LARGE", message: "x", requestId: "r" } };
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
  });
});
