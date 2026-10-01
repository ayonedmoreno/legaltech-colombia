import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { requestHandlerOptions, S3StorageProvider, STORAGE_TIMEOUTS } from "./s3-storage.js";
import type { StorageEnv } from "./storage-env.js";

/**
 * The storage never makes a request wait forever (decision of 2026-10-01). These tests use the
 * real SDK against real sockets: a local server that accepts connections and never answers (a
 * storage that hangs) and a closed port (a storage that is down).
 */
const env = (endpoint: string): StorageEnv => ({
  STORAGE_BUCKET: "timeouts",
  STORAGE_REGION: "us-east-1",
  STORAGE_ENDPOINT: endpoint,
  STORAGE_PUBLIC_ENDPOINT: undefined,
  STORAGE_FORCE_PATH_STYLE: true,
  STORAGE_ACCESS_KEY_ID: "test",
  STORAGE_SECRET_ACCESS_KEY: "test",
});

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** Accepts every connection, reads what is sent and never answers. Counts the connections. */
async function hangingServer(): Promise<{ endpoint: string; connections: () => number }> {
  let count = 0;
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    count += 1;
    sockets.push(socket);
    socket.on("data", () => {});
    socket.on("error", () => {});
  });
  server.on("close", () => sockets.forEach((s) => s.destroy()));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return { endpoint: `http://127.0.0.1:${port}`, connections: () => count };
}

const SHORT = { connectionTimeoutMs: 300, socketTimeoutMs: 400, requestTimeoutMs: 600 };

describe("storage timeouts", () => {
  it("uses the decided timeouts, and a timed-out request is an error", () => {
    expect(STORAGE_TIMEOUTS).toEqual({
      connectionTimeoutMs: 5_000,
      socketTimeoutMs: 30_000,
      requestTimeoutMs: 45_000,
    });
    expect(requestHandlerOptions()).toEqual({
      connectionTimeout: 5_000,
      socketTimeout: 30_000,
      requestTimeout: 45_000,
      throwOnRequestTimeout: true,
    });
  });

  it("gives up on a storage that never answers, after the SDK's standard retries", async () => {
    const hanging = await hangingServer();
    const storage = new S3StorageProvider(env(hanging.endpoint), { timeouts: SHORT });

    const started = Date.now();
    const error = await storage.getObject("cases/x/documents/y").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("TimeoutError");
    // Bounded: three attempts of at most the request timeout each, plus the backoff between them.
    expect(Date.now() - started).toBeLessThan(15_000);
    // Retried: the standard strategy makes three attempts.
    expect(hanging.connections()).toBe(3);
  }, 30_000);

  it("fails an upload to a hanging storage instead of waiting for it", async () => {
    const hanging = await hangingServer();
    const storage = new S3StorageProvider(env(hanging.endpoint), { timeouts: SHORT });

    await expect(
      storage.putObject({
        key: "k",
        body: Buffer.from("%PDF-1.7"),
        contentType: "application/pdf",
      }),
    ).rejects.toThrow();
  }, 30_000);

  it("fails fast when the storage is down (connection refused)", async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as net.AddressInfo;
    await new Promise((r) => closed.close(r));
    const storage = new S3StorageProvider(env(`http://127.0.0.1:${port}`), { timeouts: SHORT });

    const started = Date.now();
    await expect(storage.getObject("k")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
