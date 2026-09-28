import { randomUUID } from "node:crypto";
import { DOCUMENT_SCAN_QUEUE } from "@legaltech/contracts";
import type { PrismaClient } from "@legaltech/database";
import { ensureDevelopmentBucket, S3StorageProvider, type StorageEnv } from "@legaltech/storage";
import { fromPrisma, PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AntivirusError, type AntivirusProvider } from "./antivirus/antivirus.js";
import { ClamAvProvider } from "./antivirus/clamav.js";
import { startPgBossForWorker, sweepUntreatedDocuments, workDocumentScans } from "./queue.js";
import { PrismaScanRepository } from "./scan/scan.repository.js";
import {
  clients,
  eicar,
  hasPipeline,
  integration,
  seedDocument,
} from "./test-support/integration.js";

/**
 * The whole treatment against real services: PostgreSQL (application and worker roles), pg-boss,
 * SeaweedFS and ClamAV. A document is written as the API writes it (row + job in one
 * transaction, as the application role) and the worker takes it to its final state.
 */
const FAIL_ONCE = Buffer.from("LEGALTECH-FAIL-ONCE");
const FAIL_ALWAYS = Buffer.from("LEGALTECH-FAIL-ALWAYS");
const SWEEP = { leaseSeconds: 600, maxAttempts: 3 };

