import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@legaltech/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clients, hasDatabase, seedDocument } from "./test-support/integration.js";

/**
 * The worker role has exactly what the document treatment needs (DATABASE_SPEC.md, "Permisos de
 * los roles de ejecución"): nothing else in public, job management in pgboss, no CREATE anywhere.
 */
const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

const EXPECTED_TABLES: Record<string, string[]> = {
  "public.documents": ["SELECT"],
  "public.audit_logs": ["INSERT"],
  // OCR results (decision OCR-A12): written once, never read back, changed or deleted.
  "public.ocr_results": ["INSERT"],
  // OCR text per page (decision OCR-A10.5): the same, never read back.
  "public.ocr_result_pages": ["INSERT"],
  // Through the parent table: completion updates dependents, and the fail/retry statement names it.
  "pgboss.job": ["SELECT", "INSERT", "UPDATE"],
  // The queue's own table: fetch, complete, retry and retention.
  "pgboss.job_common": ["SELECT", "INSERT", "UPDATE", "DELETE"],
  // Read on completion, cleaned up by maintenance; never inserted (no jobs with dependencies).
  "pgboss.job_dependency": ["SELECT", "DELETE"],
  "pgboss.queue": ["SELECT", "UPDATE"],
  "pgboss.version": ["SELECT"],
};

/** documents: only the security treatment's and the OCR's state and claim columns. */
const DOCUMENT_UPDATABLE = [
  "status",
  "scan_attempts",
  "scan_started_at",
  "scanned_at",
  "scan_signature",
  "sanitized_storage_key",
  "ocr_status",
  "ocr_attempts",
  "ocr_started_at",
];

/** pgboss.version: only the timers of what the worker runs (flows and supervision). */
const VERSION_UPDATABLE = ["flow_on", "monitor_backoff_on"];
const VERSION_COLUMNS = [
  "version",
  "cron_on",
  "bam_on",
  "flow_on",
  "reindex_on",
  "monitor_backoff_on",
];

