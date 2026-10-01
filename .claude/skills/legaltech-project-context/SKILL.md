---
name: legaltech-project-context
description: Contexto de LegalTech Colombia (plataforma de tránsito y transporte): propósito, arquitectura y stack vigentes, estructura del monorepo, fases y rebanadas realizadas, qué está implementado, parcial o pendiente, y dependencias entre componentes. Úsalo para orientarte antes de cualquier tarea en este repositorio o cuando haya que explicar qué existe y qué no.
---

# Contexto del proyecto

Fotografía del estado real a 2026-10-01 (HEAD `c9e8139`): los datos dinámicos hay que verificarlos contra git (ver `legaltech-current-state`). Para el porqué, ver `legaltech-decision-log`.

- **Este skill resume, no decide.** Si choca con una decisión explícita posterior del usuario o con un documento de rango superior, mandan ellos y el skill se actualiza tras la revisión del usuario.
- **Lo marcado 🔴 es pendiente, no un requisito.**

Leyenda: 🟢 implementado · 🟡 parcial / en desarrollo · 🔴 pendiente o no definido.

## Propósito (`PROJECT_SPEC.md` s.1–s.3)

- **Qué es:** una plataforma web LegalTech para infracciones de tránsito, transporte y actuaciones administrativas en Colombia.
- **Qué hace el usuario:** crea un caso, sube documentos, recibe un diagnóstico preliminar y una valoración, paga, y obtiene gestión jurídica con seguimiento.
- **Límites del servicio:**
  - nunca promete eliminar, reducir ni condonar una infracción;
  - la IA no inventa normas, artículos ni plazos, y toda conclusión jurídica debe poder relacionarse con una fuente almacenada;
  - hay supervisión humana, trazabilidad y seguridad desde el inicio.

## Arquitectura vigente (ADR-001; `ARCHITECTURE_REPORT.md` §2)

```
Navegador → apps/web (Next.js) ──/api/* mismo origen──► apps/api (Fastify)
                                                      ├─► PostgreSQL 17 (Prisma; esquema pgboss)
                                                      └─► Storage S3 privado (StorageProvider)
apps/worker (pg-boss) ─► PostgreSQL · Storage · ClamAV (INSTREAM)
Futuro 🔴: OCR/extracción, pricing-engine, legal-engine, IA/RAG (pgvector), pagos, email real
```

- **Forma general:**
  - monolito modular con un worker separado, sin microservicios;
  - la API usa capas `routes → service → repository` más una `policy` por módulo;
  - los contratos Zod están en `packages/contracts`.
- **Cola:** pg-boss sobre el mismo PostgreSQL. La API solo encola, dentro de su transacción; el worker consume las colas.
- **Reglas de dependencia:**
  - `apps/*` pueden depender de `packages/*`, nunca al revés;
  - `legal-engine` y `pricing-engine` no dependen de `database`, `ai` ni de frameworks;
  - solo `packages/database` importa Prisma.
- **Idioma (D4):** código, base de datos y API en inglés; la interfaz y las rutas visibles, en español.

## Stack

- **Base:** Node 22 (`.nvmrc`), pnpm 10, Turborepo, TypeScript estricto, Zod 3.
- **Web:** Next.js 15 (App Router), React 19 y Tailwind 4, con estilos Tailwind slate. `ARCHITECTURE_REPORT.md` §2 menciona shadcn/ui, que hoy no está instalado. No se añade sin decisión.
- **API:** Fastify 5, helmet y Argon2id (`@node-rs/argon2`).
- **Base de datos:** PostgreSQL 17 con Prisma 6.
- **Cola:** pg-boss 12.35.0, versión fijada.
- **Almacenamiento:** AWS SDK S3 contra SeaweedFS 4.47 en desarrollo y CI.
- **Antivirus:** ClamAV 1.5.4, fijado por digest, solo para desarrollo y CI.
- **Tests:** Vitest.
- **CI:** GitHub Actions (`.github/workflows/ci.yml`), con gitleaks.

## Monorepo