describe.skipIf(!hasPipeline)(
  "document security treatment (PostgreSQL + pg-boss + S3 + ClamAV)",
  () => {
    let app: PrismaClient;
    let worker: PrismaClient;
    let apiBoss: PgBoss;
    let workerBoss: PgBoss;
    let storage: S3StorageProvider;
    const failedOnce = new Set<string>();

    beforeAll(async () => {
      ({ app, worker } = clients());
      const storageEnv: StorageEnv = {
        STORAGE_BUCKET: `it-${randomUUID()}`,
        STORAGE_REGION: "us-east-1",
        STORAGE_ENDPOINT: integration.s3Endpoint,
        STORAGE_PUBLIC_ENDPOINT: undefined,
        STORAGE_FORCE_PATH_STYLE: true,
        STORAGE_ACCESS_KEY_ID: integration.s3AccessKeyId,
        STORAGE_SECRET_ACCESS_KEY: integration.s3SecretAccessKey,
      };
      await ensureDevelopmentBucket(storageEnv);
      storage = new S3StorageProvider(storageEnv);

      // The API side: enqueue only, as the application role, no DDL.
      apiBoss = new PgBoss({
        connectionString: integration.appDatabaseUrl!,
        migrate: false,
        supervise: false,
        schedule: false,
        persistWarnings: false,
        reindex: false,
      });
      await apiBoss.start();

      const clamav = new ClamAvProvider({
        host: integration.clamavHost,
        port: integration.clamavPort,
        timeoutMs: 30_000,
      });
      // Real ClamAV, except for content marked to simulate an antivirus outage.
      const antivirus: AntivirusProvider = {
        scan: async (content) => {
          if (content.includes(FAIL_ALWAYS)) throw new AntivirusError("simulated outage");
          const key = content.toString("latin1");
          if (content.includes(FAIL_ONCE) && !failedOnce.has(key)) {
            failedOnce.add(key);
            throw new AntivirusError("simulated transient outage");
          }
          return clamav.scan(content);
        },
      };
      workerBoss = await startPgBossForWorker(integration.workerDatabaseUrl!);
      await workDocumentScans(
        workerBoss,
        {
          repository: new PrismaScanRepository(worker),
          storage,
          antivirus,
          maxAttempts: 3,
          leaseSeconds: 600,
        },
        () => {},
        { pollingIntervalSeconds: 0.5 },
      );
    }, 60_000);

    afterAll(async () => {
      await workerBoss?.stop({ graceful: false });
      await apiBoss?.stop({ graceful: false });
      await app?.$disconnect();
      await worker?.$disconnect();
    });

    /** Stores the file and writes the row and its job in one transaction, as the API does. */
    async function upload(fileType: "PDF" | "JPEG" | "PNG", content: Buffer) {
      const document = await seedDocument(app, { fileType, fileSize: content.length });
      await storage.putObject({ key: document.storageKey, body: content, contentType: "x" });
      await app.$transaction(async (tx) => {
        // Fast retries for the test; the queue's own retry settings apply otherwise.
        await apiBoss.send(
          DOCUMENT_SCAN_QUEUE,
          { documentId: document.id },
          { db: fromPrisma(tx), retryDelay: 1, retryBackoff: false },
        );
      });
      return document;
    }

    async function finalState(id: string) {
      for (let i = 0; i < 120; i++) {
        const document = await app.document.findUniqueOrThrow({ where: { id } });
        if (["CLEAN", "INFECTED", "SCAN_FAILED"].includes(document.status)) return document;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(`document ${id} never reached a final state`);
    }

    const events = (id: string) =>
      app.auditLog.findMany({ where: { entityId: id }, orderBy: { occurredAt: "asc" } });

    it("takes a clean PDF to CLEAN and leaves the original untouched (no copy)", async () => {
      const pdf = Buffer.from("%PDF-1.7\nun comparendo limpio\n%%EOF\n");
      const document = await upload("PDF", pdf);

      const done = await finalState(document.id);

      expect(done).toMatchObject({ status: "CLEAN", sanitizedStorageKey: null, scanAttempts: 1 });
      expect((await storage.getObject(document.storageKey)).equals(pdf)).toBe(true);
      expect((await events(document.id)).map((e) => e.action)).toEqual(["document.scan_clean"]);
    }, 90_000);

    it("takes the EICAR test file to INFECTED; the original stays private and is never copied", async () => {
      // As-is: ClamAV recognises the EICAR test file only at the start of the content. The
      // worker does not re-check the type (the API did at upload), so the row may say PDF.
      const document = await upload("PDF", eicar());

      const done = await finalState(document.id);

      expect(done.status).toBe("INFECTED");
      expect(done.scanSignature).toMatch(/eicar/i);
      expect(done.sanitizedStorageKey).toBeNull();
      await expect(storage.getObject(`${document.storageKey}.sanitized`)).rejects.toThrow();
      expect((await events(document.id)).map((e) => e.action)).toEqual(["document.scan_infected"]);
    }, 90_000);

    it("stores a JPEG copy without EXIF/GPS next to the untouched original", async () => {
      const jpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        Buffer.from([0xff, 0xe1, 0x00, 0x18]),
        Buffer.from("Exif\0\0GPSLatitude 4.60", "latin1"),
        Buffer.from([0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x55, 0x66, 0xff, 0xd9]),
      ]);
      const document = await upload("JPEG", jpeg);

      const done = await finalState(document.id);

      expect(done.status).toBe("CLEAN");
      expect(done.sanitizedStorageKey).toBe(`${document.storageKey}.sanitized`);
      const copy = await storage.getObject(done.sanitizedStorageKey!);
      expect(copy.toString("latin1")).not.toContain("GPSLatitude");
      expect((await storage.getObject(document.storageKey)).equals(jpeg)).toBe(true);
    }, 90_000);

    it("retries through pg-boss after a transient antivirus failure", async () => {
      const document = await upload("PDF", Buffer.concat([Buffer.from("%PDF-1.7\n"), FAIL_ONCE]));

      const done = await finalState(document.id);

      expect(done).toMatchObject({ status: "CLEAN", scanAttempts: 2 });
    }, 90_000);

    it("ends SCAN_FAILED, never downloadable, when the antivirus keeps failing", async () => {
      const document = await upload("PDF", Buffer.concat([Buffer.from("%PDF-1.7\n"), FAIL_ALWAYS]));

      const done = await finalState(document.id);

      expect(done).toMatchObject({
        status: "SCAN_FAILED",
        scanAttempts: 3,
        sanitizedStorageKey: null,
      });
      expect((await events(document.id)).map((e) => e.action)).toEqual(["document.scan_failed"]);
    }, 90_000);

    it("ignores a duplicate job for a document already treated", async () => {
      const document = await upload("PDF", Buffer.from("%PDF-1.7\nduplicado\n"));
      await finalState(document.id);

      await apiBoss.send(DOCUMENT_SCAN_QUEUE, { documentId: document.id });
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      expect(await app.document.findUniqueOrThrow({ where: { id: document.id } })).toMatchObject({
        status: "CLEAN",
        scanAttempts: 1,
      });
      expect(await events(document.id)).toHaveLength(1);
    }, 90_000);

    it("queues, at start, the documents stored before the antivirus existed (UPLOADED)", async () => {
      const pdf = Buffer.from("%PDF-1.7\nanterior al antivirus\n");
      const document = await seedDocument(app, {
        fileType: "PDF",
        fileSize: pdf.length,
        status: "UPLOADED",
      });
      await storage.putObject({ key: document.storageKey, body: pdf, contentType: "x" });

      const { requeued } = await sweepUntreatedDocuments(worker, workerBoss, SWEEP);
      expect(requeued).toContain(document.id);

      expect((await finalState(document.id)).status).toBe("CLEAN");
    }, 90_000);

    it("recovers an abandoned claim (its worker died) with the sweep, and finishes it", async () => {
      const pdf = Buffer.from("%PDF-1.7\nreclamo abandonado\n");
      const document = await seedDocument(app, { fileType: "PDF", fileSize: pdf.length });
      await storage.putObject({ key: document.storageKey, body: pdf, contentType: "x" });
      // A worker claimed it 700 s ago and died; its job will not come back.
      await worker.$executeRaw`
        UPDATE documents SET status = 'SCANNING', scan_attempts = 1,
               scan_started_at = clock_timestamp() - interval '700 seconds'
        WHERE id = ${document.id}::uuid`;

      const { requeued } = await sweepUntreatedDocuments(worker, workerBoss, SWEEP);
      expect(requeued).toContain(document.id);

      const done = await finalState(document.id);
      expect(done.status).toBe("CLEAN");
      expect(done.scanAttempts).toBe(2);
    }, 90_000);
  },
);
