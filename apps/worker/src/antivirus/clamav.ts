import net from "node:net";
import { AntivirusError, type AntivirusProvider, type ScanVerdict } from "./antivirus.js";

export interface ClamAvOptions {
  host: string;
  port: number;
  /** Whole-scan budget: connecting, streaming and waiting for the verdict. */
  timeoutMs: number;
}

/** clamd INSTREAM chunk size (the length prefix is 4 bytes, big-endian). */
const CHUNK_BYTES = 64 * 1024;
/** Longest answer we accept; a verdict line is short. */
const MAX_REPLY_BYTES = 1024;
/** What a detection name may look like (e.g. "Win.Test.EICAR_HDB-1"). */
const SIGNATURE = /^[A-Za-z0-9_.:\-/]{1,200}$/;

/**
 * Parses clamd's answer to INSTREAM strictly. Only the exact "stream: OK" is clean; only
 * "stream: <name> FOUND" with a plausible name is infected. Everything else — errors, size-limit
 * answers, truncated or unexpected text — is an AntivirusError, never a verdict.
 */
export function parseClamdReply(reply: string): ScanVerdict {
  const line = reply.replace(/\0$/, "");
  if (line === "stream: OK") return { kind: "clean" };
  const found = /^stream: (.+) FOUND$/.exec(line);
  if (found && SIGNATURE.test(found[1]!)) return { kind: "infected", signature: found[1]! };
  throw new AntivirusError(`unexpected clamd reply: ${JSON.stringify(line.slice(0, 200))}`);
}

/** ClamAV through clamd's INSTREAM command (the file is streamed; clamd never reads our disk). */
export class ClamAvProvider implements AntivirusProvider {
  constructor(private readonly options: ClamAvOptions) {}

  scan(content: Buffer): Promise<ScanVerdict> {
    return new Promise<ScanVerdict>((resolve, reject) => {
      const socket = net.connect({ host: this.options.host, port: this.options.port });
      const chunks: Buffer[] = [];
      let received = 0;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(
          error instanceof AntivirusError
            ? error
            : new AntivirusError("clamd is unavailable", { cause: error }),
        );
      };
      const timer = setTimeout(
        () => fail(new AntivirusError(`clamd did not answer in ${this.options.timeoutMs} ms`)),
        this.options.timeoutMs,
      );

      socket.on("error", fail);
      socket.on("data", (data) => {
        received += data.length;
        if (received > MAX_REPLY_BYTES) {
          fail(new AntivirusError("clamd reply too long"));
          return;
        }
        chunks.push(data);
      });
      socket.on("end", () => {
        clearTimeout(timer);
        if (settled) return;
        try {
          const verdict = parseClamdReply(Buffer.concat(chunks).toString("utf8"));
          settled = true;
          resolve(verdict);
        } catch (error) {
          fail(error);
        }
      });
      socket.on("close", () => {
        clearTimeout(timer);
        if (!settled) fail(new AntivirusError("clamd closed the connection without a verdict"));
      });
      socket.on("connect", () => {
        socket.write("zINSTREAM\0");
        for (let offset = 0; offset < content.length; offset += CHUNK_BYTES) {
          const chunk = content.subarray(offset, offset + CHUNK_BYTES);
          const length = Buffer.alloc(4);
          length.writeUInt32BE(chunk.length);
          socket.write(length);
          socket.write(chunk);
        }
        // A zero-length chunk ends the stream; clamd then answers and closes.
        socket.end(Buffer.alloc(4));
      });
    });
  }
}
