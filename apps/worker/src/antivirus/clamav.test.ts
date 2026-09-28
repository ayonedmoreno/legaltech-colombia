import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { AntivirusError } from "./antivirus.js";
import { ClamAvProvider, parseClamdReply } from "./clamav.js";

describe("clamd reply parsing (never clean by default)", () => {
  it("reads the exact clean and infected answers", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({ kind: "clean" });
    expect(parseClamdReply("stream: Win.Test.EICAR_HDB-1 FOUND\0")).toEqual({
      kind: "infected",
      signature: "Win.Test.EICAR_HDB-1",
    });
  });

  it.each([
    ["an error", "INSTREAM size limit exceeded. ERROR\0"],
    ["an empty reply", ""],
    ["a truncated OK", "stream: O"],
    ["OK followed by more text", "stream: OK\0stream: OK\0"],
    ["a lowercase ok", "stream: ok\0"],
    ["a FOUND without a name", "stream:  FOUND\0"],
    ["a FOUND with an odd name", "stream: <script> FOUND\0"],
    ["another command's answer", "PONG\0"],
    ["two lines", "stream: OK\nstream: OK\0"],
  ])("refuses %s", (_label, reply) => {
    expect(() => parseClamdReply(reply)).toThrow(AntivirusError);
  });
});

/** A fake clamd: records the INSTREAM payload it receives and answers as told. */
function fakeClamd(behaviour: (received: Buffer, socket: net.Socket) => void) {
  const received: Buffer[] = [];
  // Half-open: the fake decides when (and whether) to answer and close.
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (data) => chunks.push(data));
    socket.on("end", () => {
      const all = Buffer.concat(chunks);
      received.push(all);
      behaviour(all, socket);
    });
  });
  return new Promise<{ server: net.Server; port: number; received: Buffer[] }>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as net.AddressInfo).port, received }),
    ),
  );
}

/** Reassembles the file from an INSTREAM payload: "zINSTREAM\0", then length-prefixed chunks. */
function decodeInstream(payload: Buffer): Buffer {
  expect(payload.subarray(0, 10).toString("latin1")).toBe("zINSTREAM\0");
  const parts: Buffer[] = [];
  let offset = 10;
  for (;;) {
    const length = payload.readUInt32BE(offset);
    offset += 4;
    if (length === 0) break;
    expect(length).toBeLessThanOrEqual(64 * 1024);
    parts.push(payload.subarray(offset, offset + length));
    offset += length;
  }
  expect(offset).toBe(payload.length);
  return Buffer.concat(parts);
}

describe("ClamAvProvider (INSTREAM over TCP)", () => {
  const servers: net.Server[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
  });

  it("streams the whole file in chunks and returns clamd's verdict", async () => {
    const clamd = await fakeClamd((_, socket) => socket.end("stream: OK\0"));
    servers.push(clamd.server);
    const content = Buffer.alloc(200_000, 7);

    const verdict = await new ClamAvProvider({
      host: "127.0.0.1",
      port: clamd.port,
      timeoutMs: 5_000,
    }).scan(content);

    expect(verdict).toEqual({ kind: "clean" });
    expect(decodeInstream(clamd.received[0]!).equals(content)).toBe(true);
  });

  it("reports a detection with its signature", async () => {
    const clamd = await fakeClamd((_, socket) =>
      socket.end("stream: Eicar-Test-Signature FOUND\0"),
    );
    servers.push(clamd.server);
    const provider = new ClamAvProvider({ host: "127.0.0.1", port: clamd.port, timeoutMs: 5_000 });

    expect(await provider.scan(Buffer.from("x"))).toEqual({
      kind: "infected",
      signature: "Eicar-Test-Signature",
    });
  });

  it.each([
    ["clamd's error answer", (socket: net.Socket) => socket.end("stream: ERROR\0")],
    ["an unexpected answer", (socket: net.Socket) => socket.end("hello\0")],
    ["a connection closed without an answer", (socket: net.Socket) => socket.end()],
    ["an answer that never ends", (socket: net.Socket) => socket.write("x".repeat(2048))],
  ])("rejects on %s", async (_label, answer) => {
    const clamd = await fakeClamd((_, socket) => answer(socket));
    servers.push(clamd.server);
    const provider = new ClamAvProvider({ host: "127.0.0.1", port: clamd.port, timeoutMs: 2_000 });

    await expect(provider.scan(Buffer.from("x"))).rejects.toBeInstanceOf(AntivirusError);
  });

  it("rejects when clamd does not answer in time", async () => {
    const clamd = await fakeClamd(() => {
      /* never answers */
    });
    servers.push(clamd.server);
    const provider = new ClamAvProvider({ host: "127.0.0.1", port: clamd.port, timeoutMs: 300 });

    await expect(provider.scan(Buffer.from("x"))).rejects.toThrow(/did not answer/);
  });

  it("rejects when clamd is not reachable", async () => {
    const clamd = await fakeClamd(() => {});
    const { port } = clamd;
    await new Promise((resolve) => clamd.server.close(resolve));
    const provider = new ClamAvProvider({ host: "127.0.0.1", port, timeoutMs: 2_000 });

    await expect(provider.scan(Buffer.from("x"))).rejects.toBeInstanceOf(AntivirusError);
  });
});
