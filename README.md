# LegalTech Colombia

LegalTech platform for traffic and transport infractions in Colombia.

- Source of truth: [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md).
- Architecture: [`docs/ARCHITECTURE_REPORT.md`](docs/ARCHITECTURE_REPORT.md) and the ADRs in
  [`docs/adr`](docs/adr).
- Status: **Phase 1** (Sprint 1B authentication slice: register, login, session, CSRF, `/me`,
  logout; plus the web `/login`, `/register` and protected empty `/dashboard`, the auth policy and
  the development seed). No email verification, password reset, MFA, or business features (Cases,
  Documents, Pricing, Payments, Legal AI) yet.

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
pnpm dev                      # API on :4000, web on :3000 (open http://localhost:3000)
```

Checks: `GET http://127.0.0.1:4000/api/health/live` and `/api/health/ready`.

Optional: `pnpm db:seed` creates the development internal accounts (`PROFESSIONAL`, `ADMIN`,
`SUPER_ADMIN`, all `@legaltech.test`) with the password you set in `SEED_INTERNAL_PASSWORD`.

## Scripts

| Script                                          | Purpose                                             |
| ----------------------------------------------- | --------------------------------------------------- |
| `pnpm lint`                                     | ESLint (includes package dependency boundaries)     |
| `pnpm typecheck`                                | TypeScript on every workspace                       |
| `pnpm test`                                     | Vitest on every workspace                           |
| `pnpm build`                                    | Builds packages and apps (Turborepo)                |
| `pnpm format` / `pnpm format:check`             | Prettier                                            |
| `pnpm db:up` / `db:down`                        | Start / stop local PostgreSQL                       |
| `pnpm db:validate` / `db:migrate` / `db:deploy` | Prisma validate / dev migration / deploy            |
| `pnpm db:seed`                                  | Development internal accounts (never in production) |

Run `pnpm format` once after the first install and commit the result before opening the first PR.

## Structure

```
apps/
  api/        Fastify API (modular monolith). Modules: health, auth (users, audit-as-a-module reserved)
  web/        Next.js frontend: /login, /register, protected /dashboard; /api/* proxied to the API
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
  Content-Security-Policy for the web app was deferred at the time; it is now implemented (see
  "Phase 1 closing technical decisions").

## Sprint 1B technical decisions

- Auth persistence goes through an `AuthRepository` interface (`apps/api/src/modules/auth/auth.types.ts`):
  `PrismaAuthRepository` at runtime, `FakeAuthRepository` (in-memory) in tests. This keeps `pnpm test`
  fast and independent of Docker/PostgreSQL. `PrismaAuthRepository` itself is covered against real
  PostgreSQL by `auth.repository.integration.test.ts`. CI runs it after the migrations, as the
  application role, using its PostgreSQL service (no testcontainers):
  `pnpm --filter @legaltech/api test:integration`. The tests are skipped unless
  `INTEGRATION_DATABASE_URL` is set. Only point it at a disposable database, never at your development
  one: the `audit_logs` rows they write can never be deleted.
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
  though MFA itself is not implemented: it blocks those roles when `NODE_ENV=production`. Known gap:
  `NODE_ENV` defaults to `development` when unset, so a production process started without it would
  not apply the barrier. Making it fail closed is a pending decision.
- Per-IP limits are in-memory (`FixedWindowRateLimiter`), a known, documented limitation
  (SECURITY_SPEC.md §7). Per-account login throttling is derived from failed-login events in
  `audit_logs` (ADR-002), so it is stored in PostgreSQL.

## Phase 1 closing technical decisions

- **Single origin (ADR-002).** Next.js rewrites `/api/*` to the API at `API_INTERNAL_URL` (web
  process; defaults to `http://127.0.0.1:4000`). The rewrite is fixed at `next build` time, so a
  deployment must build with its own value. Session and CSRF cookies are therefore first-party and
  no CORS is enabled.
- **Client IP.** The rewrite neither adds the client IP nor strips a client-sent `X-Forwarded-For`, so
  the API trusts `X-Forwarded-For` only from the addresses in `API_TRUST_PROXY` (explicit IPs/CIDRs,
  empty by default). Until an edge proxy exists (deployment decision P3), requests through the web
  proxy share its IP: per-IP limits are global there and audit records that IP (SECURITY_SPEC.md §7).
  The limit cannot be bypassed, but a single client can exhaust it for everyone (5 registrations or
  10 logins per 10 minutes, site-wide): not acceptable for a public deployment until resolved.
- **Policies (ADR-003).** `apps/api/src/common/policy.ts` defines `Actor` and `Decision`; each module
  exposes its own pure policy. `auth.policy.ts` holds the Sprint 1 matrix (`user:read`,
  `session:list`, `session:revoke`, own resources only); `GET /api/auth/me` goes through `user:read`.
- **Development seed (ADR-003).** `apps/api/src/scripts/seed-internal-users.ts` (in the API so it reuses
  its Argon2id parameters; no new dependency). Refuses unless `NODE_ENV` is explicitly `development`
  or `test`, never changes existing accounts, and audits `user.seeded`.
- **Web.** Forms call the API through the proxy; `/dashboard` checks the session on the server
  against `/api/auth/me` and redirects to `/login` otherwise. The web app imports only types from
  `@legaltech/contracts`.
- **CSP.** Per-request nonce set by `apps/web/src/middleware.ts` (SECURITY_SPEC.md §4); every page is
  rendered dynamically so it carries its nonce.

## Security notes

- Never commit `.env` files or secrets. `.env.example` contains development placeholders only.
- Report suspected vulnerabilities privately to the project owner.
