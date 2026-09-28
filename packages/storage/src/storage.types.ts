/**
 * Private object storage (ADR-001 point 8; ARCHITECTURE_REPORT §2): an S3-compatible bucket
 * behind this interface, so the provider and region (P3) can change without touching the
 * domain. Files never go into PostgreSQL (PROJECT_SPEC.md s.16).
 */
export interface StorageProvider {
  /** Stores an object under `key`, replacing nothing: keys are always new. */
  putObject(input: { key: string; body: Buffer; contentType: string }): Promise<void>;
  /**
   * Reads a whole object (the worker reads an original to scan it). Throws
   * StorageObjectNotFoundError when there is no object under `key`.
   */
  getObject(key: string): Promise<Buffer>;
  /** Removes an object (used to undo an upload whose database write failed). */
  deleteObject(key: string): Promise<void>;
  /**
   * A presigned URL that downloads the object for `expiresInSeconds`, as an attachment named
   * `fileName` and with the given `contentType`. Only issued after the API has authorized the
   * request (SECURITY_SPEC.md §11).
   */
  createDownloadUrl(input: {
    key: string;
    fileName: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<string>;
}

/** There is no object under the requested key. */
export class StorageObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`No stored object under key ${key}`);
    this.name = "StorageObjectNotFoundError";
  }
}

/**
 * `Content-Disposition` for a download: always an attachment (never rendered inline by the
 * browser), with an ASCII fallback name and the exact UTF-8 name (RFC 6266 / RFC 5987).
 */
export function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
