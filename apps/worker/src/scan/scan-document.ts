import type { StorageProvider } from "@legaltech/storage";
import type { AntivirusProvider } from "../antivirus/antivirus.js";
import { stripJpegMetadata, stripPngMetadata } from "../sanitize/image-metadata.js";
import type { ScanClaim, ScanRepository } from "./scan.types.js";

export interface ScanDocumentDeps {
  repository: ScanRepository;
  storage: StorageProvider;
  antivirus: AntivirusProvider;
  maxAttempts: number;
  leaseSeconds: number;
}

export type ScanOutcome =
  /** Nothing to do: already treated, or being treated by another worker (idempotent no-op). */
  | "skipped"
  | "clean"
  | "infected"
  /** No attempts left: SCAN_FAILED. */
  | "failed"
  /** Another worker took over the claim before this one could record its result. */
  | "lost";

const IMAGE_CONTENT_TYPES = { JPEG: "image/jpeg", PNG: "image/png" } as const;

/** Key of the derived copy without metadata: next to the original, which is never touched. */
export function sanitizedKeyOf(storageKey: string): string {
  return `${storageKey}.sanitized`;
}

/**
 * The `document.scan` job (DATABASE_SPEC.md, "Tratamiento de seguridad del documento"):
 * claim → read the original → antivirus → (JPEG/PNG) copy without metadata → record the result
 * with its audit event. A transient error releases the claim and is rethrown, so pg-boss retries
 * the job; once the attempts are used up the document ends SCAN_FAILED. Nothing ever ends CLEAN
 * unless the antivirus said so explicitly and the copy (for images) was stored.
 */
export async function scanDocument(
  deps: ScanDocumentDeps,
  documentId: string,
): Promise<ScanOutcome> {
  const claim = await deps.repository.claim(documentId, deps.leaseSeconds);
  if (!claim) return "skipped";

  try {
    const content = await deps.storage.getObject(claim.storageKey);
    if (content.length !== claim.fileSize) {
      throw new Error("the stored object does not have the size recorded at upload");
    }
    const verdict = await deps.antivirus.scan(content);
    if (verdict.kind === "infected") {
      // The original stays private and untouched; it can never be downloaded.
      return (await deps.repository.markInfected(claim, verdict.signature)) ? "infected" : "lost";
    }
    const sanitizedKey = await storeSanitizedCopy(deps.storage, claim, content);
    return (await deps.repository.markClean(claim, sanitizedKey)) ? "clean" : "lost";
  } catch (error) {
    if (claim.attempts >= deps.maxAttempts) {
      await deps.repository.markFailed(claim);
      return "failed";
    }
    await deps.repository.release(claim);
    throw error;
  }
}

/** For JPEG and PNG, the copy the download will serve; PDFs are served as received (null). */
async function storeSanitizedCopy(
  storage: StorageProvider,
  claim: ScanClaim,
  content: Buffer,
): Promise<string | null> {
  if (claim.fileType === "PDF") return null;
  const sanitized =
    claim.fileType === "JPEG" ? stripJpegMetadata(content) : stripPngMetadata(content);
  const key = sanitizedKeyOf(claim.storageKey);
  await storage.putObject({
    key,
    body: sanitized,
    contentType: IMAGE_CONTENT_TYPES[claim.fileType],
  });
  return key;
}
