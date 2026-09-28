import { createPrismaClient, type PrismaClient } from "@legaltech/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The application role's privileges are exactly what the API uses (least privilege,
 * SECURITY_SPEC.md §1; migration `app_role_least_privilege`). Runs as the role itself, like the
 * other integration tests; opt-in through INTEGRATION_DATABASE_URL.
 *
 * A new table must be added here together with the GRANT in the migration that creates it.
 */
const databaseUrl = process.env.INTEGRATION_DATABASE_URL;

const PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

const EXPECTED: Record<string, string[]> = {
  users: ["SELECT", "INSERT", "UPDATE"],
  sessions: ["SELECT", "INSERT", "UPDATE"],
  email_verification_tokens: ["SELECT", "INSERT", "UPDATE"],
  password_reset_tokens: ["SELECT", "INSERT", "UPDATE"],
  email_outbox: ["SELECT", "INSERT", "UPDATE"],
  audit_logs: ["SELECT", "INSERT"],
  cases: ["SELECT", "INSERT"],
  case_status_history: ["SELECT", "INSERT"],
  documents: ["SELECT", "INSERT"],
  _prisma_migrations: [],
};

describe.skipIf(!databaseUrl)("application role privileges (PostgreSQL integration)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient(databaseUrl!);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it("runs as a role that is neither superuser nor owner of any table", async () => {
    const [role] = await prisma.$queryRaw<Array<{ superuser: boolean; owned: bigint }>>`
      SELECT r.rolsuper AS superuser,
             (SELECT count(*) FROM pg_tables t WHERE t.tableowner = current_user) AS owned
      FROM pg_roles r WHERE r.rolname = current_user`;
    expect(role).toEqual({ superuser: false, owned: 0n });
  });

  it("has exactly the expected privileges on every table of the schema", async () => {
    const rows = await prisma.$queryRaw<Array<{ table: string; privilege: string }>>`
      SELECT t.tablename AS "table", p.privilege
      FROM pg_tables t CROSS JOIN unnest(${PRIVILEGES}::text[]) AS p(privilege)
      WHERE t.schemaname = 'public'
        AND has_table_privilege(current_user, format('public.%I', t.tablename), p.privilege)`;
    const tables = await prisma.$queryRaw<Array<{ table: string }>>`
      SELECT tablename AS "table" FROM pg_tables WHERE schemaname = 'public'`;

    const actual: Record<string, string[]> = {};
    for (const { table } of tables) actual[table] = [];
    for (const { table, privilege } of rows) actual[table]!.push(privilege);
    const sorted = (map: Record<string, string[]>) =>
      Object.fromEntries(Object.entries(map).map(([table, list]) => [table, [...list].sort()]));

    // Any table missing from EXPECTED, or any privilege beyond it, fails here.
    expect(sorted(actual)).toEqual(sorted(EXPECTED));
  });

  it("gets nothing by default on future tables or sequences", async () => {
    const [row] = await prisma.$queryRaw<Array<{ entries: bigint }>>`
      SELECT count(*) AS entries
      FROM pg_default_acl d CROSS JOIN aclexplode(d.defaclacl) AS a
      WHERE a.grantee = (SELECT oid FROM pg_roles WHERE rolname = current_user)`;
    expect(row?.entries).toBe(0n);
  });

  it("cannot create objects in the schema or temporary tables", async () => {
    const [row] = await prisma.$queryRaw<Array<{ create: boolean; temporary: boolean }>>`
      SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS "create",
             has_database_privilege(current_user, current_database(), 'TEMPORARY') AS temporary`;
    expect(row).toEqual({ create: false, temporary: false });
  });
});
