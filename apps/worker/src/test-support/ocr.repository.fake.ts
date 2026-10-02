import type { DocumentFileType } from "@legaltech/database";
import type {
  CompletedExecution,
  FailedExecution,
  OcrClaim,
  OcrRepository,
} from "../ocr/ocr.types.js";

type OcrState =
  "NOT_STARTED" | "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "NOT_APPLICABLE" | "EXCLUDED";

interface FakeDocument {
  id: string;
  caseId: string;
  status: "CLEAN" | "INFECTED" | "SCAN_FAILED" | "PENDING_SCAN";
  fileType: DocumentFileType;
  storageKey: string;
  sanitizedStorageKey: string | null;
  fileSize: number;
  ocrStatus: OcrState;
  ocrAttempts: number;
  token: string | null;
}

/**
 * In-memory OcrRepository mirroring the conditional statements of PrismaOcrRepository: only a
 * CLEAN document in PENDING is claimed, and only the current claim records a result.
 */
export class FakeOcrRepository implements OcrRepository {
  readonly documents = new Map<string, FakeDocument>();
  readonly completed: Array<{ documentId: string; execution: CompletedExecution }> = [];
  readonly failed: Array<{ documentId: string; execution: FailedExecution }> = [];
  readonly retries: Array<{ documentId: string; delaySeconds: number }> = [];
  private tick = 0;

  add(document: Partial<FakeDocument> & { id: string }): FakeDocument {
    const full: FakeDocument = {
      caseId: "11111111-1111-4111-8111-111111111111",
      status: "CLEAN",
      fileType: "JPEG",
      storageKey: `cases/x/documents/${document.id}`,
      sanitizedStorageKey: `cases/x/documents/${document.id}.sanitized`,
      fileSize: 0,
      ocrStatus: "PENDING",
      ocrAttempts: 0,
      token: null,
      ...document,
    };
    this.documents.set(full.id, full);
    return full;
  }

  async claim(documentId: string): Promise<OcrClaim | null> {
    const doc = this.documents.get(documentId);
    if (!doc || doc.status !== "CLEAN" || doc.ocrStatus !== "PENDING") return null;
    doc.ocrStatus = "PROCESSING";
    doc.ocrAttempts += 1;
    doc.token = `t${++this.tick}`;
    return {
      documentId: doc.id,
      caseId: doc.caseId,
      fileType: doc.fileType,
      storageKey: doc.storageKey,
      sanitizedStorageKey: doc.sanitizedStorageKey,
      fileSize: doc.fileSize,
      attempts: doc.ocrAttempts,
      token: doc.token,
    };
  }

  async markCompleted(claim: OcrClaim, execution: CompletedExecution): Promise<boolean> {
    const doc = this.current(claim);
    if (!doc) return false;
    doc.ocrStatus = "COMPLETED";
    this.completed.push({ documentId: doc.id, execution });
    return true;
  }

  async markFailed(claim: OcrClaim, execution: FailedExecution): Promise<boolean> {
    const doc = this.current(claim);
    if (!doc) return false;
    doc.ocrStatus = "FAILED";
    this.failed.push({ documentId: doc.id, execution });
    return true;
  }

  async releaseForRetry(claim: OcrClaim, delaySeconds: number): Promise<boolean> {
    const doc = this.current(claim);
    if (!doc) return false;
    doc.ocrStatus = "PENDING";
    doc.token = null;
    this.retries.push({ documentId: doc.id, delaySeconds });
    return true;
  }

  /** Test hook: another worker takes over the claim. */
  steal(documentId: string): void {
    const doc = this.documents.get(documentId)!;
    doc.token = `stolen${++this.tick}`;
  }

  private current(claim: OcrClaim): FakeDocument | null {
    const doc = this.documents.get(claim.documentId);
    return doc && doc.ocrStatus === "PROCESSING" && doc.token === claim.token ? doc : null;
  }
}
