# Fix de 3 fallos del Sprint 1B (5 tests): aplicar sobre C:\legaltech-colombia

6 archivos, todos dentro de apps/api/src/modules/auth/. Sustituyen a los que ya tienes
(mismos nombres y rutas): sobrescribe directamente, no hay archivos nuevos ni a borrar.

## Aplicar (PowerShell, desde C:\legaltech-colombia)

    Expand-Archive -Path "$env:USERPROFILE\Downloads\legaltech-colombia-csrf-fix.zip" -DestinationPath . -Force
    Remove-Item SPRINT-1B-FIX-APPLY.md

## Validar

    pnpm --filter @legaltech/api exec vitest run --reporter=verbose
    pnpm test
    pnpm typecheck
    pnpm build
    git diff --stat
    git status

No hagas commit ni push todavía.
