# @legaltech/database

Prisma schema, migrations and database client. Only this package may import `@prisma/client`.

- Scope: identity slice (`DATABASE_SPEC.md` v0.1). New entities arrive through approved slices.
- pgvector is **not** installed or configured; it is reserved for the Legal AI/RAG phase.
- Migrations are SQL files in `prisma/migrations`:
  - `20260924120000_init_identity`: schema equivalent to what Prisma generates from `schema.prisma`.
  - `20260924120100_identity_constraints`: manual SQL (email CHECK, append-only trigger on
    `audit_logs`, partial index, REVOKE for the application role).
  - `20260927120000_email_outbox`: the email outbox (`email_outbox`, `email_outbox_kind`); it stores
    the intent only, never a token.
  - `20260927130000_app_role_least_privilege`: the application role gets only what the API uses
    (no `DELETE`/`TRUNCATE`, nothing on `_prisma_migrations`) and no default privileges.
  - `20260927140000_cases`: first Case slice (`cases`, `case_status_history`, enums `case_type`
    and `case_status`, `audit_logs.case_id`), with SELECT/INSERT only for the application role.
  - `20260927150000_documents`: document metadata (`documents` and its enums); the files live in
    object storage.
  - `20260928100000_document_scan_states` and `20260928100100_document_scan`: the document security
    treatment (states, scan columns, derived copy), the pg-boss 12.35.0 schema with the
    `document.scan` queue (installed here by the owner: no runtime role runs DDL or has `CREATE`),
    and the privileges of the worker role (`legaltech_worker`).
- The worker role is created by `infra/docker/postgres/init/01-roles.sql` on a new volume. On an
  existing development volume, create it once as the owner (`CREATE ROLE legaltech_worker LOGIN
PASSWORD 'legaltech_worker_dev'; GRANT CONNECT ON DATABASE legaltech TO legaltech_worker; GRANT
USAGE ON SCHEMA public TO legaltech_worker;`) before `pnpm db:deploy`, or recreate the volume.
- A migration that creates a table must `GRANT` the application role what it needs on it, and add
  the table to `apps/api/src/database.privileges.integration.test.ts` (`DATABASE_SPEC.md`).
- Any change to `schema.prisma` must come with a migration and an update to `docs/DATABASE_SPEC.md`.
- The Prisma Client is generated only by the `generate` script, as its own Turborepo task that `build`,
  `typecheck` and `test` depend on (`turbo.json`), so it runs once per `pnpm build`/`typecheck`/`test`/`dev`
  and before anything reads the client. `prisma generate` rewrites the shared client in place, so
  running it from several tasks at once let a concurrent `tsc` read a half-written client. When
  calling this package's scripts directly (outside Turborepo), run the generator first:
  `pnpm --filter @legaltech/database generate`.
- `DATABASE_URL` (application role) is used at runtime; `DATABASE_MIGRATION_URL` (owner role) is used
  by the Prisma CLI.
