# LegalTech Colombia

LegalTech platform for traffic and transport infractions in Colombia.

- Source of truth: [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md).
- Architecture: [`docs/ARCHITECTURE_REPORT.md`](docs/ARCHITECTURE_REPORT.md) and the ADRs in
  [`docs/adr`](docs/adr).
- Status: **Sprint 1A** (technical foundation). No functional authentication or business features yet.

## Prerequisites

- Node.js 22 (see `.nvmrc`)
- pnpm 10 (`corepack enable`)
- Docker (for local PostgreSQL)

## Quick start

```bash
cp .env.example .env          # development placeholders only; never commit real secrets
pnpm install                  # generates pnpm-lock.yaml on first run: commit it
pnpm db:up                    # PostgreSQL on 127.0.0.1:5432 (Docker)
pnpm db:deploy                # applies the Prisma migrations
pnpm build
pnpm dev                      # API on :4000, web on :3000
```

Checks: `GET http://127.0.0.1:4000/api/health/live` and `/api/health/ready`.

## Scripts

| Script                                          | Purpose                                         |
| ----------------------------------------------- | ----------------------------------------------- |
| `pnpm lint`                                     | ESLint (includes package dependency boundaries) |
| `pnpm typecheck`                                | TypeScript on every workspace                   |
| `pnpm test`                                     | Vitest on every workspace                       |
| `pnpm build`                                    | Builds packages and apps (Turborepo)            |
| `pnpm format` / `pnpm format:check`             | Prettier                                        |
| `pnpm db:up` / `db:down`                        | Start / stop local PostgreSQL                   |
| `pnpm db:validate` / `db:migrate` / `db:deploy` | Prisma validate / dev migration / deploy        |

Run `pnpm format` once after the first install and commit the result before opening the first PR.

## Structure

```
apps/
  api/        Fastify API (modular monolith). Modules: health (auth, users, audit reserved for 1B)
  web/        Next.js frontend (placeholder home)
packages/
  contracts/       Shared Zod schemas and types
  database/        Prisma schema, migrations, client (identity slice only)
  legal-engine/    Skeleton (Legal AI phase)
  pricing-engine/  Skeleton (Pricing phase)
  ai/              Skeleton (Legal AI phase)
  tooling/         Shared tsconfig bases
infra/docker/      Local PostgreSQL and role bootstrap
docs/              Specifications and ADRs
```

Dependency rules (ADR-001) are enforced by lint: only `packages/database` imports `@prisma/client`;
`legal-engine` and `pricing-engine` import no database, AI or framework code.

## Sprint 1A technical decisions

- Workspace packages are compiled with `tsc` to `dist/` (ESM, NodeNext); Turborepo orders the builds.
- Dependencies use major-version ranges (`^X`); `pnpm-lock.yaml` pins exact versions.
- Prisma 6 (`prisma-client-js`). Moving to a newer major is a separate, reviewed change.
- Two database roles: owner (migrations, `DATABASE_MIGRATION_URL`) and application (runtime,
  `DATABASE_URL`). The application role cannot modify `audit_logs`.
- Migrations are hand-written SQL kept equivalent to `schema.prisma`; CI runs `prisma migrate diff`
  to detect drift.
- pgvector is not installed; it is reserved for the Legal AI/RAG phase.
- Base security: helmet, request ids, uniform errors without internal details, validated
  environment, log redaction of cookies and `Authorization`, PostgreSQL bound to localhost, gitleaks.
  Content-Security-Policy for the web app is planned for Sprint 1B.

## Security notes

- Never commit `.env` files or secrets. `.env.example` contains development placeholders only.
- Report suspected vulnerabilities privately to the project owner.
