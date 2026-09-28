import { z } from "zod";

/** Mirrors `DocumentFileType`: detected from the file's content, never from its name. */
export const documentFileTypeSchema = z.enum(["PDF", "JPEG", "PNG"]);
export type DocumentFileType = z.infer<typeof documentFileTypeSchema>;

/** Mirrors `DocumentStatus` (first Documents slice: UPLOADED only). */
export const documentStatusSchema = z.enum(["UPLOADED"]);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

/** Mirrors `DocumentOcrStatus` (first Documents slice: NOT_STARTED only). */
export const documentOcrStatusSchema = z.enum(["NOT_STARTED"]);
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
