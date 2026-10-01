import { DOCUMENT_SCAN_QUEUE } from "@legaltech/contracts";
import type { PrismaClient } from "@legaltech/database";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reprocessDocument, startPgBossForWorker } from "./queue.js";
import { PrismaScanRepository } from "./scan/scan.repository.js";
import { clients, hasDatabase, integration, seedDocument } from "./test-support/integration.js";

/**
 * An ADMIN's explicit reprocessing, as the worker role against PostgreSQL and pg-boss
 * (decision of 2026-10-01; DATABASE_SPEC.md): only SCAN_FAILED goes back to PENDING_SCAN, once,
 * with a new round of attempts, its scan job and its event.
 */
describe.skipIf(!hasDatabase)("document reprocessing (PostgreSQL + pg-boss integration)", () => {
  let app: PrismaClient;
  let worker: PrismaClient;
  let boss: PgBoss;
  const touched: string[] = [];

  beforeAll(async () => {
    ({ app, worker } = clients());
    boss = await startPgBossForWorker(integration.workerDatabaseUrl!);
  }, 60_000);

  afterAll(async () => {
    // These documents have no stored object: nobody should run their jobs.
    if (touched.length) {
      await worker.$executeRaw`
        DELETE FROM pgboss.job_common
        WHERE name = ${DOCUMENT_SCAN_QUEUE} AND data->>'documentId' = ANY(${touched}::text[])`;
    }
    await boss?.stop({ graceful: false });
    await app?.$disconnect();
    await worker?.$disconnect();
  });

  async function documentIn(status: string, attempts = 5) {
    const document = await seedDocument(app, { fileType: "PDF", fileSize: 10 });
    touched.push(document.id);
    await worker.$executeRaw`
      UPDATE documents SET status = ${status}::document_status, scan_attempts = ${attempts},
             scanned_at = CASE WHEN ${status} IN ('CLEAN', 'INFECTED', 'SCAN_FAILED')
                               THEN clock_timestamp() END
      WHERE id = ${document.id}::uuid`;
    return document.id;
  }
  const load = (id: string) => app.document.findUniqueOrThrow({ where: { id } });
  const scanJobs = async (id: string) => {
    const [row] = await worker.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pgboss.job_common
      WHERE name = ${DOCUMENT_SCAN_QUEUE} AND data->>'documentId' = ${id}`;
    return Number(row!.n);
  };
  const reprocessedEvents = (id: string) =>
    app.auditLog.findMany({ where: { entityId: id, action: "document.scan_reprocessed" } });

  it("moves a SCAN_FAILED document back to PENDING_SCAN with a new round, a job and its event", async () => {
    const id = await documentIn("SCAN_FAILED", 5);

    expect(await reprocessDocument(worker, boss, id)).toBe("reprocessed");

    const after = await load(id);
    expect(after).toMatchObject({
      status: "PENDING_SCAN",
      scanAttempts: 0,
      scanStartedAt: null,
      scannedAt: null,
      scanSignature: null,
      sanitizedStorageKey: null,
    });
    expect(await scanJobs(id)).toBe(1);
    const events = await reprocessedEvents(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: null,
      caseId: after.caseId,
      newValue: { status: "PENDING_SCAN", previousAttempts: 5 },
    });
    // The new round starts like any treatment: the next claim is attempt 1 of 5.
    const claim = await new PrismaScanRepository(worker).claim(id, 600);
    expect(claim?.attempts).toBe(1);
  });

  it.each(["INFECTED", "CLEAN", "PENDING_SCAN", "SCANNING", "UPLOADED"])(
    "changes nothing for a %s document",
    async (status) => {
      const id = await documentIn(status, 2);
      const before = await load(id);

      expect(await reprocessDocument(worker, boss, id)).toBe("skipped");

      const after = await load(id);
      expect(after.status).toBe(before.status);
      expect(after.scanAttempts).toBe(2);
      expect(await scanJobs(id)).toBe(0);
      expect(await reprocessedEvents(id)).toHaveLength(0);
    },
  );

  it("changes nothing for an unknown document", async () => {
    expect(await reprocessDocument(worker, boss, crypto.randomUUID())).toBe("skipped");
  });

  it("acts once when several reprocessings of one document run at the same time", async () => {
    const id = await documentIn("SCAN_FAILED", 5);
    const [a, b] = [clients().worker, clients().worker];
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    try {
      // Another transaction holds the row (as a concurrent reprocessing would) while two
      // reprocessings start: they must wait for it and then act once between them, never twice.
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      let markLocked: () => void = () => {};
      const locked = new Promise<void>((resolve) => (markLocked = resolve));
      const holder = worker.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM documents WHERE id = ${id}::uuid FOR UPDATE`;
          markLocked();
          await released;
        },
        { timeout: 30_000 },
      );
      await locked;
      const during = Promise.all([reprocessDocument(a, boss, id), reprocessDocument(b, boss, id)]);
      // Both are now waiting for the row: let them go together.
      await pause(1_000);
      release();
      await holder;
      const outcomes = await during;

      expect(outcomes.filter((o) => o === "reprocessed")).toHaveLength(1);
      expect(await scanJobs(id)).toBe(1);
      expect(await reprocessedEvents(id)).toHaveLength(1);
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  });
});
