/**
 * Antivirus behind an interface (ADR-001 style: providers never leak into the domain). The only
 * implementation is ClamAV running inside our infrastructure: no document leaves it.
 */
export type ScanVerdict = { kind: "clean" } | { kind: "infected"; signature: string };

export interface AntivirusProvider {
  /**
   * Scans the whole content. Resolves only with a definite verdict; anything else (engine down,
   * timeout, unexpected answer) rejects with AntivirusError, and is never taken as "clean".
   */
  scan(content: Buffer): Promise<ScanVerdict>;
}

/** The antivirus could not give a definite verdict. Always retried, never treated as clean. */
export class AntivirusError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AntivirusError";
  }
}