describe.skipIf(!hasDatabase)("worker role privileges (PostgreSQL integration)", () => {
  let app: PrismaClient;
  let worker: PrismaClient;

  beforeAll(() => {
    ({ app, worker } = clients());
  });

  afterAll(async () => {
    await app?.$disconnect();
    await worker?.$disconnect();
  });

  it("is neither superuser nor owner, and cannot create anything", async () => {
    const [row] = await worker.$queryRaw<
      Array<{
        superuser: boolean;
        owned: bigint;
        db: boolean;
        pub: boolean;
        boss: boolean;
        temp: boolean;
      }>
    >`
      SELECT r.rolsuper AS superuser,
             (SELECT count(*) FROM pg_tables t WHERE t.tableowner = current_user) AS owned,
             has_database_privilege(current_user, current_database(), 'CREATE') AS db,
             has_schema_privilege(current_user, 'public', 'CREATE') AS pub,
             has_schema_privilege(current_user, 'pgboss', 'CREATE') AS boss,
             has_database_privilege(current_user, current_database(), 'TEMPORARY') AS temp
      FROM pg_roles r WHERE r.rolname = current_user`;
    expect(row).toEqual({
      superuser: false,
      owned: 0n,
      db: false,
      pub: false,
      boss: false,
      temp: false,
    });
  });

  it("has exactly the expected table privileges in public and pgboss", async () => {
    const rows = await worker.$queryRaw<Array<{ table: string; privilege: string }>>`
      SELECT t.schemaname || '.' || t.tablename AS "table", p.privilege
      FROM pg_tables t CROSS JOIN unnest(${PRIVILEGES}::text[]) AS p(privilege)
      WHERE t.schemaname IN ('public', 'pgboss')
        AND has_table_privilege(current_user, format('%I.%I', t.schemaname, t.tablename), p.privilege)`;
    const actual: Record<string, string[]> = {};
    for (const { table, privilege } of rows) (actual[table] ??= []).push(privilege);
    const sorted = (map: Record<string, string[]>) =>
      Object.fromEntries(Object.entries(map).map(([t, list]) => [t, [...list].sort()]));

    expect(sorted(actual)).toEqual(sorted(EXPECTED_TABLES));
  });

  it("can update only the timers of flows and supervision in pgboss.version", async () => {
    const rows = await worker.$queryRaw<Array<{ column: string }>>`
      SELECT c AS "column" FROM unnest(${VERSION_COLUMNS}::text[]) AS c
      WHERE has_column_privilege(current_user, 'pgboss.version', c, 'UPDATE')`;
    expect(rows.map((row) => row.column).sort()).toEqual([...VERSION_UPDATABLE].sort());
  });

  it("is refused what pg-boss does not need with this configuration", async () => {
    for (const statement of [
      "DELETE FROM pgboss.job WHERE false",
      "INSERT INTO pgboss.job_dependency SELECT * FROM pgboss.job_dependency WHERE false",
      "UPDATE pgboss.job_dependency SET child_name = child_name WHERE false",
      "SELECT count(*) FROM pgboss.schedule",
      "SELECT count(*) FROM pgboss.subscription",
      "SELECT count(*) FROM pgboss.bam",
      "SELECT count(*) FROM pgboss.warning",
      "UPDATE pgboss.version SET cron_on = cron_on WHERE false",
      "UPDATE pgboss.version SET version = version WHERE false",
    ]) {
      await expect(worker.$executeRawUnsafe(statement), statement).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it("can update only the scan columns of a document", async () => {
    const document = await seedDocument(app, { fileType: "PDF", fileSize: 10 });

    await expect(
      worker.$executeRaw`UPDATE documents SET file_name = 'x.pdf' WHERE id = ${document.id}::uuid`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      worker.$executeRaw`UPDATE documents SET storage_key = 'x' WHERE id = ${document.id}::uuid`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      worker.$executeRaw`DELETE FROM documents WHERE id = ${document.id}::uuid`,
    ).rejects.toThrow(/permission denied/);
    await expect(worker.$queryRaw`SELECT count(*) FROM users`).rejects.toThrow(/permission denied/);
    await expect(worker.$queryRaw`SELECT count(*) FROM audit_logs`).rejects.toThrow(
      /permission denied/,
    );
  });

  it("can update exactly the treatment's and the OCR's state and claim columns of documents", async () => {
    const rows = await worker.$queryRaw<Array<{ column: string }>>`
      SELECT column_name AS "column" FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'documents'
        AND has_column_privilege(current_user, 'public.documents', column_name, 'UPDATE')`;
    expect(rows.map((row) => row.column).sort()).toEqual([...DOCUMENT_UPDATABLE].sort());
  });

  it("inserts an OCR result but can never read it back, change it or delete it", async () => {
    const document = await seedDocument(app, { fileType: "PNG", fileSize: 10 });
    const id = randomUUID();
    await expect(
      worker.$executeRaw`
        INSERT INTO ocr_results (id, document_id, outcome, engine, attempts, finished_at, error_code)
        VALUES (${id}::uuid, ${document.id}::uuid, 'FAILED', 'x', 1, clock_timestamp(), 'timeout')`,
    ).resolves.toBe(1);

    for (const statement of [
      `SELECT count(*) FROM ocr_results`,
      `UPDATE ocr_results SET engine = 'y' WHERE id = '${id}'`,
      `DELETE FROM ocr_results WHERE id = '${id}'`,
      `SELECT count(*) FROM ocr_result_pages`,
      `UPDATE ocr_result_pages SET text = 'y' WHERE ocr_result_id = '${id}'`,
      `DELETE FROM ocr_result_pages WHERE ocr_result_id = '${id}'`,
      `INSERT INTO ocr_result_pages (ocr_result_id, page_number, text)
       VALUES ('${id}', 1, 'x') RETURNING text`,
      // RETURNING reads the row: refused, hence the id generated before the INSERT.
      `INSERT INTO ocr_results (id, document_id, outcome, engine, attempts, finished_at, error_code)
       VALUES ('${randomUUID()}', '${document.id}', 'FAILED', 'x', 1, clock_timestamp(), 'timeout')
       RETURNING id`,
    ]) {
      await expect(worker.$executeRawUnsafe(statement), statement).rejects.toThrow(
        /permission denied/,
      );
    }
  });
});
