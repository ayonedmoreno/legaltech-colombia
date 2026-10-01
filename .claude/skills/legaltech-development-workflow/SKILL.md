---
name: legaltech-development-workflow
description: Patrón de trabajo por rebanadas de LegalTech Colombia (documentación → implementación → tests → red-team → validación → commit → revisión → push autorizado), con sus puntos de parada y cómo se entrega cada paso. Úsalo al empezar, continuar o cerrar cualquier rebanada o corrección, y antes de preparar un commit o un push.
---

# Flujo de desarrollo por rebanadas

Reglas que no cambian: `legaltech-project-rules`. Estado actual: `legaltech-current-state`.

- La secuencia y las reglas de este skill son las que fijó el usuario.
- La sección «Cómo se hace cada paso» describe **prácticas seguidas hasta ahora**, no requisitos del producto.
- Una instrucción explícita del usuario prevalece siempre sobre este skill, que se actualiza después con su revisión.

## Secuencia

```
DECISIÓN (del usuario, explícita)
→ DOCUMENTACIÓN   (ADR/SPEC/contratos, antes del código)
→ IMPLEMENTACIÓN  (mínima, solo lo decidido)
→ TESTS           (fijan el comportamiento decidido)
→ RED-TEAM        (mutaciones del código de producción)
→ VALIDACIÓN      (CI local completa + pruebas reales)
→ COMMIT          (solo con autorización)
→ REVISIÓN        (del usuario, y de un auditor independiente si así lo pide)
→ PUSH            (solo con autorización explícita) → CI de GitHub
```

Cada paso cierra antes del siguiente. Mantener separados:
**hecho actual → decisión adoptada → implementación → test que fija lo decidido.**
Un test nunca va por delante de la decisión que fija.

## Reglas

- **Alcance definido:** cada rebanada tiene una lista explícita de lo que entra y de lo que no. Si falta, se pide antes de implementar.
- **Sin mezclas:** no se mezclan funcionalidades de otras rebanadas.
- **Precedente del 2026-10-01** (DEC-17), aplicable solo si el usuario vuelve a decidirlo así:
  - las correcciones de auditoría ajenas a la rebanada fueron en un commit aparte;
  - las que estaban físicamente mezcladas en el mismo hunk quedaron en el commit de la rebanada, mencionadas en su mensaje.

  La partición de cada commit la decide el usuario.

- **Trazabilidad:** todo cambio de comportamiento se traza a una decisión (fecha, quién, documento o commit). Ver `legaltech-decision-log`.
- **Decisiones técnicas reversibles:** el usuario autorizó (2026-09-28) tomarlas, documentarlas y continuar. Se detiene el trabajo para decisiones de arquitectura, alcance, seguridad crítica, negocio o jurídicas, y ante cualquier discrepancia de arquitectura, seguridad o privilegios.
- **Sin commit sin autorización. Sin push sin autorización explícita.** Una autorización vale para lo que nombra (estos commits, este push), no para los siguientes.
- **No avanzar** a nuevas funcionalidades al terminar una tarea: entregar el informe y esperar.

## Cómo se hace cada paso

**Documentación.** Se actualiza en el mismo cambio que el código: `API_SPEC.md` (endpoints, errores, eventos de auditoría), `DATABASE_SPEC.md` (esquema, estados, permisos, migraciones), `SECURITY_SPEC.md` (controles, pendientes §12), `ARCHITECTURE_REPORT.md` (hallazgos y decisiones), README y `.env.example`. Versiones y fechas en la cabecera de cada SPEC.

**Tests.** Unitarios con repositorios falsos (`*.repository.fake.ts`) y de integración (`*.integration.test.ts`) contra PostgreSQL, pg-boss, SeaweedFS y ClamAV reales, ejecutados como los roles de ejecución. Los de integración se ejecutan secuencialmente (`--no-file-parallelism`). Práctica seguida para la concurrencia: pruebas deterministas (bloqueo de fila retenido), mejor que carreras al azar.

**Red-team.** Cada mutación cambia una línea del código de producción (nunca un doble de test), ejecuta los tests que deberían detectarla y restaura el fichero verificando su hash. Una mutación que sobrevive es un hueco de tests: se añade el test y se vuelve a ejecutar. Los scripts viven en el scratchpad de la sesión (no en el repo) y pueden perderse al reiniciar.

**Validación** (práctica pedida por el usuario en las rebanadas recientes). CI local completa, equivalente a `.github/workflows/ci.yml`: format:check, lint, typecheck, test, build, `docker compose config`, roles de ejecución, `prisma validate`, `migrate deploy`, comprobación de deriva, `audit_logs` append-only, e integración con servicios reales (dos veces). Además:

- revisar el log de PostgreSQL: DDL solo del rol propietario, y errores de los roles de ejecución solo los provocados por tests;
- `git diff --check` y escaneo de secretos;
- eliminar los contenedores desechables y comprobar que no quedan procesos node sueltos.

**Commit.** Antes de crearlo:

- demostrar con `git status`/`git diff` qué archivos van en cada commit, sin solapamientos ni restos;
- comprobar que el índice coincide con la lista aprobada y que no cambió desde la validación (`git write-tree`).

Convención observada en el historial: el mensaje sigue Conventional Commits (`feat(scope):`, `fix(scope):`, `docs:`, `chore(infra):`), en inglés, con un cuerpo que explica qué y por qué, y termina con:
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

**Informe.** Al terminar se entrega lo que el usuario pidió, punto por punto, con cifras exactas, sin porcentajes inventados, distinguiendo 🟢 implementado / 🟡 parcial / 🔴 pendiente, y con confirmación explícita de lo que **no** se hizo (commit, push, migraciones, permisos).

## Plan de revisión del usuario (2026-10-01)

1. El usuario revisa el informe final.
2. Revisa el artefacto visual, si lo hay.
3. Confirma la delimitación de la rebanada.
4. Autoriza el commit.
5. Revisa el commit.
6. Push solo cuando lo autorice explícitamente.
