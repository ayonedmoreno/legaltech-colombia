import type { DocumentFileType, DocumentStatus } from "@legaltech/database";
import type { ScanClaim, ScanRepository } from "../scan/scan.types.js";

export interface FakeDocument {
  id: string;
  caseId: string;
  fileType: DocumentFileType;
  storageKey: string;
  fileSize: number;
  status: DocumentStatus;
  scanAttempts: number;
  scanStartedAt: string | null;
  scanSignature: string | null;
  sanitizedStorageKey: string | null;
}

/**
 * In-memory ScanRepository with the Prisma one's semantics: conditional claim (PENDING_SCAN, or a
 * SCANNING claim older than the lease), and results fenced by the claim token. Every call is
 * synchronous inside, so concurrent jobs interleave only between calls, as with a real database.
 */
export class FakeScanRepository implements ScanRepository {
  readonly documents = new Map<string, FakeDocument>();
  readonly auditLog: Array<{
    action: string;
    documentId: string;
    caseId: string;
    newValue: object;
  }> = [];
  /** Test hook: stands in for PostgreSQL's clock (milliseconds). */
  now = () => Date.now();
  private tick = 0;

  add(document: Partial<FakeDocument> & Pick<FakeDocument, "id" | "fileType" | "fileSize">) {
    this.documents.set(document.id, {
      caseId: "case-1",
      storageKey: `cases/case-1/documents/${document.id}`,
      status: "PENDING_SCAN",
      scanAttempts: 0,
      scanStartedAt: null,
      scanSignature: null,
      sanitizedStorageKey: null,
      ...document,
    });
  }

  async claim(documentId: string, leaseSeconds: number): Promise<ScanClaim | null> {
    const document = this.documents.get(documentId);
    if (!document) return null;
    const abandoned =
      document.status === "SCANNING" &&
      document.scanStartedAt !== null &&
      Number(document.scanStartedAt.split("#")[0]) < this.now() - leaseSeconds * 1000;
    if (document.status !== "PENDING_SCAN" && !abandoned) return null;
    document.status = "SCANNING";
    document.scanAttempts += 1;
    // Unique like PostgreSQL's microsecond clock_timestamp().
    document.scanStartedAt = `${this.now()}#${++this.tick}`;
    return {
      documentId,
      caseId: document.caseId,
      fileType: document.fileType,
      storageKey: document.storageKey,
      fileSize: document.fileSize,
      attempts: document.scanAttempts,
      token: document.scanStartedAt,
    };
  }

  private holds(claim: ScanClaim): FakeDocument | null {
    const document = this.documents.get(claim.documentId);
    return document && document.status === "SCANNING" && document.scanStartedAt === claim.token
      ? document
      : null;
  }

  async markClean(claim: ScanClaim, sanitizedStorageKey: string | null): Promise<boolean> {
    const document = this.holds(claim);
    if (!document) return false;
    document.status = "CLEAN";
    document.sanitizedStorageKey = sanitizedStorageKey;
    this.audit("document.scan_clean", claim, { status: "CLEAN" });
    return true;
  }

  async markInfected(claim: ScanClaim, signature: string): Promise<boolean> {
    const document = this.holds(claim);
    if (!document) return false;
    document.status = "INFECTED";
    document.scanSignature = signature;
    this.audit("document.scan_infected", claim, { status: "INFECTED", signature });
    return true;
  }

  async markFailed(claim: ScanClaim): Promise<boolean> {
    const document = this.holds(claim);
    if (!document) return false;
    document.status = "SCAN_FAILED";
    this.audit("document.scan_failed", claim, { status: "SCAN_FAILED", attempts: claim.attempts });
    return true;
  }

  async release(claim: ScanClaim): Promise<boolean> {
    const document = this.holds(claim);
    if (!document) return false;
    document.status = "PENDING_SCAN";
    document.scanStartedAt = null;
    return true;
  }

  private audit(action: string, claim: ScanClaim, newValue: object) {
    this.auditLog.push({ action, documentId: claim.documentId, caseId: claim.caseId, newValue });
  }
}
