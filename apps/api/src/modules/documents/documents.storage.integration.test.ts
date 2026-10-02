import { randomUUID } from "node:crypto";
import net from "node:net";
import { createPrismaClient, type PrismaClient } from "@legaltech/database";
import {
  ensureDevelopmentBucket,
  S3StorageProvider,
  StorageObjectNotFoundError,
  type StorageEnv,
} from "@legaltech/storage";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "../../common/http-error.js";
import { PgBossJobQueue, startPgBossForApi } from "../../jobs/job-queue.js";
import type { CurrentUserResult } from "../auth/auth.service.js";
import { PrismaCasesRepository } from "../cases/cases.repository.js";
import { PrismaDocumentsRepository } from "./documents.repository.js";
import { DocumentsService } from "./documents.service.js";

/**
 * Storage ↔ database compensation of an upload, with real PostgreSQL (application role), real
 * pg-boss and the real S3 SDK (decision of 2026-10-01): a failed storage write leaves no document,
 * and a failed database write leaves no object in SeaweedFS.
 */
const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
const s3Endpoint = process.env.INTEGRATION_S3_ENDPOINT;

describe.skipIf(!databaseUrl || !s3Endpoint)("upload compensation (PostgreSQL + S3)", () => {
  let prisma: PrismaClient;
  let boss: PgBoss;
  let cases: PrismaCasesRepository;
  let server: net.Server;
  const sockets: net.Socket[] = [];
  const log = { errors: [] as string[], error: (_o: object, m: string) => log.errors.push(m) };
  const PDF = Buffer.from("%PDF-1.7\ncompensación\n%%EOF\n");

  const storageEnv = (endpoint: string, bucket: string): StorageEnv => ({
    STORAGE_BUCKET: bucket,
    STORAGE_REGION: "us-east-1",
    STORAGE_ENDPOINT: endpoint,
    STORAGE_PUBLIC_ENDPOINT: undefined,
    STORAGE_FORCE_PATH_STYLE: true,
    STORAGE_ACCESS_KEY_ID: process.env.INTEGRATION_S3_ACCESS_KEY_ID ?? "",
    STORAGE_SECRET_ACCESS_KEY: process.env.INTEGRATION_S3_SECRET_ACCESS_KEY ?? "",
  });

  beforeAll(async () => {
    prisma = createPrismaClient(databaseUrl!);
    boss = await startPgBossForApi(databaseUrl!);
    cases = new PrismaCasesRepository(prisma);
    server = net.createServer((socket) => {
      sockets.push(socket);
      socket.on("data", () => {});
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  }, 60_000);

  afterAll(async () => {
    sockets.forEach((s) => s.destroy());
    await new Promise((resolve) => server?.close(resolve));
    await boss?.stop({ graceful: false });
    await prisma?.$disconnect();
  });

  async function owner(): Promise<{ current: CurrentUserResult; caseId: string }> {
    const user = await prisma.user.create({
      data: {
        email: `it-${randomUUID()}@example.com`,
        passwordHash: "$argon2id$integration-test-placeholder",
        fullName: "Integración",
      },
    });
    const created = await cases.createCase({
      userId: user.id,
      type: "OTHER",
      audit: (r) => ({
        actorUserId: user.id,
        actorRole: "USER",
        action: "case.created",
        entityType: "Case",
        entityId: r.id,
        requestId: null,
        ip: null,
        userAgent: null,
      }),
    });
    const current = {
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: "USER",
        emailVerified: false,
        createdAt: user.createdAt.toISOString(),
      },
      session: {},
      actor: { id: user.id, role: "USER", status: "ACTIVE" },
    } as unknown as CurrentUserResult;
    return { current, caseId: created.id };
  }

  const context = { ip: "203.0.113.5", userAgent: "integration-test", requestId: randomUUID() };
  const documentsOf = (caseId: string) => prisma.document.count({ where: { caseId } });
  const uploadedEvents = (caseId: string) =>
    prisma.auditLog.count({ where: { caseId, action: "document.uploaded" } });

  it("answers 503 and keeps no document when the storage does not answer", async () => {
    const { current, caseId } = await owner();
    const { port } = server.address() as net.AddressInfo;
    const service = new DocumentsService({
      repository: new PrismaDocumentsRepository(prisma, new PgBossJobQueue(boss)),
      cases,
      storage: new S3StorageProvider(storageEnv(`http://127.0.0.1:${port}`, "hanging"), {
        timeouts: { connectionTimeoutMs: 300, socketTimeoutMs: 400, requestTimeoutMs: 600 },
      }),
      downloadUrlTtlSeconds: 60,
    });

    const error = await service
      .uploadDocument(current, caseId, { fileName: "a.pdf", content: PDF }, context, log)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).statusCode).toBe(503);
    expect(await documentsOf(caseId)).toBe(0);
    expect(await uploadedEvents(caseId)).toBe(0);
  }, 30_000);

  it("removes the stored object when the database write fails afterwards", async () => {
    const { current, caseId } = await owner();
    const env = storageEnv(s3Endpoint!, `it-${randomUUID()}`);
    await ensureDevelopmentBucket(env);
    const real = new S3StorageProvider(env);
    const written: string[] = [];
    const recording = Object.assign(Object.create(real) as S3StorageProvider, {
      putObject: async (input: { key: string; body: Buffer; contentType: string }) => {
        await real.putObject(input);
        written.push(input.key);
      },
    });
    const service = new DocumentsService({
      // The row, its event and its job are one transaction: a failing enqueue rolls it all back.
      repository: new PrismaDocumentsRepository(prisma, {
        enqueueDocumentScan: () => Promise.reject(new Error("queue unavailable")),
        enqueueDocumentReprocess: () => Promise.reject(new Error("not used")),
        enqueueDocumentOcrReprocess: () => Promise.reject(new Error("not used")),
      }),
      cases,
      storage: recording,
      downloadUrlTtlSeconds: 60,
    });

    await expect(
      service.uploadDocument(current, caseId, { fileName: "a.pdf", content: PDF }, context, log),
    ).rejects.toThrow("queue unavailable");

    expect(written).toHaveLength(1);
    await expect(real.getObject(written[0]!)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    expect(await documentsOf(caseId)).toBe(0);
    expect(await uploadedEvents(caseId)).toBe(0);
  }, 30_000);

  it("stores object and row together when both work", async () => {
    const { current, caseId } = await owner();
    const env = storageEnv(s3Endpoint!, `it-${randomUUID()}`);
    await ensureDevelopmentBucket(env);
    const service = new DocumentsService({
      repository: new PrismaDocumentsRepository(prisma, new PgBossJobQueue(boss)),
      cases,
      storage: new S3StorageProvider(env),
      downloadUrlTtlSeconds: 60,
    });

    const document = await service.uploadDocument(
      current,
      caseId,
      { fileName: "a.pdf", content: PDF },
      context,
      log,
    );

    const row = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    expect((await new S3StorageProvider(env).getObject(row.storageKey)).equals(PDF)).toBe(true);
    expect(await uploadedEvents(caseId)).toBe(1);
  }, 30_000);

  /**
   * In front of the real SeaweedFS: forwards each request but drops every answer, so a PutObject
   * is really stored while the API only sees a timeout. DELETE requests are forwarded the same way,
   * or not at all (a removal that cannot reach the storage).
   */
  async function answerDroppingProxy(forwardDeletes: boolean) {
    const target = new URL(s3Endpoint!);
    const counts = { forwarded: 0, blockedDeletes: 0 };
    const proxy = net.createServer((client) => {
      let upstream: net.Socket | null = null;
      let decided = false;
      client.on("data", (chunk) => {
        if (!decided) {
          decided = true;
          if (chunk.toString("latin1", 0, 7) === "DELETE " && !forwardDeletes) {
            counts.blockedDeletes += 1;
            return;
          }
          counts.forwarded += 1;
          upstream = net.connect(Number(target.port), target.hostname);
          upstream.on("data", () => {}); // the answer never reaches the API
          upstream.on("error", () => {});
        }
        upstream?.write(chunk);
      });
      client.on("error", () => {});
      client.on("close", () => upstream?.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const { port } = proxy.address() as net.AddressInfo;
    return {
      endpoint: `http://127.0.0.1:${port}`,
      counts,
      close: () => new Promise((r) => proxy.close(r)),
    };
  }

  async function uploadThrough(endpoint: string, bucket: string) {
    const { current, caseId } = await owner();
    const logged: Array<Record<string, unknown>> = [];
    const service = new DocumentsService({
      repository: new PrismaDocumentsRepository(prisma, new PgBossJobQueue(boss)),
      cases,
      storage: new S3StorageProvider(storageEnv(endpoint, bucket), {
        timeouts: { connectionTimeoutMs: 300, socketTimeoutMs: 400, requestTimeoutMs: 600 },
      }),
      downloadUrlTtlSeconds: 60,
    });
    const error = await service
      .uploadDocument(current, caseId, { fileName: "a.pdf", content: PDF }, context, {
        error: (object: object) => logged.push(object as Record<string, unknown>),
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    const orphan = logged.find((entry) => entry.event === "storage.orphan_object");
    return { error, caseId, orphan };
  }

  it("a PutObject stored but unanswered whose removal cannot reach the storage: 503, no document, the orphan logged with its key", async () => {
    const bucket = `it-${randomUUID()}`;
    const direct = new S3StorageProvider(storageEnv(s3Endpoint!, bucket));
    await ensureDevelopmentBucket(storageEnv(s3Endpoint!, bucket));
    const proxy = await answerDroppingProxy(false);
    try {
      const { error, caseId, orphan } = await uploadThrough(proxy.endpoint, bucket);

      expect((error as HttpError).statusCode).toBe(503);
      expect(await documentsOf(caseId)).toBe(0);
      expect(proxy.counts.blockedDeletes).toBeGreaterThan(0);
      // The object really is in the storage, and the log names it: nothing silent.
      expect(orphan).toMatchObject({ event: "storage.orphan_object", origin: "upload" });
      const key = orphan!.storageKey as string;
      expect(key).toMatch(new RegExp(`^cases/${caseId}/documents/`));
      expect((await direct.getObject(key)).equals(PDF)).toBe(true);
    } finally {
      await proxy.close();
    }
  }, 60_000);

  it("a removal that reaches the storage but loses its answer: the object is gone, and still logged for reconciliation", async () => {
    const bucket = `it-${randomUUID()}`;
    const direct = new S3StorageProvider(storageEnv(s3Endpoint!, bucket));
    await ensureDevelopmentBucket(storageEnv(s3Endpoint!, bucket));
    const proxy = await answerDroppingProxy(true);
    try {
      const { error, caseId, orphan } = await uploadThrough(proxy.endpoint, bucket);

      expect((error as HttpError).statusCode).toBe(503);
      expect(await documentsOf(caseId)).toBe(0);
      const key = orphan!.storageKey as string;
      await expect(direct.getObject(key)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    } finally {
      await proxy.close();
    }
  }, 60_000);
});