| Ruta                                            | Contenido                                                                                                                                                                               | Estado               |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `apps/web`                                      | Rutas en español, CSP con nonce, proxy `/api/*`, guarda 413 de subidas                                                                                                                  | 🟢                   |
| `apps/api`                                      | Módulos `auth`, `users`, `audit`, `notifications` (outbox), `cases`, `documents` (+ rutas `admin/documents`), `health`; `jobs/job-queue.ts`                                             | 🟢                   |
| `apps/worker`                                   | Tratamiento de seguridad de documentos, barrido, reprocesamiento                                                                                                                        | 🟢                   |
| `packages/contracts`                            | Esquemas Zod, códigos de error, `DOCUMENT_MAX_BYTES` y `DOCUMENT_QUOTA_BYTES`                                                                                                           | 🟢                   |
| `packages/database`                             | Esquema Prisma y migraciones (incluye `pgboss` y los permisos)                                                                                                                          | 🟢                   |
| `packages/storage`                              | `StorageProvider` S3 con timeouts, bucket de desarrollo                                                                                                                                 | 🟢                   |
| `packages/ai`, `legal-engine`, `pricing-engine` | Esqueletos vacíos                                                                                                                                                                       | 🔴                   |
| `packages/tooling`                              | Configuración compartida                                                                                                                                                                | 🟢                   |
| `infra/docker/docker-compose.yml`               | postgres:17, seaweedfs 4.47, clamav 1.5.4                                                                                                                                               | 🟢 (solo desarrollo) |
| `docs/`                                         | PROJECT_SPEC, ARCHITECTURE_REPORT, API/DATABASE/SECURITY_SPEC, `adr/` ADR-001..003. Tiene contradicciones conocidas, que no se resuelven automáticamente: ver `legaltech-project-rules` | 🟢                   |

## Fases (`PROJECT_SPEC.md` s.34) y rebanadas

| Fase              | Estado                                                                                                | Rebanadas y commits clave                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 Diseño          | 🟢 documentos aprobados el 2026-09-24                                                                 | ADR-001/002/003, ARCHITECTURE_REPORT, specs                                                                                                                                                                                 |
| 1 Foundation      | 🟢 cerrada 2026-09-27, `ef7920c`, CI run 36360859619                                                  | Sprint 1A (monorepo, CI, roles); Sprint 1B (auth completa) `40eaea1`…`ef7920c`                                                                                                                                              |
| 2 Cases           | 🟢 cerrada 2026-09-27 con alcance reducido, `f0853c4`                                                 | Rebanada Case `7656168`…`b60ad0c`; máquina de estados `105e340`, `02592e9`. Cuestionario bloqueado                                                                                                                          |
| 3 Documents       | 🟡 en curso: `PROJECT_SPEC.md` s.34 la define como «Carga, almacenamiento y OCR», y el OCR (P4) falta | R1 `e9b847f`…`66e23f3` (subida/descarga); R2 `2d96706`…`f6bd73b` (antivirus, metadata); 3.2b `91b4b28`, `4c2dee4`, `c7d6cbb` (barrido, mínimo privilegio); cierre 2026-10-01 `c9e8139` (timeouts, límite, cuota, reproceso) |
| 4 Pricing         | 🔴                                                                                                    | —                                                                                                                                                                                                                           |
| 5 Payments        | 🔴                                                                                                    | —                                                                                                                                                                                                                           |
| 6 Legal AI        | 🔴                                                                                                    | —                                                                                                                                                                                                                           |
| 7 Professionals   | 🔴                                                                                                    | —                                                                                                                                                                                                                           |
| 8 Administration  | 🔴                                                                                                    | —                                                                                                                                                                                                                           |
| 9 Security        | 🔴                                                                                                    | —                                                                                                                                                                                                                           |
| 10 MVP Production | 🔴                                                                                                    | —                                                                                                                                                                                                                           |

## Funcionalidades

🟢 **Implementado**

- **Autenticación:**
  - registro (solo USER), login, logout y `/me`;
  - listado y revocación de las sesiones propias, y `logout-all`;
  - verificación de email y su reenvío; recuperación y restablecimiento de contraseña;
  - rotación periódica y al iniciar sesión;
  - límite por IP y retardo progresivo por cuenta; CSRF; barrera MFA en producción.
