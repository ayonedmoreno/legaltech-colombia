# ARCHITECTURE_REPORT.md

**Versión:** 1.0
**Fecha:** 2026-09-24
**Estado:** Arquitectura general aprobada por el responsable del producto, con los criterios de la sección 5.
**Fuente principal de verdad:** [`PROJECT_SPEC.md`](./PROJECT_SPEC.md). Este informe la complementa y, cuando una decisión aprobada la modifica, el cambio queda registrado en un ADR.

---

## 1. Evaluación de PROJECT_SPEC.md

### Fortalezas que se conservan

- `Case` como objeto central y genérico (escala a empresas y flotas).
- La IA nunca responde directamente: OCR, extracción, retriever, reglas, LLM y validación. Las reglas determinísticas quedan fuera de la IA.
- Vigencia temporal de las normas (s.20).
- Pagos confirmados solo por webhook (s.23).
- Separación entre valor de la obligación, valor del servicio y resultado (s.4); Pricing Engine fuera del frontend.
- Sin promesas de resultado, supervisión humana y trazabilidad.
- Control de acceso por recurso contra IDOR (s.27).
- Documentos primero y exclusiones claras del MVP.

### Hallazgos y propuestas

| # | Hallazgo | Propuesta | Estado |
|---|---|---|---|
| 1 | Dependencia circular: el precio depende de complejidad y diagnóstico, pero el roadmap pone Pricing (F4) y Pagos (F5) antes de Legal AI (F6). | Pricing v0 por cuestionario y complejidad asignada por un profesional. | Pendiente de confirmación (ver sección 6) |
| 2 | El panel profesional no está en el MVP (s.33), pero sí la generación de documentos y se excluye la "automatización sin revisión". | Panel profesional mínimo antes de activar pagos reales. | Pendiente de confirmación |
| 3 | Seguridad y auditoría al final (s.30 pasos 15 y 17; F9) vs s.26 "desde el comienzo". | RBAC, auditoría y tests desde la Fase 1. | Adoptado por D2, D3 y D5 |
| 4 | Orden de la IA inconsistente entre s.19 y el diagrama de s.36. | Reglas determinísticas, luego LLM con fuentes, luego validador de citas. Se fija en `AI_SPEC.md`. | Por documentar en Fase 7 |
| 5 | El MVP incluye generación de documentos y notificaciones, pero el roadmap no tiene fase para ellos ni para el expediente (`Proceedings`). | Añadir fases. | Pendiente de confirmación |
| 6 | La s.38 prohíbe la BD definitiva antes de `DATABASE_SPEC.md`. | `DATABASE_SPEC.md` incremental por rebanadas. | **Aprobado (D5)** |
| 7 | `ai/` y `legal/` como módulos de la API (s.14) y `legal-engine/`, `pricing-engine/` como componentes (s.21-22). | Paquetes puros en el monorepo; módulos de la API como adaptadores finos. | **Aprobado (D1)** |
| 8 | No hay trabajo asíncrono. | Worker separado y pg-boss. | **Aprobado (D1)** |
| 9 | Entidades faltantes: `Quote/Offer`, `Outcome`, `TermsAcceptance`, `OcrResult`, `ExtractedEntity`, `AiRun`, `LegalRule`, `Deadline`, `Vehicle`/partes, `GeneratedDocument`, `Task`. | Incorporarlas en `DATABASE_SPEC.md` en la fase que corresponda. | Diferido |
| 10 | `LegalSource` con un solo `embedding` y sin fin de vigencia. | `LegalSourceChunk`, más `valid_from` y `valid_to`. | Diferido a Fase 7 |
| 11 | Estados del caso sin matriz de transiciones. | Máquina de estados explícita y con tests. | Diferido a Fase 2 |
| 12 | Tablas `Role`/`Permission` frente a 4 roles fijos. | Roles como enum y matriz en código, con camino de evolución. | **Aprobado (D3)** |
| 13 | Autenticación sin definir; webhook y idempotencia ausentes en la API. | Ver ADR-002 y fases de pagos. | **Aprobado (D2)** |
| 14 | Riesgo de abuso de costos en diagnóstico pre-pago. | Cuotas y rate limits por usuario. | Diferido a Fases 3 y 7 |
| 15 | Datos personales sensibles: retención, borrado, consentimiento, transferencia internacional. | Validar con abogado colombiano. | **Decisión jurídica pendiente** |
| 16 | Modelo operativo del servicio jurídico, autorización ante autoridades, T&C, reembolsos. | Validar con abogado colombiano. | **Decisión jurídica pendiente** |
| 17 | Corpus jurídico sin responsable ni política de licencias. | Definir antes de la Fase 7. | Pendiente |
| 18 | Validación de archivos limitada a tipo y tamaño. | Contenido real, antivirus y limpieza de metadata. | Diferido a Fase 3 |
| 19 | Convenciones de idioma mezcladas. | Código, BD y API en inglés; UI y rutas en español. | **Aprobado (D4)** |

