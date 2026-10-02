---
name: legaltech-current-state
description: Fotografía del estado de LegalTech Colombia al cierre de la rebanada de documentos del 2026-10-01 (branch, HEAD, commits locales sin push, working tree, pruebas, CI, red-team, infraestructura, pendientes y riesgos). Úsalo al empezar una sesión para saber desde dónde se parte, y compruébalo siempre contra git antes de actuar.
---

# Estado actual: cierre del 2026-10-01

> **FOTOGRAFÍA DEL 2026-10-01: DATOS DINÁMICOS QUE DEBEN VERIFICARSE ANTES DE USARLOS.**
>
> Todo lo que cambia con el tiempo es solo una fotografía, no un hecho vigente: HEAD, branch, `origin/main`, commits locales y sin push, working tree, resultados de pruebas, CI, red-team, contenedores e infraestructura, pendientes y riesgos.
>
> Antes de usarlo, verificarlo contra git y el entorno:
> `git -c safe.directory=C:/legaltech-colombia status -sb`
> `git -c safe.directory=C:/legaltech-colombia log --oneline origin/main..main`
> `docker ps -a`
>
> Si git o el entorno muestran otra cosa, mandan ellos: hay que avisar de que este skill está desactualizado y actualizarlo después, con revisión del usuario. Si existe un estado posterior documentado, no se usan los datos de aquí. Este skill no es una autoridad superior a una decisión explícita posterior del usuario.

## Git (fotografía; verificar)

- **Branch:** `main`. **`origin/main`:** `7f64f79` (push del 2026-10-01; CI 36941991867 en verde).
- **Commits locales sin push** (fotografía del 2026-10-02):
  - `20c7e74` `docs: OCR design decisions (Phase 3)`;
  - `a6c14de` primera parte de la implementación del OCR;
  - `dc9268d` corrección de la exclusión de PDF frente a A7;
  - el commit de la ronda 1 de la evaluación del OCR (instrumento aislado en `tools/ocr-evaluation/` y resultados en `docs/ocr-provider-evaluation.md`).
- **Push:** no realizado; requiere autorización explícita (DEC-23).
- **Working tree:** `.agents/` no está versionado: es un artefacto externo que no se toca (DEC-23). `.claude/settings.local.json` está ignorado por la configuración global de git.
- **Git exige** `-c safe.directory=C:/legaltech-colombia`.

## Pruebas (fotografía sobre el contenido de `c9e8139`, 2026-10-01)

| Paquete   | Unitarias | Integración (servicios reales) |
| --------- | --------- | ------------------------------ |
| api       | 653       | 99                             |
| worker    | 61        | 35                             |
| web       | 66        | —                              |
| contracts | 35        | —                              |
| storage   | 4         | 5                              |

- **Resultado:** todas pasan. Las «omitidas» de la ejecución unitaria son las de integración.
- **Tras los commits:** el tree de HEAD es idéntico al validado por el CI; la typecheck y el lint pasan.

## CI (fotografía)

- **CI local** (equivalente a `.github/workflows/ci.yml`): todos los pasos en PASS, con la integración ejecutada dos veces.
  - Pasos: format, lint, typecheck, test, build, compose, roles, prisma validate, migrate deploy, deriva, append-only e integración con PostgreSQL, pg-boss, SeaweedFS y ClamAV.
- **Log de PostgreSQL:** el DDL viene solo de `legaltech_owner`. Los errores de los roles de ejecución son los provocados por los tests.
- **CI de GitHub:** run 36941991867 sobre `7f64f79`, **completado y en verde**. Pasaron el job `quality` (format, lint, typecheck, test, build, compose, roles, prisma, deriva, append-only, integración con PostgreSQL, pg-boss, S3 y ClamAV) y el job `secrets-scan` (gitleaks). Como `gh` no está instalado en esta máquina, se consulta con la API pública de GitHub.

## Red-team (2026-10-01)

- Tramo del 2026-10-01: 29/29 detectadas.
- Tratamiento de seguridad de documentos: 44/44.
- General (auth, sesiones, RBAC, casos, proxy): 47/47.
- Ninguna sobrevive, y los 243 ficheros se restauraron verificados por hash.
- Los scripts estaban en el scratchpad de la sesión, que no persiste: hay que reconstruirlos si se necesitan.