- **RBAC:** policies por módulo (ADR-003); un recurso ajeno responde 404.
- **Auditoría:** append-only, con permisos y trigger.
- **Casos:** crear (7 tipos, siempre en `DRAFT`, con historial y auditoría), listar y consultar los propios.
- **Documentos:**
  - subir PDF, JPEG y PNG por su contenido real, solo en casos `DRAFT` propios;
  - listar los propios y descargar solo los `CLEAN`, con una URL firmada de 60 s;
  - antivirus ClamAV en el worker, y copia sin metadata de JPEG y PNG;
  - barrido de recuperación y reintentos (5 intentos);
  - límite único de 10 MiB y cuota de 100 MiB por usuario;
  - timeouts de almacenamiento y compensación almacenamiento ↔ base de datos, con `storage.orphan_object` en el log;
  - reprocesamiento de `SCAN_FAILED`, solo por ADMIN.
- **Web:** `/`, `/iniciar-sesion`, `/registro`, `/recuperar-contrasena`, `/restablecer-contrasena`, `/verificar-correo`, `/panel`, `/casos`, `/casos/nuevo` y `/casos/[id]` (estado, historial y documentos).

🟡 **Parcial**

- **Panel:** solo muestra casos activos y cerrados. Faltan pagos, documentos pendientes, alertas y últimas actualizaciones (s.11).
- **Email:** el outbox existe, pero solo lo despacha un comando de desarrollo que escribe ficheros locales. No hay entrega real.
- **Auditoría:** se registra, pero no hay pantalla de consulta.
- **Reprocesamiento:** existe en la API, sin interfaz.
- **Estados del caso:** los 15 existen y solo `DRAFT` es alcanzable.
- **Límite por IP:** es global detrás del proxy hasta tener un borde de confianza (P3).
- **ClamAV y almacenamiento:** configuración solo de desarrollo y CI.

🔴 **Pendiente o no definido** (solo enumerado; no son requisitos ni alcance de ninguna rebanada)

- **Fase 3:** OCR y extracción revisable (P4), metadata de PDF (P7), ClamAV de producción.
- **Producción:** nube y región (P3), MFA, envío real de email.
- **Casos:** cuestionario dinámico (sin contenido aprobado); transiciones T1–T10 (deshabilitadas) y decisiones V1–V8.
- **Fases futuras:** pricing, pagos, IA/RAG/motor jurídico y paneles profesional y administrativo.
- **Documentos:** eliminación y retención; reconciliación de huérfanos; política de liberación de la cuota.
- **Cuestiones jurídicas (validación colombiana):** retención, consentimiento, transferencia internacional, T&C, reembolsos, quién presta el servicio y mandato para radicar.
- **No definido en ningún documento:** «sistema de beneficios» y «herramientas jurídicas».

## Dependencias entre componentes

- **Web → API:** la web solo habla con la API, a través de `/api/*` en el mismo origen. Comparte `contracts` (límite, etiquetas, esquemas).
- **API → PostgreSQL** como `legaltech_app`:
  - permisos S/I/U en las tablas de autenticación; S/I en `audit_logs`, `cases`, `case_status_history` y `documents`;
  - solo encola en `pgboss`.
- **API → Storage:** escribe primero el objeto y después la fila. Si un lado falla, compensa.
- **API → cola:** encola `document.scan` (con la subida) y `document.reprocess` (con la petición ADMIN), en la misma transacción que la fila o el evento.
- **Worker → PostgreSQL** como `legaltech_worker`: UPDATE solo de 6 columnas de `documents`, INSERT en `audit_logs` y lo mínimo de `pgboss`.
- **Worker → Storage:** lee el original y escribe la copia derivada. **Worker → ClamAV:** INSTREAM.
- **Migraciones:** las ejecuta `legaltech_owner`. Ningún proceso de ejecución hace DDL.
- **Desbloqueos pendientes:**
  - el OCR (P4) depende de P3 (región y residencia de datos);
  - la descarga por otros roles depende de P7;
  - las transiciones del caso dependen de V1–V8 y de sus fases;
  - el estado `PAID` depende de un webhook de pago verificado (T4).
