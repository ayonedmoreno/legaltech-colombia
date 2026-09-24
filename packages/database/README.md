# @legaltech/database

Prisma schema, migrations and database client. Only this package may import `@prisma/client`.

- Scope: identity slice (`DATABASE_SPEC.md` v0.1). New entities arrive through approved slices.
- pgvector is **not** installed or configured; it is reserved for the Legal AI/RAG phase.
- Migrations are SQL files in `prisma/migrations`:
  - `20260924120000_init_identity`: schema equivalent to what Prisma generates from `schema.prisma`.
  - `20260924120100_identity_constraints`: manual SQL (email CHECK, append-only trigger on
    `audit_logs`, partial index, REVOKE for the application role).
- Any change to `schema.prisma` must come with a migration and an update to `docs/DATABASE_SPEC.md`.
- `DATABASE_URL` (application role) is used at runtime; `DATABASE_MIGRATION_URL` (owner role) is used
  by the Prisma CLI.