## Pruebas a escala real (2026-10-01)

- **Cuota concurrente:** con 9 × 10 MiB ya usados y 8 subidas simultáneas de 3 MiB, se aceptaron 3 y se rechazaron 5. Uso final: 103.809.024 B de 104.857.600 B; 12 filas para 12 objetos.
- **PutObject guardado sin respuesta:**
  - con el borrado bloqueado: 503, sin documento, el objeto se queda y se registra `storage.orphan_object` con su clave;
  - con el borrado reenviado: el objeto desaparece y aun así se registra el evento.
- **Proxy:** 10 MiB → 201; de 10,0001 a 100 MiB → 413.
- **ClamAV caído:** 5 intentos en 742 s hasta `SCAN_FAILED`.

## Infraestructura (fotografía)

- **Docker de desarrollo:** `infra/docker/docker-compose.yml`, con:
  - `postgres:17`, el contenedor `legaltech-postgres-1` en 127.0.0.1:5432, que **no se toca**;
  - `chrislusf/seaweedfs:4.47`;
  - `clamav/clamav:1.5.4`, fijado por digest.
- **Pruebas:** contenedores desechables (p. ej. 15432, 18333, 13310) que se eliminan al terminar. No queda ninguno.
- **Roles:** `legaltech_owner` (migraciones), `legaltech_app` (API) y `legaltech_worker`.
- **Producción:** no existe; depende de P3.

## Pendiente (solo enumerado: no son requisitos ni alcance de ninguna rebanada)

- **Fase 3:**
  - OCR: primera parte implementada el 2026-10-02 (DEC-24) y **desactivada**: faltan el proveedor (P4) y el almacenamiento y la lectura del texto (OCR-A10.5);
  - ronda 1 de la evaluación (sintéticos, Tesseract local) hecha el 2026-10-02: B8 medido, insumo para decidir OCR-A10.5, con B2 provisional. P4 sigue abierta (ronda 2 con documentos reales anonimizados, 8a bloqueada);
  - la 8b está resuelta (sintéticos permitidos en la primera ronda; DEC-22); la implementación puede empezar detrás de `OcrProvider`, pero el cierre espera a P4, que exige documentos reales anonimizados y la 8a (bloqueada); A10.5 espera a B8; OCR-A10.5;
  - metadata de PDF (P7), ClamAV de producción.
- La extracción de entidades ya no forma parte de la Fase 3 (OCR-A1).
- **Producción:** P3, MFA, entrega real de email, backups, pentest, límite por IP real.
- **Casos:** cuestionario dinámico y V1–V8.
- **Fases futuras:** pricing, pagos, IA/RAG y paneles profesional y administrativo, incluida la UI del reprocesamiento y de la auditoría.
- **Documentos:** reconciliación de huérfanos; política de liberación de la cuota (depende de la eliminación y retención); eliminación y versiones de documentos.

## Riesgos conocidos

- **Límite por IP global** detrás del proxy web: denegación de servicio del registro y del login. Impide publicar hasta P3.
- **Sin email real:** la verificación y la recuperación no llegan al usuario.
- **Sin MFA:** ningún ADMIN puede operar en producción, ni siquiera para reprocesar.
- **Huérfanos:** solo se registran en el log; sin reconciliación pueden acumularse en el almacenamiento.
- **Cuota sin liberación:** un usuario con documentos `INFECTED` o `SCAN_FAILED` consume cuota sin poder liberarla.
- **PDF con metadata:** se entrega intacto a su propietario; bloquea su descarga por otros roles.
- **ClamAV de desarrollo:** sin actualizar firmas; con la configuración por defecto, un contenido demasiado grande o cifrado puede resultar «sin amenazas».
- **Límite por IP en memoria:** no se comparte entre instancias.
- **Scratchpad efímero:** los scripts de red-team y de pruebas a escala no están en el repositorio.
- **AUD-02** — **DECISIÓN HISTÓRICA / ESTADO NO VERIFICADO:** en el Sprint 1B se observó que dos eventos de auditoría se escribían fuera de su transacción. No se ha comprobado si sigue así (ver `legaltech-decision-log`).
