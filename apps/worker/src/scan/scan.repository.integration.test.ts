import type { PrismaClient } from "@legaltech/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clients, hasDatabase, seedDocument } from "../test-support/integration.js";
import { PrismaScanRepository } from "./scan.repository.js";

/**
 * PrismaScanRepository against real PostgreSQL, as the worker role (INTEGRATION_WORKER_DATABASE_URL);
 * rows are seeded and read back as the application role (INTEGRATION_DATABASE_URL).
 */
describe.skipIf(!hasDatabase)("PrismaScanRepository (PostgreSQL integration)", () => {
  let app: PrismaClient;
  let worker: PrismaClient;
  let repository: PrismaScanRepository;

  beforeAll(() => {
    ({ app, worker } = clients());
    repository = new PrismaScanRepository(worker);
  });

  afterAll(async () => {
    await app?.$disconnect();
    await worker?.$disconnect();
  });

  const reload = (id: string) => app.document.findUniqueOrThrow({ where: { id } });
  const events = (id: string) => app.auditLog.findMany({ where: { entityId: id } });

  it("lets exactly one of several concurrent claims win", async () => {
    const document = await seedDocument(app, { fileType: "PDF", fileSize: 10 });

    const claims = await Promise.all(
      Array.from({ length: 6 }, () => repository.claim(document.id, 600)),
    );

    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await reload(document.id)).toMatchObject({ status: "SCANNING", scanAttempts: 1 });
  });

  it("records CLEAN and its event together, at one time, with case_id and no actor", async () => {
    const document = await seedDocument(app, { fileType: "JPEG", fileSize: 10 });
    const claim = (await repository.claim(document.id, 600))!;

    expect(await repository.markClean(claim, `${document.storageKey}.sanitized`)).toBe(true);

    const stored = await reload(document.id);
    expect(stored).toMatchObject({
      status: "CLEAN",
      sanitizedStorageKey: `${document.storageKey}.sanitized`,
      scanSignature: null,
    });
    const [event] = await events(document.id);
    expect(event).toMatchObject({
      action: "document.scan_clean",
      actorUserId: null,
      caseId: document.caseId,
      newValue: { status: "CLEAN" },
    });
    expect(event!.occurredAt.getTime()).toBe(stored.scannedAt!.getTime());
    expect(JSON.stringify(event)).not.toContain("comparendo");
  });

  it("records INFECTED with its signature, and SCAN_FAILED with the attempts", async () => {
    const infected = await seedDocument(app, { fileType: "PDF", fileSize: 10 });
    const failed = await seedDocument(app, { fileType: "PDF", fileSize: 10 });

    await repository.markInfected(
      (await repository.claim(infected.id, 600))!,
      "Eicar-Test-Signature",
    );
    await repository.markFailed((await repository.claim(failed.id, 600))!);

    expect(await reload(infected.id)).toMatchObject({
      status: "INFECTED",
      scanSignature: "Eicar-Test-Signature",
      sanitizedStorageKey: null,
    });
    expect(await reload(failed.id)).toMatchObject({ status: "SCAN_FAILED" });
    expect((await events(infected.id))[0]?.newValue).toEqual({
      status: "INFECTED",
      signature: "Eicar-Test-Signature",
    });
    expect((await events(failed.id))[0]?.newValue).toEqual({ status: "SCAN_FAILED", attempts: 1 });
  });

  it("fences results with the claim token: a stale claim can neither finish nor release", async () => {
    const document = await seedDocument(app, { fileType: "PDF", fileSize: 10 });
    const first = (await repository.claim(document.id, 600))!;
    // The claim is abandoned (older than the lease) and taken over.
    await worker.$executeRaw`
      UPDATE documents SET scan_started_at = clock_timestamp() - interval '11 minutes'
      WHERE id = ${document.id}::uuid`;
    const stale = {
      ...first,
      token: (
        await worker.$queryRaw<Array<{ t: string }>>`
      SELECT scan_started_at::text AS t FROM documents WHERE id = ${document.id}::uuid`
      )[0]!.t,
    };
    const second = (await repository.claim(document.id, 600))!;

    expect(second.attempts).toBe(2);
    expect(await repository.markClean(stale, null)).toBe(false);
    expect(await repository.release(stale)).toBe(false);
    expect(await repository.markInfected(second, "X")).toBe(true);
    expect(await events(document.id)).toHaveLength(1);
  });

  it("never claims a document that is already treated, nor an unknown one", async () => {
    const document = await seedDocument(app, { fileType: "PDF", fileSize: 10 });
    await repository.markClean((await repository.claim(document.id, 600))!, null);

    expect(await repository.claim(document.id, 600)).toBeNull();
    expect(await repository.claim("7b1f5c2e-0d4a-4a4e-9a38-3d5c1f0e2b11", 600)).toBeNull();
  });

  it("puts a released document back in the queue state", async () => {
    const document = await seedDocument(app, { fileType: "PDF", fileSize: 10 });
    const claim = (await repository.claim(document.id, 600))!;

    expect(await repository.release(claim)).toBe(true);
    expect(await reload(document.id)).toMatchObject({
      status: "PENDING_SCAN",
      scanStartedAt: null,
    });
  });
});
