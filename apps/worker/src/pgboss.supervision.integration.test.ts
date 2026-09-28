import { randomUUID } from "node:crypto";
import { DOCUMENT_SCAN_QUEUE } from "@legaltech/contracts";
import type { PrismaClient } from "@legaltech/database";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORKER_BOSS_OPTIONS } from "./queue.js";
import { clients, hasDatabase, integration } from "./test-support/integration.js";

/**
 * pg-boss supervision and maintenance as the worker role, with its least-privilege grants
 * (DATABASE_SPEC.md, "Permisos de los roles de ejecución"; migration
 * worker_pgboss_least_privilege). The worker's own options, with one-second intervals so that a
 * pass does real work: job expiry (monitor), job retention and dependency cleanup (maintenance),
 * the monitor backoff stamp and flow resolution. Any permission error fails the pass or is
 * emitted as an error.
 */
const TEST_PRIORITY = 1_000; // fetched before any other job left in the queue

describe.skipIf(!hasDatabase)("pg-boss supervision as the worker role (integration)", () => {
  let worker: PrismaClient;
  let boss: PgBoss;
  const errors: Error[] = [];
  const created: string[] = [];

  beforeAll(async () => {
    ({ worker } = clients());
    boss = new PgBoss({
      connectionString: integration.workerDatabaseUrl!,
      ...WORKER_BOSS_OPTIONS,
      superviseIntervalSeconds: 1,
      monitorIntervalSeconds: 1,
      maintenanceIntervalSeconds: 1,
      // pg-boss's own test hook: report a long stats aggregate so the monitor backoff is written.
      __test__monitor_stats_seconds: 100_000,
    } as ConstructorParameters<typeof PgBoss>[0]);
    boss.on("error", (error: Error) => errors.push(error));
    await boss.start();
  }, 60_000);

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    if (created.length) {
      await worker.$executeRaw`DELETE FROM pgboss.job_common WHERE id = ANY(${created}::uuid[])`;
    }
    // Leave the stats aggregate enabled for the other test files.
    await worker.$executeRaw`UPDATE pgboss.version SET monitor_backoff_on = NULL`;
    await worker?.$disconnect();
  });

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function sendAndFetch(options: { expireInSeconds?: number; deleteAfterSeconds?: number }) {
    const id = await boss.send(
      DOCUMENT_SCAN_QUEUE,
      { documentId: randomUUID() },
      { priority: TEST_PRIORITY, retryLimit: 0, ...options },
    );
    expect(id).toBeTruthy();
    created.push(id!);
    const [job] = await boss.fetch(DOCUMENT_SCAN_QUEUE);
    expect(job?.id).toBe(id);
    return id!;
  }

  const queueStamps = async () => {
    const [row] = await worker.$queryRaw<
      Array<{ monitor_on: Date | null; maintain_on: Date | null }>
    >`
      SELECT monitor_on, maintain_on FROM pgboss.queue WHERE name = ${DOCUMENT_SCAN_QUEUE}`;
    return row!;
  };

  it("expires, retains and cleans up jobs, and stamps its timers, with only its grants", async () => {
    const expiring = await sendAndFetch({ expireInSeconds: 1 });
    const retained = await sendAndFetch({ deleteAfterSeconds: 1 });
    await boss.complete(DOCUMENT_SCAN_QUEUE, retained);
    const before = await queueStamps();

    await pause(2_100);
    await boss.supervise();

    // Monitor: the active job past its expiry failed (no retries left).
    expect((await boss.getJobById(DOCUMENT_SCAN_QUEUE, expiring))?.state).toBe("failed");
    // Maintenance: the completed job past its retention was deleted (dependency cleanup follows it
    // in the same step).
    expect(await boss.getJobById(DOCUMENT_SCAN_QUEUE, retained)).toBeNull();
    // Both claims stamped the queue row, and the monitor backoff stamped the version row.
    const after = await queueStamps();
    expect(after.monitor_on!.getTime()).toBeGreaterThan(before.monitor_on?.getTime() ?? 0);
    expect(after.maintain_on!.getTime()).toBeGreaterThan(before.maintain_on?.getTime() ?? 0);
    expect((await versionStamps()).monitor_backoff_on).not.toBeNull();
    // Flow resolution (every 5 s while supervising) stamps its own timer.
    let flowOn = (await versionStamps()).flow_on;
    for (let i = 0; i < 20 && !flowOn; i++) {
      await pause(500);
      flowOn = (await versionStamps()).flow_on;
    }
    expect(flowOn).not.toBeNull();

    // Background passes ran meanwhile, every second: none hit a permission error.
    await pause(1_500);
    expect(errors.map((error) => error.message)).toEqual([]);
  }, 60_000);

  async function versionStamps() {
    const [row] = await worker.$queryRaw<
      Array<{ monitor_backoff_on: Date | null; flow_on: Date | null }>
    >`SELECT monitor_backoff_on, flow_on FROM pgboss.version`;
    return row!;
  }
});
