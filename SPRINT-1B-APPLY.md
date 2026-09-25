# Sprint 1B: autenticación. Guía de aplicación

Este ZIP contiene solo los archivos nuevos o modificados respecto a tu repositorio actual
(Sprint 1A + parches `packageManager` y `error-handler`). NO incluye `pnpm-lock.yaml`,
`.github/workflows/ci.yml` ni el `package.json` raíz: ya los tienes.

## Archivos nuevos (25)

- apps/api/src/common/http-error.ts
- apps/api/src/modules/auth/auth.audit.test.ts
- apps/api/src/modules/auth/auth.cookies.ts
- apps/api/src/modules/auth/auth.csrf.test.ts
- apps/api/src/modules/auth/auth.login.test.ts
- apps/api/src/modules/auth/auth.mapper.ts
- apps/api/src/modules/auth/auth.me-logout.test.ts
- apps/api/src/modules/auth/auth.origin.ts
- apps/api/src/modules/auth/auth.rate-limit.test.ts
- apps/api/src/modules/auth/auth.register.test.ts
- apps/api/src/modules/auth/auth.repository.fake.ts
- apps/api/src/modules/auth/auth.repository.ts
- apps/api/src/modules/auth/auth.routes.ts
- apps/api/src/modules/auth/auth.service.ts
- apps/api/src/modules/auth/auth.session.test.ts
- apps/api/src/modules/auth/auth.session.ts
- apps/api/src/modules/auth/auth.types.ts
- apps/api/src/security/crypto.ts
- apps/api/src/security/password.ts
- apps/api/src/security/rate-limiter.ts
- apps/api/src/test-support/build-test-app.ts
- apps/api/src/test-support/cookies.ts
- packages/contracts/src/auth.test.ts
- packages/contracts/src/auth.ts
- packages/contracts/src/role.ts

## Archivos modificados (8)

- README.md
- apps/api/package.json
- apps/api/src/app.ts
- apps/api/src/modules/health/health.routes.test.ts
- apps/api/src/plugins/error-handler.ts
- apps/api/src/server.ts
- docs/API_SPEC.md
- packages/contracts/src/index.ts

## Archivo a eliminar

- apps/api/src/modules/auth/.gitkeep (ya no hace falta: el módulo tiene archivos reales)

## Aplicar (PowerShell, desde C:\legaltech-colombia)

    git status                                   # conviene que esté limpio antes de aplicar
    Expand-Archive -Path "$env:USERPROFILE\Downloads\legaltech-colombia-sprint-1b-delta.zip" -DestinationPath . -Force
    Remove-Item apps\api\src\modules\auth\.gitkeep -ErrorAction SilentlyContinue
    Remove-Item SPRINT-1B-APPLY.md

## Validar (en este orden)

    pnpm.cmd install                             # actualiza pnpm-lock.yaml con @fastify/cookie y @node-rs/argon2
    pnpm.cmd format                              # los archivos nuevos no pasaron por Prettier
    pnpm.cmd format:check
    pnpm.cmd lint
    pnpm.cmd typecheck
    pnpm.cmd test
    pnpm.cmd build
    pnpm.cmd db:validate
    pnpm.cmd db:migrate
    git status
    git diff --stat
    git diff --check

Si `pnpm install` no encuentra las versiones de `@fastify/cookie` (^11) o `@node-rs/argon2` (^2),
resuélvelas con:

    pnpm.cmd --filter @legaltech/api add @fastify/cookie @node-rs/argon2

No hagas commit ni push hasta revisar los resultados.