---

## 2. Arquitectura recomendada

Monolito modular más un worker separado. Sin microservicios en el MVP.

```
Navegador ──► Next.js (apps/web) ──HTTP/cookie──► API Fastify (apps/api)
                                                     │
        ┌───────────────┬───────────────┬────────────┼─────────────┬───────────────┐
        ▼               ▼               ▼            ▼             ▼               ▼
   PostgreSQL     Object Storage    Job queue    pricing-engine  legal-engine   PaymentGateway
   (pgvector: F7)   (privado)       (pg-boss)     (paquete puro)  (paquete puro)  (adaptador)
                                        │
                                        ▼
                                  apps/worker ──► OcrProvider · EntityExtractor
                                                  packages/ai: LLMProvider · EmbeddingProvider
                                                  Retriever · OutputValidator
```

- **Frontend:** Next.js App Router, React, TypeScript estricto, Tailwind, shadcn/ui. Sin lógica de negocio ni tarifas.
- **Backend:** Fastify, capas `routes → service → repository` más `policy` por módulo. Contratos Zod compartidos y OpenAPI generado para mantener `API_SPEC.md` sincronizado.
- **Autenticación y autorización:** ver ADR-002 y ADR-003.
- **Base de datos:** PostgreSQL y Prisma, IDs UUID, `pgvector` para embeddings (Fase 7; no se instala ni configura antes de la fase de Legal AI/RAG), dinero en enteros. Las consultas de similitud y algunos índices irán con SQL crudo y migraciones manuales.
- **Trabajos asíncronos:** pg-boss sobre el mismo Postgres, detrás de una interfaz `JobQueue`.
- **Almacenamiento:** bucket privado compatible con S3 detrás de `StorageProvider`; URLs prefirmadas de corta vida; descargas siempre autorizadas por la API.
- **OCR y extracción:** `OcrProvider` y `EntityExtractor`; todo dato extraído queda "por revisar" hasta confirmación.
- **IA (`packages/ai`):** `LLMProvider`, `EmbeddingProvider`, `Retriever`, prompts versionados, `OutputValidator` y registro `AiRun`.
- **Legal Engine y Pricing Engine:** paquetes TypeScript puros, sin dependencias de Prisma ni Fastify.
- **Pagos:** `PaymentGateway`; webhook con firma verificada, consulta server-to-server e idempotencia por ID de evento.
- **Notificaciones:** patrón outbox, email primero.
- **Auditoría:** servicio append-only.
- **Observabilidad y secretos:** pino con redacción, request-id, Sentry con scrubbing de PII; secretos solo por entorno.

**Reglas de dependencia entre paquetes:** `apps/*` pueden depender de `packages/*`; los `packages/*` nunca dependen de `apps/*`; `legal-engine` y `pricing-engine` no dependen de `database`, `ai` ni de frameworks.

---

## 3. Estructura del repositorio

```
legaltech-colombia/
├── apps/
│   ├── web/
│   ├── api/
│   └── worker/                # se crea cuando exista el primer job (Fase 3)
├── packages/
│   ├── contracts/
│   ├── database/
│   ├── legal-engine/
│   ├── pricing-engine/
│   ├── ai/
│   └── tooling/
├── docs/
│   └── adr/
├── infra/docker/
├── .github/workflows/
└── (raíz: package.json, pnpm-workspace.yaml, turbo.json, .env.example, ...)
```

La estructura implementada al cierre del Sprint 1A se describe en el `README.md` de la raíz.

---

## 4. Dependencias

Las dependencias se declaran en el `package.json` de cada workspace con rangos de versión mayor (`^X`); el lockfile (`pnpm-lock.yaml`) fija las versiones exactas. Criterios:

