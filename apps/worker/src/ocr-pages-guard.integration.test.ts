import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@legaltech/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaOcrRepository } from "./ocr/ocr.repository.js";
import { createPrismaClient } from "@legaltech/database";
import {
  clients,
  hasOwner,
  integration,
  ownerClient,
  seedDocument,
} from "./test-support/integration.js";

/**
 * The SECURITY DEFINER function behind the page-consistency triggers (decision OCR-A10.5;
 * SECURITY_SPEC.md, "PostgreSQL"). It runs with its owner's rights inside the session of whoever
 * fired the trigger, so it must resolve nothing through that session: every object qualified, the
 * session's temporary schema last, nobody but the triggers able to call it.
 */
describe.skipIf(!hasOwner)("OCR pages guard (SECURITY DEFINER, real roles)", () => {
  let app: PrismaClient;
  let worker: PrismaClient;
  let owner: PrismaClient;

  beforeAll(() => {
    ({ app, worker } = clients());
    owner = ownerClient();
  });

  afterAll(async () => {
    await app?.$disconnect();
    await worker?.$disconnect();
    await owner?.$disconnect();
  });

  async function processingDocument() {
    const document = await seedDocument(app, { fileType: "JPEG", fileSize: 10 });
    await worker.$executeRaw`
      UPDATE documents SET status = 'CLEAN'::document_status,
                           ocr_status = 'PROCESSING'::document_ocr_status
      WHERE id = ${document.id}::uuid`;
    return document;
  }
  const insertCompleted = (
    tx: Pick<PrismaClient, "$executeRaw">,
    id: string,
    documentId: string,
    pages: number,
  ) => tx.$executeRaw`
    INSERT INTO public.ocr_results (id, document_id, outcome, engine, representation,
                                    processed_sha256, pages, attempts, finished_at)
    VALUES (${id}::uuid, ${documentId}::uuid, 'COMPLETED'::public.ocr_result_outcome, 'x',
            'SANITIZED'::public.ocr_representation, ${"c".repeat(64)}, ${pages}, 1,
            clock_timestamp())`;

  it("is owned by the owner, SECURITY DEFINER, with a pinned search_path and qualified names", async () => {
    const [fn] = await owner.$queryRaw<
      Array<{ owner: string; definer: boolean; config: string[] | null; body: string }>
    >`
      SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
             p.proconfig AS config, p.prosrc AS body
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'ocr_result_pages_consistent'`;
    expect(fn).toBeDefined();
    expect(fn!.owner).toBe("legaltech_owner");
    expect(fn!.definer).toBe(true);
    // pg_temp listed last: otherwise PostgreSQL searches it first for tables.
    expect(fn!.config).toEqual(["search_path=pg_catalog, pg_temp"]);
    // Every table and type reference is schema-qualified; the trigger relation is checked by OID.
    expect(fn!.body).not.toMatch(/FROM\s+(?!public\.)\w+/i);
    expect(fn!.body).not.toMatch(/TG_TABLE_NAME/);
    expect(fn!.body).toMatch(/TG_RELID\s*=\s*'public\.ocr_results'::regclass/);
    expect(fn!.body).not.toMatch(/(?<!public\.)\bocr_result_outcome\b/);
  });

  it("can be executed by nobody but its owner, and only the two triggers use it", async () => {
    const rows = await owner.$queryRaw<Array<{ role: string; can: boolean }>>`
      SELECT r.role,
             has_function_privilege(r.role, 'public.ocr_result_pages_consistent()', 'EXECUTE') AS can
      FROM unnest(ARRAY['legaltech_app', 'legaltech_worker']) AS r(role)`;
    expect(rows).toEqual([
      { role: "legaltech_app", can: false },
      { role: "legaltech_worker", can: false },
    ]);
    const [acl] = await owner.$queryRaw<Array<{ acl: string[] }>>`
      SELECT coalesce(proacl::text[], ARRAY[]::text[]) AS acl FROM pg_proc
      WHERE oid = 'public.ocr_result_pages_consistent()'::regprocedure`;
    expect(acl!.acl).toEqual(["legaltech_owner=X/legaltech_owner"]);

    const triggers = await owner.$queryRaw<
      Array<{ name: string; table: string; deferred: boolean; enabled: string }>
    >`
      SELECT t.tgname AS name, c.relname AS table, t.tginitdeferred AS deferred,
             t.tgenabled::text AS enabled
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE t.tgfoid = 'public.ocr_result_pages_consistent()'::regprocedure
      ORDER BY t.tgname`;
    expect(triggers).toEqual([
      {
        name: "ocr_result_pages_consistent",
        table: "ocr_result_pages",
        deferred: true,
        enabled: "O",
      },
      { name: "ocr_results_pages_consistent", table: "ocr_results", deferred: true, enabled: "O" },
    ]);
  });

  it("refuses a direct call from the worker and from the application role", async () => {
    for (const client of [worker, app]) {
      await expect(client.$queryRaw`SELECT public.ocr_result_pages_consistent()`).rejects.toThrow(
        /permission denied/i,
      );
    }
  });

  it("cannot be switched off, replaced or reused by the worker", async () => {
    const attempts = [
      `SET session_replication_role = replica`,
      `ALTER TABLE public.ocr_result_pages DISABLE TRIGGER ocr_result_pages_consistent`,
      `ALTER TABLE public.ocr_results DISABLE TRIGGER ALL`,
      `DROP TRIGGER ocr_results_pages_consistent ON public.ocr_results`,
      `ALTER FUNCTION public.ocr_result_pages_consistent() SECURITY INVOKER`,
      `CREATE OR REPLACE FUNCTION public.ocr_result_pages_consistent() RETURNS trigger
         LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
      `CREATE TRIGGER decoy AFTER INSERT ON public.documents
         FOR EACH ROW EXECUTE FUNCTION public.ocr_result_pages_consistent()`,
    ];
    for (const sql of attempts) {
      await expect(worker.$executeRawUnsafe(sql)).rejects.toThrow(
        /permission denied|must be owner|must be superuser/i,
      );
    }
  });

  it("does not resolve its tables through the worker's temporary schema (search_path shadowing)", async () => {
    const document = await processingDocument();
    const id = randomUUID();
    // Only for this test: let the worker create temporary objects, which a database created with
    // PostgreSQL's defaults allows to PUBLIC.
    await owner.$executeRawUnsafe(
      `GRANT TEMPORARY ON DATABASE "${await currentDatabase()}" TO legaltech_worker`,
    );
    try {
      await expect(
        worker.$transaction(async (tx) => {
          // Decoys with the guarded tables' names: a FAILED execution with no pages.
          await tx.$executeRawUnsafe(
            `CREATE TEMP TABLE ocr_results (id uuid, outcome text, pages integer) ON COMMIT DROP`,
          );
          await tx.$executeRawUnsafe(
            `CREATE TEMP TABLE ocr_result_pages (ocr_result_id uuid, page_number integer) ON COMMIT DROP`,
          );
          await tx.$executeRawUnsafe(
            `GRANT SELECT ON pg_temp.ocr_results, pg_temp.ocr_result_pages TO PUBLIC`,
          );
          await tx.$executeRaw`INSERT INTO pg_temp.ocr_results VALUES (${id}::uuid, 'FAILED', NULL)`;
          // A completed execution that claims 3 pages and stores none.
          await insertCompleted(tx, id, document.id, 3);
        }),
      ).rejects.toThrow(/exactly pages/);
    } finally {
      await owner.$executeRawUnsafe(
        `REVOKE TEMPORARY ON DATABASE "${await currentDatabase()}" FROM legaltech_worker`,
      );
    }
    expect(await owner.ocrResult.count({ where: { id } })).toBe(0);
  });

  async function currentDatabase() {
    const [row] = await owner.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    return row!.name;
  }

  it("never commits a completed execution without pages, even with a consistent count of zero", async () => {
    const document = await processingDocument();
    const id = randomUUID();
    await expect(
      worker.$transaction(async (tx) => {
        await insertCompleted(tx, id, document.id, 0);
      }),
    ).rejects.toThrow(/ocr_results_completed_has_pages|check/i);
    expect(await owner.ocrResult.count({ where: { id } })).toBe(0);
  });

  it("rolls back the result, its pages and the claim's state together", async () => {
    const document = await processingDocument();
    const id = randomUUID();
    await expect(
      worker.$transaction(async (tx) => {
        await insertCompleted(tx, id, document.id, 1);
        await tx.$executeRaw`
          INSERT INTO ocr_result_pages (ocr_result_id, page_number, text)
          VALUES (${id}::uuid, 1, 'texto')`;
        await tx.$executeRaw`
          UPDATE documents SET ocr_status = 'COMPLETED'::document_ocr_status
          WHERE id = ${document.id}::uuid`;
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await owner.ocrResult.count({ where: { id } })).toBe(0);
    expect(await owner.ocrResultPage.count({ where: { ocrResultId: id } })).toBe(0);
    expect(await app.document.findUniqueOrThrow({ where: { id: document.id } })).toMatchObject({
      ocrStatus: "PROCESSING",
    });
  });

  it("never lets the worker change or delete a finished result or its pages", async () => {
    const document = await processingDocument();
    const id = randomUUID();
    await worker.$transaction(async (tx) => {
      await insertCompleted(tx, id, document.id, 1);
      await tx.$executeRaw`
        INSERT INTO ocr_result_pages (ocr_result_id, page_number, text)
        VALUES (${id}::uuid, 1, 'texto')`;
    });
    const statements = [
      `UPDATE ocr_results SET outcome = 'FAILED' WHERE id = '${id}'`,
      `UPDATE ocr_result_pages SET text = 'otro' WHERE ocr_result_id = '${id}'`,
      `DELETE FROM ocr_result_pages WHERE ocr_result_id = '${id}'`,
      `DELETE FROM ocr_results WHERE id = '${id}'`,
      `TRUNCATE ocr_result_pages`,
    ];
    for (const sql of statements) {
      await expect(worker.$executeRawUnsafe(sql)).rejects.toThrow(/permission denied/i);
    }
    expect(
      await owner.ocrResultPage.findMany({
        where: { ocrResultId: id },
        select: { pageNumber: true, text: true },
      }),
    ).toEqual([{ pageNumber: 1, text: "texto" }]);
  });

  it("two workers finishing the same claim: one wins, its pages are written once", async () => {
    const document = await seedDocument(app, { fileType: "JPEG", fileSize: 10 });
    await worker.$executeRaw`
      UPDATE documents SET status = 'CLEAN'::document_status,
                           ocr_status = 'PENDING'::document_ocr_status
      WHERE id = ${document.id}::uuid`;
    const first = new PrismaOcrRepository(worker, noBoss);
    const second = new PrismaOcrRepository(createWorker(), noBoss);
    const claim = (await first.claim(document.id, 600))!;
    const run = () => ({
      id: randomUUID(),
      engine: "fake-ocr",
      engineVersion: "1.0",
      representation: "SANITIZED" as const,
      processedSha256: "b".repeat(64),
      pages: 2,
    });
    const a = run();
    const b = run();
    const outcomes = await Promise.allSettled([
      first.markCompleted(claim, a, ["uno", "dos"]),
      second.markCompleted(claim, b, ["uno", "dos"]),
    ]);
    const won = outcomes.filter((o) => o.status === "fulfilled" && o.value === true);
    expect(won).toHaveLength(1);
    const results = await owner.ocrResult.findMany({ where: { documentId: document.id } });
    expect(results).toHaveLength(1);
    expect(await owner.ocrResultPage.count({ where: { ocrResultId: results[0]!.id } })).toBe(2);
    expect(await owner.ocrResultPage.count({ where: { ocrResultId: { in: [a.id, b.id] } } })).toBe(
      2,
    );
    expect(
      await app.auditLog.count({
        where: { entityId: document.id, action: "document.ocr_completed" },
      }),
    ).toBe(1);
  });

  const extra: PrismaClient[] = [];
  function createWorker() {
    const client = createPrismaClient(integration.workerDatabaseUrl!);
    extra.push(client);
    return client;
  }
  afterAll(async () => {
    for (const client of extra) await client.$disconnect();
  });
  // markCompleted never enqueues: pg-boss is not needed for these paths.
  const noBoss = undefined as unknown as ConstructorParameters<typeof PrismaOcrRepository>[1];
});
