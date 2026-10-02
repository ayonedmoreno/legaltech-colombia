/**
 * An OCR provider or engine (ARCHITECTURE_REPORT.md §2: `OcrProvider`). Which one the project uses
 * is decision P4, still open: no real implementation exists yet, only test doubles. A provider
 * never sees anything but the bytes of one `CLEAN` document and never receives its file name.
 */
export interface OcrProvider {
  /** Name of the provider or engine, recorded with every execution (decision OCR-A14). */
  readonly engine: string;
  /**
   * Whether the document leaves our infrastructure (a third party). With an external provider a
   * PDF may only be processed once P7 is resolved (decision OCR-A7).
   */
  readonly external: boolean;
  /** Reads the text of the document, one entry per page. */
  recognize(input: OcrInput): Promise<OcrOutput>;
}

export interface OcrInput {
  content: Buffer;
  contentType: "image/jpeg" | "image/png" | "application/pdf";
  /** Pages the worker accepts at most; a provider may refuse more without processing them. */
  maxPages: number;
}

export interface OcrOutput {
  /** The text of each page, as the provider produced it (normalized afterwards by the worker). */
  pages: string[];
  engineVersion: string | null;
}

/**
 * Normalized error codes (decision OCR-A10.6). They never carry the provider's own message, which
 * could contain text of the document (decision OCR-A11, point 7). The mapping from each provider's
 * errors to these codes is defined once P4 is decided.
 */
export const OCR_ERROR_CODES = [
  "timeout",
  "rate_limited",
  "provider_unavailable",
  "provider_error",
  "unsupported_document",
  "too_many_pages",
  "invalid_response",
  "object_missing",
  "object_mismatch",
  "storage_unavailable",
  "text_store_unavailable",
  "abandoned",
] as const;
export type OcrErrorCode = (typeof OCR_ERROR_CODES)[number];

/**
 * A provider's failure, already classified: a transient one is retried while attempts are left; a
 * permanent one (the document itself is the problem) ends the OCR at once, since retrying would
 * only cost money (decision OCR-A11, point 4).
 */
export class OcrProviderError extends Error {
  constructor(
    readonly kind: "transient" | "permanent",
    readonly code: OcrErrorCode,
    /** The provider's HTTP status, when it answered: the only detail that may be logged. */
    readonly httpStatus: number | null = null,
  ) {
    super(`OCR ${kind} error: ${code}`);
    this.name = "OcrProviderError";
  }
}
