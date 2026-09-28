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
  "pgboss.job": ["SELECT", "INSERT", "UPDATE", "DELETE"],
  "pgboss.job_common": ["SELECT", "INSERT", "UPDATE", "DELETE"],
  "pgboss.job_dependency": ["SELECT", "INSERT", "UPDATE", "DELETE"],
  "pgboss.queue": ["SELECT", "UPDATE"],
  "pgboss.version": ["SELECT"],
  "pgboss.schedule": ["SELECT"],
  "pgboss.subscription": ["SELECT"],
  "pgboss.bam": ["SELECT"],
  "pgboss.warning": ["SELECT"],
};

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
});
