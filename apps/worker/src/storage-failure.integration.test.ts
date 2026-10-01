import net from "node:net";
import type { PrismaClient } from "@legaltech/database";
import { S3StorageProvider } from "@legaltech/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AntivirusProvider } from "./antivirus/antivirus.js";
import { PrismaScanRepository } from "./scan/scan.repository.js";
import { scanDocument } from "./scan/scan-document.js";
import { clients, hasDatabase, seedDocument } from "./test-support/integration.js";

/**
 * The treatment when the storage hangs (decision of 2026-10-01: storage timeouts), with the real
 * SDK against a socket that never answers and the document in real PostgreSQL as the worker role:
 * the attempt fails within its timeouts, is released for a retry and never ends CLEAN.
 */
describe.skipIf(!hasDatabase)("treatment with a hanging storage (integration)", () => {
  let app: PrismaClient;
  let worker: PrismaClient;
  let server: net.Server;
  let endpoint: string;
  const sockets: net.Socket[] = [];

  beforeAll(async () => {
    ({ app, worker } = clients());
    server = net.createServer((socket) => {
      sockets.push(socket);
      socket.on("data", () => {});
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  });

  afterAll(async () => {
    sockets.forEach((s) => s.destroy());
    await new Promise((resolve) => server?.close(resolve));
    await app?.$disconnect();
    await worker?.$disconnect();
  });

  function deps(maxAttempts: number) {
    const storage = new S3StorageProvider(
      {
        STORAGE_BUCKET: "hanging",
        STORAGE_REGION: "us-east-1",
        STORAGE_ENDPOINT: endpoint,
        STORAGE_PUBLIC_ENDPOINT: undefined,
        STORAGE_FORCE_PATH_STYLE: true,
        STORAGE_ACCESS_KEY_ID: "test",
        STORAGE_SECRET_ACCESS_KEY: "test",
      },
      { timeouts: { connectionTimeoutMs: 300, socketTimeoutMs: 400, requestTimeoutMs: 600 } },
    );
    const antivirus: AntivirusProvider = {
      scan: () => Promise.reject(new Error("the antivirus must never be reached")),
    };
    return {
      repository: new PrismaScanRepository(worker),
      storage,
      antivirus,
      maxAttempts,
      leaseSeconds: 600,
    };
  }

  it("fails the attempt within the timeouts and releases the document for a retry", async () => {
    const document = await seedDocument(app, { fileType: "PDF", fileSize: 10 });

    const started = Date.now();
    await expect(scanDocument(deps(5), document.id)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(15_000);

    const after = await app.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(after.status).toBe("PENDING_SCAN");
    expect(after.scanAttempts).toBe(1);
  }, 30_000);

  it("ends SCAN_FAILED, never CLEAN, when the last attempt meets the hanging storage", async () => {
    const document = await seedDocument(app, { fileType: "PDF", fileSize: 10 });

    expect(await scanDocument(deps(1), document.id)).toBe("failed");

    const after = await app.document.findUniqueOrThrow({ where: { id: document.id } });
    expect(after.status).toBe("SCAN_FAILED");
  }, 30_000);
});
