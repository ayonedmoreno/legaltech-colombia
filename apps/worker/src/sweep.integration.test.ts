import { DOCUMENT_SCAN_QUEUE } from "@legaltech/contracts";
import type { PrismaClient } from "@legaltech/database";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgBossForWorker, sweepUntreatedDocuments, type SweepResult } from "./queue.js";
import { PrismaScanRepository } from "./scan/scan.repository.js";
import { clients, hasDatabase, integration, seedDocument } from "./test-support/integration.js";

/**
 * Recovery sweep against PostgreSQL and pg-boss, as the worker role (DATABASE_SPEC.md,
 * "Tratamiento de seguridad del documento"): abandoned claims go back to the queue or, with no
 * attempts left, end SCAN_FAILED; nothing else is touched; concurrent sweeps act once.
 */
const SWEEP = { leaseSeconds: 600, maxAttempts: 5 };

describe.skipIf(!hasDatabase)("recovery sweep (PostgreSQL + pg-boss integration)", () => {
  let app: PrismaClient;
  let worker: PrismaClient;
  let boss: PgBoss;
  const touched: string[] = [];

  beforeAll(async () => {
    ({ app, worker } = clients());
    boss = await startPgBossForWorker(integration.workerDatabaseUrl!);
  }, 60_000);

  afterAll(async () => {
    // The jobs queued here point at documents without a stored object: nobody should run them.
    if (touched.length) {
      await worker.$executeRaw`
        DELETE FROM pgboss.job_common
        WHERE name = ${DOCUMENT_SCAN_QUEUE} AND data->>'documentId' = ANY(${touched}::text[])`;
    }
    await boss?.stop({ graceful: false });
    await app?.$disconnect();
    await worker?.$disconnect();
  });

  /** A document in `status`, as the worker would leave it (the application role cannot). */
  async function documentIn(
    status: "PENDING_SCAN" | "SCANNING" | "CLEAN" | "SCAN_FAILED",
    attempts = 1,
    claimedSecondsAgo = 0,
  ) {
    const document = await seedDocument(app, { fileType: "PDF", fileSize: 10 });
    touched.push(document.id);
    await worker.$executeRaw`
      UPDATE documents
      SET status = ${status}::document_status, scan_attempts = ${attempts},
          scan_started_at = CASE WHEN ${status} = 'PENDING_SCAN' THEN NULL
                                 ELSE clock_timestamp() - make_interval(secs => ${claimedSecondsAgo}) END
      WHERE id = ${document.id}::uuid`;
    return document.id;
  }

  const load = (id: string) => app.document.findUniqueOrThrow({ where: { id } });
  const jobsFor = async (id: string) => {
    const [row] = await worker.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pgboss.job_common
      WHERE name = ${DOCUMENT_SCAN_QUEUE} AND data->>'documentId' = ${id}`;
    return Number(row!.n);
  };
  const eventsFor = (id: string) => app.auditLog.findMany({ where: { entityId: id } });

  it("requeues an abandoned claim with attempts left, and fences the worker that held it", async () => {
    const document = await seedDocument(app, { fileType: "PDF", fileSize: 10 });
    touched.push(document.id);
    const repository = new PrismaScanRepository(worker);
    const claim = await repository.claim(document.id, 600);
    expect(claim).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // A one-second lease: the claim above is abandoned for this sweep.
    const { requeued, failed } = await sweepUntreatedDocuments(worker, boss, {
      leaseSeconds: 1,
      maxAttempts: 5,
    });

    expect(requeued).toContain(document.id);
    expect(failed).not.toContain(document.id);
    const after = await load(document.id);
    expect(after.status).toBe("PENDING_SCAN");
    expect(after.scanStartedAt).toBeNull();
    expect(after.scanAttempts).toBe(1); // only a claim counts an attempt
    expect(await jobsFor(document.id)).toBe(1);
    // The worker that held the claim can no longer record a result nor release it.
    expect(await repository.markClean(claim!, null)).toBe(false);
    expect(await repository.release(claim!)).toBe(false);
    expect((await load(document.id)).status).toBe("PENDING_SCAN");
  });

  it("ends an abandoned claim with no attempts left SCAN_FAILED, with its event and no job", async () => {
    const exhausted = await documentIn("SCANNING", 5, 700);
    const lastChance = await documentIn("SCANNING", 4, 700);

    const { requeued, failed } = await sweepUntreatedDocuments(worker, boss, SWEEP);

    expect(failed).toContain(exhausted);
    expect(requeued).not.toContain(exhausted);
    const done = await load(exhausted);
    expect(done.status).toBe("SCAN_FAILED");
    expect(done.scannedAt).not.toBeNull();
    expect(await jobsFor(exhausted)).toBe(0);
    const events = await eventsFor(exhausted);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "document.scan_failed",
      entityType: "Document",
      caseId: done.caseId,
      actorUserId: null,
      newValue: { status: "SCAN_FAILED", attempts: 5 },
    });
    expect(events[0]!.occurredAt).toEqual(done.scannedAt);

    // One attempt left: back to the queue.
    expect(requeued).toContain(lastChance);
    expect((await load(lastChance)).status).toBe("PENDING_SCAN");
    expect(await jobsFor(lastChance)).toBe(1);
    expect(await eventsFor(lastChance)).toHaveLength(0);
  });

  it("leaves live claims, queued documents and final states alone", async () => {
    const ids = {
      live: await documentIn("SCANNING", 1, 100),
      liveLastAttempt: await documentIn("SCANNING", 5, 100),
      queued: await documentIn("PENDING_SCAN"),
      clean: await documentIn("CLEAN"),
      failed: await documentIn("SCAN_FAILED", 5),
    };

    const { requeued, failed } = await sweepUntreatedDocuments(worker, boss, SWEEP);

    for (const [expected, id] of [
      ["SCANNING", ids.live],
      ["SCANNING", ids.liveLastAttempt],
      ["PENDING_SCAN", ids.queued],
      ["CLEAN", ids.clean],
      ["SCAN_FAILED", ids.failed],
    ] as const) {
      expect(requeued).not.toContain(id);
      expect(failed).not.toContain(id);
      expect((await load(id)).status).toBe(expected);
      expect(await jobsFor(id)).toBe(0);
      expect(await eventsFor(id)).toHaveLength(0);
    }
  });

  it("acts once on each document when several workers sweep at the same time", async () => {
    const toRequeue = await documentIn("SCANNING", 2, 700);
    const toFail = await documentIn("SCANNING", 5, 700);
    const [a, b] = [clients().worker, clients().worker];
    const count = (results: SweepResult[], key: keyof SweepResult, id: string) =>
      results.flatMap((result) => result[key]).filter((entry) => entry === id).length;
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    try {
      // Another worker holds both rows (its own sweep, or a claim) while two sweeps start: they
      // must skip them rather than wait, and must not act on them again once they are released.
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => (release = resolve));
      let markLocked: () => void = () => {};
      const locked = new Promise<void>((resolve) => (markLocked = resolve));
      const holder = worker.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT id FROM documents WHERE id IN (${toRequeue}::uuid, ${toFail}::uuid) FOR UPDATE`;
          markLocked();
          await released;
        },
        { timeout: 30_000 },
      );
      await locked;

      const during = Promise.all([
        sweepUntreatedDocuments(a, boss, SWEEP),
        sweepUntreatedDocuments(b, boss, SWEEP),
      ]);
      // Correct sweeps return without waiting; sweeps that wait for the lock are let go after 3 s.
      await Promise.race([during, pause(3_000)]);
      release();
      await holder;
      const concurrent = await during;
      const later = await Promise.all([
        sweepUntreatedDocuments(a, boss, SWEEP),
        sweepUntreatedDocuments(b, boss, SWEEP),
        sweepUntreatedDocuments(worker, boss, SWEEP),
      ]);

      // The locked rows were skipped, not waited for...
      expect(count(concurrent, "requeued", toRequeue)).toBe(0);
      expect(count(concurrent, "failed", toFail)).toBe(0);
      // ...and once free, exactly one sweep acted on each.
      const all = [...concurrent, ...later];
      expect(count(all, "requeued", toRequeue)).toBe(1);
      expect(count(all, "failed", toFail)).toBe(1);
      expect(await jobsFor(toRequeue)).toBe(1);
      expect(await eventsFor(toFail)).toHaveLength(1);
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  });
});
