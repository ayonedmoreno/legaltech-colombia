# LegalTech Colombia

LegalTech platform for traffic and transport infractions in Colombia.

- Source of truth: [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md).
- Architecture: [`docs/ARCHITECTURE_REPORT.md`](docs/ARCHITECTURE_REPORT.md) and the ADRs in
  [`docs/adr`](docs/adr).
- Status: **Sprint 1B** (authentication slice: register, login, session, CSRF, `/me`, logout).
  No email verification, password reset, MFA, or business features (Cases, Documents, Pricing,
  Payments, Legal AI) yet.

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

| Script                                    | Purpose                                             |
| ----------------------------------------- | --------------------------------------------------- |
| `pnpm lint`                               | ESLint (includes package dependency boundaries)     |
| `pnpm typecheck`                          | TypeScript on every workspace                       |
| `pnpm test`                               | Vitest on every workspace                           |
| `pnpm build`                              | Builds packages and apps (Turborepo)                |
| `pnpm format` / `pnpm format:check`       | Prettier                                            |
| `pnpm db:up` / `db:down`                  | Start / stop local PostgreSQL                       |
| `pnpm db:validate` / `db:migrate` / `db:deploy` | Prisma validate / dev migration / deploy      |

Run `pnpm format` once after the first install and commit the result before opening the first PR.

## Structure

```
apps/
  api/        Fastify API (modular monolith). Modules: health, auth (users, audit-as-a-module reserved)
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
  Content-Security-Policy for the web app is planned for a later slice.

## Sprint 1B technical decisions

- Auth persistence goes through an `AuthRepository` interface (`apps/api/src/modules/auth/auth.types.ts`):
  `PrismaAuthRepository` at runtime, `FakeAuthRepository` (in-memory) in tests. This keeps `pnpm test`
  fast and independent of Docker/PostgreSQL. It is not a substitute for integration tests against real
  PostgreSQL (testcontainers, already in the dependency list) — a follow-up, not done in this slice.
- Sessions are opaque tokens (ADR-002): only their SHA-256 hash is stored, compared in constant time.
  No cookie signing secret is used — the token itself is the high-entropy secret.
- CSRF uses the double-submit cookie pattern: the CSRF token lives in its own non-`httpOnly` cookie;
  only its hash is stored server-side. `GET /api/auth/csrf` returns the current token, or issues and
  persists a new one if the cookie is missing or stale.
- Both cookies use the `__Host-` prefix (`Secure`, `Path=/`, no `Domain`) — including in local
  development, since modern browsers accept `Secure` cookies on `http://localhost`.
- Session idle/absolute durations are set per role in `auth.session.ts` (ADR-002 durations for `USER`;
  shorter, still-to-confirm durations for internal roles).
- The MFA barrier for `ADMIN`/`SUPER_ADMIN` in production (ADR-002) is wired into login now, even
  though MFA itself is not implemented: it fails closed based on `NODE_ENV`.
- Per-IP and per-account login throttling are in-memory (`FixedWindowRateLimiter`), the same known,
  documented limitation as other in-memory state in this project (SECURITY_SPEC.md).

## Security notes

- Never commit `.env` files or secrets. `.env.example` contains development placeholders only.
- Report suspected vulnerabilities privately to the project owner.