- Solo dependencias con función justificada en el ADR o en la fase correspondiente.
- **Excluidas salvo ADR posterior:** microservicios, Redis, GraphQL, LangChain, LlamaIndex, vector DB separada y NestJS.

---

## 5. Decisiones aprobadas

| # | Decisión | Detalle |
|---|---|---|
| D1 | Stack y estructura | Ver ADR-001 |
| D2 | Autenticación | Ver ADR-002 |
| D3 | Roles y autorización | Ver ADR-003 |
| D4 | Idioma | Código, BD y API en inglés; UI y rutas visibles en español |
| D5 | Base de datos incremental | `DATABASE_SPEC.md` por rebanadas; el Sprint 1 solo define `User`, `Session`, tokens de verificación/reset y `AuditLog` |

**División del Sprint 1**

- **Sprint 1A:** monorepo, tooling, Docker, PostgreSQL, Prisma, CI/CD, estructura inicial y documentación.
- **Sprint 1B:** autenticación, sesiones, usuarios, RBAC, auditoría, frontend inicial y tests.

No se avanza de 1A a 1B ni a fases posteriores sin aprobación explícita.

**Fuera de alcance por ahora:** Cases, Documents, OCR, Pricing, Payments, Legal AI, RAG, workflow profesional y workflow administrativo completo.

---

## 6. Roadmap técnico

El roadmap de la spec (s.34) sigue vigente hasta que se confirme un cambio. Se **propone** (sin decidir) el siguiente reorden, que corrige los hallazgos 1, 2 y 5:

| Fase | Contenido | Criterio de salida |
|---|---|---|
| 0. Diseño | ADRs, rebanada de identidad de `DATABASE_SPEC`, `SECURITY_SPEC` base | Documentos aprobados |
| 1. Foundation | 1A: base técnica. 1B: auth, sesiones, RBAC, auditoría, frontend inicial | Registro, login y dashboard vacío funcionan con CI verde |
| 2. Cases | `Case`, máquina de estados, cuestionario dinámico, dashboard del usuario | Un usuario solo ve sus casos (test de IDOR) |
| 3. Documents | Storage, subida segura, antivirus, OCR, extracción y revisión | Documento subido, procesado y corregible |
| 4. Pricing v0 | `PriceRule` configurables, `Quote` inmutable | Misma entrada, mismo precio, oferta versionada |
| 5. Professional mínimo | Casos asignados, revisión, estados, mensajes | Un profesional solo actúa sobre casos asignados |
| 6. Payments | Pasarela, webhook verificado e idempotente | El caso se activa solo por webhook válido |
| 7. Legal AI | Corpus, retriever, legal-engine, diagnóstico con citas | Ninguna afirmación jurídica sin fuente vigente |
| 8. Documentos y notificaciones | Plantillas, borradores con aprobación humana | Ningún documento sale sin aprobación profesional |
| 9. Admin | Dashboard y gestión operativa | Gestión básica funcional |
| 10. Hardening | Revisión de seguridad, pruebas de penetración, backups, MFA verificado | Hallazgos críticos resueltos |
| 11. Piloto | Producción con usuarios controlados | Casos reales de punta a punta |

---

## 7. Decisiones pendientes

### Requieren validación jurídica colombiana (no se toman en este proyecto técnico)

- Quién presta el servicio jurídico (profesionales propios o externos) y su responsabilidad.
- Autorización o mandato para actuar ante las autoridades.
- Términos y condiciones.
- Política de reembolsos.
- Tratamiento jurídico de los casos.
- Alcance profesional del servicio.
- Retención, borrado, consentimiento y transferencia internacional de datos personales.

Hasta que se definan, el sistema no codifica ninguna de estas decisiones y las estructuras de datos que dependan de ellas se difieren.

### Técnicas o de negocio, con su fase de bloqueo

| # | Decisión | Bloquea |
|---|---|---|
| P1 | Confirmar el reorden del roadmap (sección 6) | Fase 4 |
| P2 | Alcance del MVP: tipos de caso, autoridades y ciudades piloto | Fases 2 y 7 |
| P3 | Nube y región | Fase 3 (y despliegue a staging) |
| P4 | Proveedor de OCR, tras prueba con documentos reales anonimizados | Fase 3 |
| P5 | Pasarela de pagos para Colombia | Fase 6 |
| P6 | Proveedores de LLM y embeddings; responsable de curar el corpus | Fase 7 |
