import type { Document } from "@legaltech/contracts";
import type { DocumentRecord } from "./documents.types.js";

/** Public shape of a document (API_SPEC.md `Document`): no storage key, no uploader. */
export function toPublicDocument(record: DocumentRecord): Document {
  return {
    id: record.id,
    fileName: record.fileName,
    fileType: record.fileType,
    fileSize: record.fileSize,
    status: record.status,
    ocrStatus: record.ocrStatus,
    createdAt: record.createdAt.toISOString(),
  };
}
