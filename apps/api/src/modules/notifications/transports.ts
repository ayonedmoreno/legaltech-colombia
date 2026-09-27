import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EmailMessage, EmailTransport } from "./notifications.types.js";

/** Rejects header values that could smuggle extra headers into a message. */
function assertSingleLine(value: string, field: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`email ${field} must be a single line`);
}

/** Test transport: keeps every message in memory. */
export class MemoryEmailTransport implements EmailTransport {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    assertSingleLine(message.to, "recipient");
    assertSingleLine(message.subject, "subject");
    this.sent.push(message);
  }
}

/**
 * Development transport (Sprint 1B decision P3): writes each message to its own file in a local
 * directory that git ignores, readable only by its owner. It never logs, and it is not a
 * production transport: real delivery is a pre-production barrier (SECURITY_SPEC.md).
 */
export class FileEmailTransport implements EmailTransport {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  async send(message: EmailMessage): Promise<void> {
    assertSingleLine(message.to, "recipient");
    assertSingleLine(message.subject, "subject");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.txt`;
    const content = `To: ${message.to}\nSubject: ${message.subject}\n\n${message.text}\n`;
    await writeFile(join(this.directory, name), content, { mode: 0o600, flag: "wx" });
  }
}
