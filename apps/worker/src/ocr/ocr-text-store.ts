/**
 * Where the text of an OCR execution is kept: decision OCR-A10.5 (PostgreSQL or private object
 * storage, and whether it counts toward the quota), still open until the B8 measurement. No
 * implementation exists yet, so the worker refuses to run the OCR (assertOcrStartupPreconditions).
 *
 * The text is stored per page (decision OCR-A10.4), already normalized, unverified and untrusted
 * (OCR-A3, OCR-A13): it is never logged and never written to the audit log. The text of earlier
 * executions is kept (OCR-A10.3 (ii)). How the store and the result row are kept consistent when
 * a claim is lost after the text was saved is part of decision OCR-A10.5.
 */
export interface OcrTextStore {
  save(input: OcrTextInput): Promise<void>;
}

export interface OcrTextInput {
  /** Id of the OCR execution (the OcrResult row) the text belongs to. */
  executionId: string;
  documentId: string;
  caseId: string;
  pages: string[];
}
