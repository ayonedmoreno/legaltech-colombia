import { z } from "zod";

/** Mirrors `DocumentFileType`: detected from the file's content, never from its name. */
export const documentFileTypeSchema = z.enum(["PDF", "JPEG", "PNG"]);
export type DocumentFileType = z.infer<typeof documentFileTypeSchema>;

/**
 * Mirrors `DocumentStatus`: the security treatment of a document (DATABASE_SPEC.md). Only
 * `CLEAN` can be downloaded; every other status is blocked.
 */
export const documentStatusSchema = z.enum([
  "UPLOADED",
  "PENDING_SCAN",
  "SCANNING",
  "CLEAN",
  "INFECTED",
  "SCAN_FAILED",
]);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

/**
 * Mirrors `DocumentOcrStatus` (DATABASE_SPEC.md, "OCR del documento"; decision OCR-A10.2). Only a
 * `CLEAN` document ever leaves `NOT_STARTED`. `NOT_APPLICABLE` is definitive (an `INFECTED`
 * document); `EXCLUDED` is reversible only by an explicit task (a PDF the OCR may not process, or a
 * document that was `CLEAN` before the OCR was activated).
 */
export const documentOcrStatusSchema = z.enum([
  "NOT_STARTED",
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "NOT_APPLICABLE",
  "EXCLUDED",
]);
export type DocumentOcrStatus = z.infer<typeof documentOcrStatusSchema>;

/**
 * Public shape of a document of one's own case (API_SPEC.md `Document`). Never includes the
 * storage key or the uploader.
 */
export const documentSchema = z.object({
  id: z.string().uuid(),
  fileName: z.string(),
  fileType: documentFileTypeSchema,
  fileSize: z.number().int().positive(),
  status: documentStatusSchema,
  ocrStatus: documentOcrStatusSchema,
  createdAt: z.string().datetime(),
});
export type Document = z.infer<typeof documentSchema>;

export const documentResponseSchema = z.object({ document: documentSchema });
export type DocumentResponse = z.infer<typeof documentResponseSchema>;

export const documentsResponseSchema = z.object({ documents: z.array(documentSchema) });
export type DocumentsResponse = z.infer<typeof documentsResponseSchema>;

/**
 * One page of the OCR text of a document (decision OCR-A10.4): unverified and untrusted text
 * (OCR-A3, OCR-A13), always rendered as text, never as HTML or instructions.
 */
export const documentOcrPageSchema = z.object({
  number: z.number().int().positive(),
  text: z.string(),
});
export type DocumentOcrPage = z.infer<typeof documentOcrPageSchema>;

/**
 * Answer of `GET /api/cases/:caseId/documents/:documentId/ocr` (decision OCR-A12): the OCR state
 * and, only while it is `COMPLETED`, the text of the current execution (the latest completed one).
 * An empty `pages` means "no text available in this state", never a document without pages.
 */
export const documentOcrResponseSchema = z.object({
  ocrStatus: documentOcrStatusSchema,
  pages: z.array(documentOcrPageSchema),
});
export type DocumentOcrResponse = z.infer<typeof documentOcrResponseSchema>;

/** Answer of the download endpoint: a short-lived presigned URL of the private storage. */
export const documentDownloadResponseSchema = z.object({
  url: z.string().url(),
  expiresAt: z.string().datetime(),
});
export type DocumentDownloadResponse = z.infer<typeof documentDownloadResponseSchema>;

/** Path parameters of `GET /api/cases/:caseId/documents/:documentId/download`. */
export const documentParamsSchema = z
  .object({ caseId: z.string().uuid(), documentId: z.string().uuid() })
  .strict();
export type DocumentParams = z.infer<typeof documentParamsSchema>;

/**
 * The original file name, sent URL-encoded in the `X-File-Name` header of the upload (never in
 * the URL): 1 to 255 characters once decoded, no path separators and no control characters.
 */
export const documentFileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  // eslint-disable-next-line no-control-regex
  .refine((name) => !/[/\\\u0000-\u001f\u007f]/.test(name), {
    message: "must not contain path separators or control characters",
  });

const MIB = 1024 * 1024;

/**
 * The one upload limit of the system, in bytes (API_SPEC.md; SECURITY_SPEC.md §11): 10 MiB, a
 * provisional technical value. The API refuses anything larger (413), the web checks it before
 * sending, and the web's /api proxy buffers a little more so that the API always decides.
 */
export const DOCUMENT_MAX_BYTES = 10 * MIB;

/**
 * Space a user's documents may take, in bytes (sum of the original files' sizes): 100 MiB, a
 * provisional technical value. Every stored document counts while it exists, whatever its status.
 */
export const DOCUMENT_QUOTA_BYTES = 100 * MIB;

/** The pg-boss queue of the document security treatment (API enqueues, worker consumes). */
export const DOCUMENT_SCAN_QUEUE = "document.scan";

/** Payload of a `document.scan` job: only the document's id, never its name or content. */
export const documentScanJobSchema = z.object({ documentId: z.string().uuid() }).strict();
export type DocumentScanJob = z.infer<typeof documentScanJobSchema>;

/**
 * The pg-boss queue of an explicit reprocessing (API enqueues for an ADMIN, worker moves the
 * document `SCAN_FAILED` → `PENDING_SCAN`).
 */
export const DOCUMENT_REPROCESS_QUEUE = "document.reprocess";

/** Payload of a `document.reprocess` job: only the document's id. */
export const documentReprocessJobSchema = z.object({ documentId: z.string().uuid() }).strict();
export type DocumentReprocessJob = z.infer<typeof documentReprocessJobSchema>;

/**
 * The pg-boss queue of the OCR of a document (DATABASE_SPEC.md, "OCR del documento"). Only the
 * worker enqueues it, in the transaction that records a `CLEAN` result or retries an OCR.
 */
export const DOCUMENT_OCR_QUEUE = "document.ocr";

/** Payload of a `document.ocr` job: only the document's id, never its name, content or text. */
export const documentOcrJobSchema = z.object({ documentId: z.string().uuid() }).strict();
export type DocumentOcrJob = z.infer<typeof documentOcrJobSchema>;

/**
 * The pg-boss queue of an ADMIN's explicit OCR reprocessing (API enqueues; the worker moves a
 * document whose OCR is `FAILED` back to `PENDING`).
 */
export const DOCUMENT_OCR_REPROCESS_QUEUE = "document.ocr_reprocess";

/** Payload of a `document.ocr_reprocess` job: only the document's id. */
export const documentOcrReprocessJobSchema = z.object({ documentId: z.string().uuid() }).strict();
export type DocumentOcrReprocessJob = z.infer<typeof documentOcrReprocessJobSchema>;

/** Path parameters of `POST /api/admin/documents/:documentId/reprocess`. */
export const documentIdParamsSchema = z.object({ documentId: z.string().uuid() }).strict();

/**
 * Body of `POST /api/admin/documents/:documentId/reprocess`: the justification of an
 * administrative action on another user's document (ADR-003), recorded in the audit log.
 */
export const reprocessDocumentRequestSchema = z
  .object({ reason: z.string().trim().min(1).max(500) })
  .strict();
export type ReprocessDocumentRequest = z.infer<typeof reprocessDocumentRequestSchema>;
