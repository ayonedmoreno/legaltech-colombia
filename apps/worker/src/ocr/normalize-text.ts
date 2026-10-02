/**
 * Technical normalization only (decision OCR-A10.4, n1): Unicode NFC and line endings as "\n".
 * Nothing else changes (no case, spacing or look-alike characters): the owner reads the text as
 * the OCR produced it, and any semantic normalization belongs to the future extraction.
 */
export function normalizeOcrText(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/g, "\n");
}
