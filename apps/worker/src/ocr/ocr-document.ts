import { createHash, randomUUID } from "node:crypto";
import { StorageObjectNotFoundError, type StorageProvider } from "@legaltech/storage";
import { normalizeOcrText } from "./normalize-text.js";
import { OcrProviderError, type OcrErrorCode, type OcrProvider } from "./ocr-provider.js";
import type { OcrTextStore } from "./ocr-text-store.js";
import type { OcrClaim, OcrRepository, OcrRepresentation } from "./ocr.types.js";

export interface OcrDocumentDeps {
  repository: OcrRepository;
  storage: StorageProvider;
  provider: OcrProvider;
  /** Where the text goes: decision OCR-A10.5, still open (no production implementation yet). */
  textStore: OcrTextStore;
  /** Which representation of a JPEG or PNG is processed: decision B3, set by configuration. */
  imageRepresentation: OcrRepresentation;
  /**
   * Whether this worker may process a PDF (decision OCR-A7): PDF OCR enabled and, with an external
   * provider, P7 resolved. Checked again for every job, since a PDF may have been queued under an
   * earlier configuration.
   */
  pdfAllowed: boolean;
  /** The values below come from the provider evaluation (B5, B6, B7): no defaults. */
  maxAttempts: number;
  leaseSeconds: number;
  maxPages: number;
  /** Delay before the first retry of a transient error; it doubles with each attempt. */
  retryDelaySeconds: number;
  /** Operational events: ids, codes and counts only, never text nor a provider's message. */
  log?: (event: Record<string, unknown>) => void;
  newId?: () => string;
}

export type OcrOutcome =
  /** Nothing to do: not CLEAN, not PENDING, or claimed by another worker (idempotent no-op). */
  | "skipped"
  | "completed"
  | "failed"
  /** A transient error with attempts left: back to PENDING, with a delayed retry job. */
  | "retry"
  /** Another worker took over the claim before this one could record its result. */
  | "lost"
  /** A PDF this worker may not process: EXCLUDED, without calling the provider (OCR-A7). */
  | "excluded";

const CONTENT_TYPES = { PDF: "application/pdf", JPEG: "image/jpeg", PNG: "image/png" } as const;

/** Longest delay between two retries of a transient error. */
const MAX_RETRY_DELAY_SECONDS = 3600;

/**
 * The `document.ocr` job (DATABASE_SPEC.md, "OCR del documento"): claim a CLEAN document → read
 * the representation the configuration chose → the provider → normalized text per page → the
 * text store → its OcrResult and audit event. The provider is never called without a valid claim.
 * A transient error goes back to PENDING with a delayed job while attempts are left; a permanent
 * one, or the last attempt, ends FAILED. Nothing here logs text or a provider's error message.
 */
export async function ocrDocument(deps: OcrDocumentDeps, documentId: string): Promise<OcrOutcome> {
  const claim = await deps.repository.claim(documentId, deps.leaseSeconds);
  if (!claim) return "skipped";
  // A PDF never reaches a provider this worker may not send it to (decision OCR-A7), even if it was
  // queued under an earlier configuration: it is EXCLUDED, reversible only by an explicit task.
  if (claim.fileType === "PDF" && !deps.pdfAllowed) {
    return (await deps.repository.markExcluded(claim)) ? "excluded" : "lost";
  }
  const newId = deps.newId ?? randomUUID;

  // A PDF is processed as received (rasterizing it is decision B4); an image as configured.
  const representation: OcrRepresentation =
    claim.fileType === "PDF" ? "ORIGINAL" : deps.imageRepresentation;
  let processedSha256: string | null = null;
  let engineVersion: string | null = null;

  let completed: { executionId: string; pages: number } | null = null;
  try {
    const content = await readRepresentation(deps.storage, claim, representation);
    processedSha256 = createHash("sha256").update(content).digest("hex");
    const output = await recognize(deps.provider, {
      content,
      contentType: CONTENT_TYPES[claim.fileType],
      maxPages: deps.maxPages,
    });
    engineVersion = output.engineVersion;
    if (output.pages.length > deps.maxPages) {
      throw new OcrProviderError("permanent", "too_many_pages");
    }
    const pages = output.pages.map(normalizeOcrText);

    const executionId = newId();
    try {
      await deps.textStore.save({
        executionId,
        documentId: claim.documentId,
        caseId: claim.caseId,
        pages,
      });
    } catch {
      throw new OcrProviderError("transient", "text_store_unavailable");
    }
    completed = { executionId, pages: pages.length };
  } catch (error) {
    const failure = classify(error);
    // Only the normalized code and, from a provider, its HTTP status (decision OCR-A11, point 7).
    deps.log?.({
      level: "warn",
      event: "ocr.error",
      document: claim.documentId,
      code: failure.code,
      kind: failure.kind,
      httpStatus: failure.httpStatus,
      attempts: claim.attempts,
    });
    if (failure.kind === "permanent" || claim.attempts >= deps.maxAttempts) {
      const recorded = await deps.repository.markFailed(claim, {
        id: newId(),
        engine: deps.provider.engine,
        engineVersion,
        representation,
        processedSha256,
        errorCode: failure.code,
      });
      return recorded ? "failed" : "lost";
    }
    const delay = Math.min(
      deps.retryDelaySeconds * 2 ** (claim.attempts - 1),
      MAX_RETRY_DELAY_SECONDS,
    );
    return (await deps.repository.releaseForRetry(claim, delay)) ? "retry" : "lost";
  }

  // Outside the classification above: a database failure here is not an OCR error. It propagates,
  // pg-boss retries the job, and an abandoned claim is recovered by the sweep after its lease.
  const recorded = await deps.repository.markCompleted(claim, {
    id: completed.executionId,
    engine: deps.provider.engine,
    engineVersion,
    representation,
    processedSha256: processedSha256!,
    pages: completed.pages,
  });
  return recorded ? "completed" : "lost";
}

async function readRepresentation(
  storage: StorageProvider,
  claim: OcrClaim,
  representation: OcrRepresentation,
): Promise<Buffer> {
  const key = representation === "ORIGINAL" ? claim.storageKey : claim.sanitizedStorageKey;
  if (!key) throw new OcrProviderError("permanent", "object_missing");
  let content: Buffer;
  try {
    content = await storage.getObject(key);
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      throw new OcrProviderError("permanent", "object_missing");
    }
    throw new OcrProviderError("transient", "storage_unavailable");
  }
  // The original must be exactly what was uploaded and analysed by the antivirus.
  if (representation === "ORIGINAL" && content.length !== claim.fileSize) {
    throw new OcrProviderError("permanent", "object_mismatch");
  }
  return content;
}

/** The provider's answer, refused unless it is one string per page. */
async function recognize(provider: OcrProvider, input: Parameters<OcrProvider["recognize"]>[0]) {
  const output = await provider.recognize(input);
  if (!Array.isArray(output.pages) || output.pages.some((page) => typeof page !== "string")) {
    throw new OcrProviderError("transient", "invalid_response");
  }
  return output;
}

/**
 * The error's normalized code and kind. Anything that is not an OcrProviderError (a provider that
 * throws its own error, with a message that could contain text of the document) becomes a
 * transient `provider_error`: its message is never kept.
 */
function classify(error: unknown): {
  kind: "transient" | "permanent";
  code: OcrErrorCode;
  httpStatus: number | null;
} {
  if (error instanceof OcrProviderError) {
    return { kind: error.kind, code: error.code, httpStatus: error.httpStatus };
  }
  return { kind: "transient", code: "provider_error", httpStatus: null };
}
