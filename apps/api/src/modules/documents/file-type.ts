import type { DocumentFileType } from "@legaltech/database";

/**
 * The file types a case accepts (PROJECT_SPEC.md s.9 step 4: PDF, JPG, PNG; photos and scans
 * arrive as one of them), detected from the content's signature (magic bytes), never from the
 * file name or the declared Content-Type (SECURITY_SPEC.md §11: "verificación del contenido real").
 */
const SIGNATURES: ReadonlyArray<{ type: DocumentFileType; bytes: readonly number[] }> = [
  // "%PDF-"
  { type: "PDF", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  // JPEG SOI marker followed by the start of the next marker.
  { type: "JPEG", bytes: [0xff, 0xd8, 0xff] },
  // PNG file signature.
  { type: "PNG", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
];

/** The MIME type each accepted file type is stored and served with. */
export const CONTENT_TYPES: Record<DocumentFileType, string> = {
  PDF: "application/pdf",
  JPEG: "image/jpeg",
  PNG: "image/png",
};

/** The accepted type the content starts with, or null for anything else. */
export function detectFileType(content: Uint8Array): DocumentFileType | null {
  const match = SIGNATURES.find(
    ({ bytes }) =>
      content.length >= bytes.length && bytes.every((byte, index) => content[index] === byte),
  );
  return match?.type ?? null;
}
