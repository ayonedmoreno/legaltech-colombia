import { describe, expect, it } from "vitest";
import {
  apiErrorSchema,
  DOCUMENT_OCR_QUEUE,
  DOCUMENT_OCR_REPROCESS_QUEUE,
  documentFileNameSchema,
  documentOcrJobSchema,
  documentOcrReprocessJobSchema,
  documentOcrStatusSchema,
  documentParamsSchema,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_QUOTA_BYTES,
  documentReprocessJobSchema,
  documentScanJobSchema,
  documentStatusSchema,
  reprocessDocumentRequestSchema,
} from "./index.js";

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

  it("has the six statuses of the security treatment", () => {
    expect(documentStatusSchema.options).toEqual([
      "UPLOADED",
      "PENDING_SCAN",
      "SCANNING",
      "CLEAN",
      "INFECTED",
      "SCAN_FAILED",
    ]);
  });

  it("accepts a document.scan job with a document id only", () => {
    const id = "7b1f5c2e-0d4a-4a4e-9a38-3d5c1f0e2b11";
    expect(documentScanJobSchema.safeParse({ documentId: id }).success).toBe(true);
    expect(documentScanJobSchema.safeParse({ documentId: "x" }).success).toBe(false);
    expect(documentScanJobSchema.safeParse({ documentId: id, fileName: "a.pdf" }).success).toBe(
      false,
    );
  });

  it("fixes the upload limit at 10 MiB and the per-user quota at 100 MiB", () => {
    expect(DOCUMENT_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(DOCUMENT_QUOTA_BYTES).toBe(100 * 1024 * 1024);
  });

  it("accepts a document.reprocess job with a document id only", () => {
    const id = "7b1f5c2e-0d4a-4a4e-9a38-3d5c1f0e2b11";
    expect(documentReprocessJobSchema.safeParse({ documentId: id }).success).toBe(true);
    expect(documentReprocessJobSchema.safeParse({ documentId: id, force: true }).success).toBe(
      false,
    );
  });

  it("requires a justification (1 to 500 characters) to reprocess a document, and nothing else", () => {
    expect(
      reprocessDocumentRequestSchema.safeParse({ reason: "ClamAV caído el 2026-10-01" }).success,
    ).toBe(true);
    expect(reprocessDocumentRequestSchema.safeParse({ reason: "   " }).success).toBe(false);
    expect(reprocessDocumentRequestSchema.safeParse({}).success).toBe(false);
    expect(reprocessDocumentRequestSchema.safeParse({ reason: "x".repeat(501) }).success).toBe(
      false,
    );
    expect(
      reprocessDocumentRequestSchema.safeParse({ reason: "ok", status: "CLEAN" }).success,
    ).toBe(false);
  });

  it("has the seven OCR statuses of the approved design, with two distinct exclusions", () => {
    expect(documentOcrStatusSchema.options).toEqual([
      "NOT_STARTED",
      "PENDING",
      "PROCESSING",
      "COMPLETED",
      "FAILED",
      "NOT_APPLICABLE",
      "EXCLUDED",
    ]);
  });

  it("names the OCR queues apart from the security treatment's", () => {
    expect(DOCUMENT_OCR_QUEUE).toBe("document.ocr");
    expect(DOCUMENT_OCR_REPROCESS_QUEUE).toBe("document.ocr_reprocess");
  });

  it.each([
    ["document.ocr", documentOcrJobSchema],
    ["document.ocr_reprocess", documentOcrReprocessJobSchema],
  ])("accepts a %s job with a document id only (never a name, content or text)", (_, schema) => {
    const id = "7b1f5c2e-0d4a-4a4e-9a38-3d5c1f0e2b11";
    expect(schema.safeParse({ documentId: id }).success).toBe(true);
    expect(schema.safeParse({ documentId: "x" }).success).toBe(false);
    expect(schema.safeParse({ documentId: id, text: "..." }).success).toBe(false);
  });
});
