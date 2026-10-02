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
| 9 | Entidades faltantes: `Quote/Offer`, `Outcome`, `TermsAcceptance`, `OcrResult`, `ExtractedEntity`, `AiRun`, `LegalRule`, `Deadline`, `Vehicle`/partes, `GeneratedDocument`, `Task`. | Incorporarlas en `DATABASE_SPEC.md` en la fase que corresponda. | Diferido. `OcrResult`: diseño conceptual aprobado el 2026-10-01, no implementado (§5, OCR-A10). `ExtractedEntity`: fuera de la Fase 3 (OCR-A1) |
| 10 | `LegalSource` con un solo `embedding` y sin fin de vigencia. | `LegalSourceChunk`, más `valid_from` y `valid_to`. | Diferido a Fase 7 |
| 11 | Estados del caso sin matriz de transiciones. | Máquina de estados explícita y con tests. | Matriz documentada en `DATABASE_SPEC.md` y capa de dominio con tests (Fase 2); transiciones habilitadas por fase; V1-V8 pendientes |
| 12 | Tablas `Role`/`Permission` frente a 4 roles fijos. | Roles como enum y matriz en código, con camino de evolución. | **Aprobado (D3)** |
| 13 | Autenticación sin definir; webhook y idempotencia ausentes en la API. | Ver ADR-002 y fases de pagos. | **Aprobado (D2)** |
| 14 | Riesgo de abuso de costos en diagnóstico pre-pago. | Cuotas y rate limits por usuario. | Fase 3: cuota de espacio de documentos implementada (100 MiB por usuario, 10 MiB por archivo); cuotas de OCR e IA pendientes de sus fases (P4, Fase 7) |
| 15 | Datos personales sensibles: retención, borrado, consentimiento, transferencia internacional. | Validar con abogado colombiano. | **Decisión jurídica pendiente** |
| 16 | Modelo operativo del servicio jurídico, autorización ante autoridades, T&C, reembolsos. | Validar con abogado colombiano. | **Decisión jurídica pendiente** |
| 17 | Corpus jurídico sin responsable ni política de licencias. | Definir antes de la Fase 7. | Pendiente |
| 18 | Validación de archivos limitada a tipo y tamaño. | Contenido real, antivirus y limpieza de metadata. | Implementado en la Fase 3 (contenido real, antivirus ClamAV, metadata de JPEG y PNG); metadata de PDF pendiente |
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
- **Notificaciones:** patrón outbox, email primero. *(Sprint 1B, decisión C2: el outbox guarda solo la intención, nunca el token; el despacho es una función reutilizable que en el Sprint 1B invocan los tests y un comando de desarrollo, y en la Fase 3 el worker. La entrega real es una barrera antes de producción.)*
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
│   └── worker/                # creado en la Fase 3 con el job document.scan (pg-boss)
├── packages/
│   ├── contracts/
│   ├── database/
│   ├── storage/               # StorageProvider (S3-compatible), compartido por la API y el worker (Fase 3)
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

**Criterio de salida de la Fase 1** *(aprobado por el responsable del producto el 2026-09-27)*

La Fase 1 se da por cerrada solo cuando se cumple todo lo siguiente:

1. **1A completada:** monorepo, tooling, Docker, PostgreSQL, Prisma y CI en `main`; roles de propietario y de aplicación separados.
2. **1B implementada:** registro, login (límite por IP y retardo progresivo por cuenta), logout, `/me`, listado y revocación de sesiones propias, `logout-all`, verificación de email y su reenvío, recuperación de contraseña, rotación periódica y al iniciar sesión.
3. **Autenticación y sesiones conformes a ADR-002:** sesión opaca guardada como hash, cookies `__Host-`, CSRF, expiración por inactividad y absoluta, revocación y barrera MFA en producción.
4. **RBAC conforme a ADR-003:** policies puras y tests de acceso cruzado; un recurso ajeno responde 404.
5. **Auditoría:** todos los eventos de `SECURITY_SPEC.md` §8; `audit_logs` append-only (permisos y trigger), comprobado en CI; cada evento de un cambio de estado se escribe en la misma transacción que el cambio.
6. **Frontend inicial:** rutas en español, `/panel` protegido y vacío, CSP con nonce.
7. **Tests y CI:** CI verde en `main` en el commit de cierre: formato, lint, typecheck, tests, build, `migrate deploy` con comprobación de deriva, append-only, integración PostgreSQL como rol de aplicación y gitleaks.
8. **Migraciones y esquema coherentes:** sin deriva; `DATABASE_SPEC.md` al día; rol de aplicación con mínimo privilegio, comprobado por test.
9. **Documentación aprobada:** `API_SPEC.md`, `SECURITY_SPEC.md` y `DATABASE_SPEC.md` en su versión de cierre, con los valores P4/P5 aprobados.
10. **Sin hallazgos de seguridad críticos o altos abiertos;** los aceptados quedan listados con su barrera en `SECURITY_SPEC.md` §12 (IP global hasta P3, MFA, entrega real de email).
11. **Aprobación explícita del responsable del proyecto,** registrada con fecha y commit de cierre.

*Criterio cumplido el 2026-09-27: commit de cierre `ef7920c` en `main`, CI verde (run 36360859619), aprobado por el responsable del proyecto.*

**Cierre de la Fase 2 (Cases)** *(aprobado por el responsable del producto el 2026-09-27)*

- Implementado: creación de casos (los 7 tipos de `PROJECT_SPEC.md` s.9, siempre en `DRAFT`, con historial y auditoría en la misma transacción), listado y consulta de los casos propios, aislamiento por propietario (404 para casos ajenos, inexistentes o con identificador inválido), y la máquina de estados documentada y preparada (`DATABASE_SPEC.md`), sin ninguna transición habilitada.
- Criterio de §6 cumplido: un usuario solo ve sus casos (tests de IDOR).
- **El cuestionario dinámico no se implementa:** `PROJECT_SPEC.md` s.9 paso 3 solo enuncia que existe, y ningún documento define sus preguntas. No se inventa contenido jurídico (s.31); se implementará cuando exista contenido aprobado.
- Siguen pendientes V1-V8 (estados del caso, §7) y P2.

**Fase 3: diseño del OCR** *(decisiones aprobadas por el responsable del producto el 2026-10-01; diseño, no implementación)*

Rebanada documental: ninguna de estas decisiones autoriza migraciones, permisos ni código. El detalle está en `DATABASE_SPEC.md` («OCR del documento»), `API_SPEC.md` («OCR del documento (previsto)») y `SECURITY_SPEC.md`. La evaluación de proveedores está en `docs/ocr-provider-evaluation.md` (documento de trabajo, no normativo).

| ID | Decisión |
|---|---|
| OCR-A1 | La Fase 3 comprende el OCR y la generación y almacenamiento del texto extraído. La extracción de entidades (determinista o semántica), la IA y el RAG quedan fuera; la extracción se abordará cuando exista una lista aprobada de entidades y formatos. |
| OCR-A3 | El texto OCR es «no verificado». En la Fase 3 el propietario puede consultarlo con un aviso de que puede contener errores, y ningún componente lo usa como dato estructurado ni para decidir. Sin mecanismo de revisión ni corrección en la Fase 3: se diseñará con la extracción. |
| OCR-A4 | Aplazada: quién revisa se decidirá con la revisión y la extracción. |
| Lectura | Consecuencia de OCR-A3 y `SECURITY_SPEC.md` §3: solo el `USER` propietario lee el texto; cualquier otro actor recibe 404. |
| OCR-A6 | Solo un documento `CLEAN` entra al OCR. Un `SCAN_FAILED` reprocesado que llega a `CLEAN` entra por el camino normal. Sin backfill de documentos anteriores. |
| OCR-A7 | El PDF depende de P7 solo si su procesamiento lo envía a un tercero. Con OCR propio no queda bloqueado por P7, pero debe superar la prueba B4. Los PDF excluidos no reciben backfill automático. |
| OCR-A9 | Lo normativo va en las SPEC existentes; las decisiones, en este informe; el protocolo y la evidencia de la evaluación de proveedores, en `docs/ocr-provider-evaluation.md`. Esto es una diferencia explícita y aprobada respecto de no guardar evidencia de ejecución en `docs/`: esa evidencia es el insumo que exige P4. `AI_SPEC.md` sigue reservado para la fase de IA. |
| OCR-A10 | El estado vive en `documents.ocr_status`, con 5 estados base más `NOT_APPLICABLE` (definitivo) y `EXCLUDED` (reversible). Hay un `OcrResult` por ejecución, con metadatos técnicos, y el texto de ejecuciones anteriores se conserva provisionalmente hasta que exista una política de retención. El texto va por página, sin coordenadas, con solo normalización técnica, y sin campo de verificación. **OCR-A10.5 (ubicación del texto y cuota): abierto hasta la medición B8.** |
| OCR-A11 | Operación con el patrón del escaneo: estados escritos junto al resultado del antivirus, activación explícita, PDF desactivado por defecto con salvaguarda de arranque, errores transitorios frente a permanentes, reprocesamiento ADMIN de `FAILED`, sin auditar las exclusiones y logs sin el error crudo del proveedor. El riesgo de pagar dos veces con un OCR externo asíncrono solo se acepta provisionalmente, hasta comprobar en P4 si el proveedor ofrece idempotencia. |
| OCR-A12 | `document:read_ocr` (`USER` propietario) y `document:reprocess_ocr` (`ADMIN`), con 404 para el resto. La lectura responde 200 con `pages` vacío si no hay texto. La ejecución vigente es la última `COMPLETED` y solo se entrega con `ocr_status = COMPLETED`. El worker solo inserta en `ocr_results` (sin SELECT ni `RETURNING`); la API solo lee; nadie actualiza ni borra resultados. El enum va en una migración separada. La activación se hace con un script del propietario, con una matriz por estado y el invariante «con el OCR activo, ningún `CLEAN` en `NOT_STARTED`». |
| OCR-A13 | El texto OCR es contenido no confiable desde la Fase 3. |
| OCR-A14 | La auditoría del OCR no lleva contenido (ni texto, ni fragmentos, ni valores, ni hash del texto). La lectura no se audita. El proveedor queda en `OcrResult`. |
| OCR-A15 | Criterio de salida de la Fase 3: **borrador aprobado** (ver abajo), pendiente de las decisiones bloqueadas. |

**Contradicciones documentales tratadas en esta rebanada:**
- **C1** (extracción en la Fase 3 según s.17, o como IA según s.18 y s.19): resuelta por OCR-A1, a favor de s.18 y s.19.
- **C2** (la Fase 3 según s.34 frente a la propuesta de §6): resuelta por OCR-A1. La Fase 3 incluye OCR, sin extracción ni revisión.
- **C3** (s.17 «deberá poder ser revisada» frente a §2 «por revisar hasta confirmación»): §2 se cumple, porque nada consume el texto. La capacidad de revisión de s.17 queda **aplazada** por decisión expresa de alcance temporal (OCR-A3), sin reinterpretar s.17.
- **C4** (`SECURITY_SPEC.md` dice que ningún documento sale a un servicio externo, frente a un posible OCR externo): un OCR externo solo será admisible con aprobación expresa y validación jurídica (OCR-C1, bloqueada).
- **C5** (el contenido como dato no confiable en la fase de IA, frente a un texto que ya existe en la Fase 3): resuelta por OCR-A13.
- **C7** (documentos de s.32 que no existen): resuelta por OCR-A9 en lo que toca al OCR.
- **Sigue abierta:** la numeración de fases de §7 y de `SECURITY_SPEC.md` §11 frente a s.34. No se corrige sin decisión.

**Criterio de salida de la Fase 3 (borrador aprobado el 2026-10-01; no cumplido).** La Fase 3 se cerrará técnicamente cuando se cumpla todo lo siguiente:
1. **Carga y almacenamiento** (cumplido): subida segura, storage privado, límite, cuota, timeouts, compensación y registro de huérfanos.
2. **Tratamiento de seguridad** (cumplido): antivirus, descarga solo en `CLEAN`, metadata de JPEG y PNG, recuperación y reprocesamiento ADMIN.
3. **P4 decidido** y registrado en este informe tras la evaluación documentada en `docs/ocr-provider-evaluation.md`.
4. **Admisibilidad:**
   - si el OCR es externo, aprobación expresa (OCR-C1) y validación jurídica (P3 y la transmisión o transferencia internacional) antes de tratar documentos reales;
   - si es propio, ningún documento sale de nuestra infraestructura.
5. **Entrada:** solo documentos `CLEAN`; sin backfill (OCR-A6).
6. **Resultado:** los documentos `CLEAN` incluidos en el alcance aprobado generan texto OCR según el proveedor y la representación elegidos en P4. JPEG y PNG forman parte del alcance inicial, sujetos a la validación del proveedor; el PDF, según OCR-A7 y B4/P7. Al cierre debe constar qué caso de PDF se aplica.
7. **Texto** no verificado y no confiable, consultado solo por el propietario con aviso; 404 para el resto, con tests de IDOR (OCR-A3, OCR-A12, OCR-A13).
8. **Auditoría** sin contenido (OCR-A14).
9. **Modelo** (OCR-A10, incluido A10.5), **operación** (OCR-A11) y **permisos** (OCR-A12) aprobados. Cada cambio de PostgreSQL va con su migración, su test de privilegios y autorización explícita.
10. **Documentación** actualizada en el mismo cambio que el código (OCR-A9).
11. **Tests** unitarios y de integración con servicios reales, red-team, y CI verde en `main` en el commit de cierre.
12. **Aprobación explícita** del responsable del proyecto, con fecha y commit de cierre.

**P3 no es requisito del cierre técnico.** Sí lo es para tratar documentos reales en producción, junto con OCR-C1, C2 y C3 cuando correspondan.

**Fuera de la Fase 3:** extracción de entidades, revisión y corrección, IA y RAG, backfill, y la política definitiva de retención y eliminación.

**Pendientes que condicionan el cierre:**
- **Pregunta 8b: resuelta el 2026-10-01 (opción A).**
  - Se admiten documentos sintéticos en la primera ronda de la evaluación, con estas condiciones: sin datos personales reales, sin logos ni membretes de autoridades reales, plantillas genéricas y generación reproducible.
  - Con ellos son concluyentes B8 (si la densidad de texto es representativa; decide OCR-A10.5), B5, B7, B4, B3 y la idempotencia del proveedor. La calidad (B2) es provisional y nunca justifica P4 por sí sola.
  - **No autoriza** usar un proveedor externo, crear cuentas ni subir documentos.
  - **No basta para decidir P4:** P4 exige, según §7, una prueba con documentos reales anonimizados.
  - La implementación puede empezar antes de P4 detrás de `OcrProvider`, pero la Fase 3 no se declara cerrada sin P4.
- **Pregunta 8a** (quién hace la validación jurídica de P3 y del OCR externo, y del uso de documentos reales anonimizados en la evaluación): bloqueada. P4, y con él el cierre de la Fase 3, depende también de ella.
- **Pregunta 7** (lista aprobada de entidades y formatos): bloqueada, pero no condiciona la Fase 3 tras OCR-A1.

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
- Autorización o mandato para actuar ante las autoridades (bloquea además la transición `READY_TO_FILE` → `FILED`, V8).
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
| P3 | Nube y región: proveedor, región y ubicación de almacenamiento, PostgreSQL, worker y ClamAV; residencia y, si hay transferencia internacional, su validación jurídica (tabla anterior) | Despliegue de la Fase 3 con documentos reales (staging y producción), bucket de producción y, en la práctica, la elección de OCR (P4). No bloquea el desarrollo local detrás de `StorageProvider` |
| P4 | Proveedor de OCR, tras prueba con documentos reales anonimizados. Protocolo y evidencia en `docs/ocr-provider-evaluation.md`; la decisión final se registrará en este informe (2026-10-01) | Fase 3 |
| P5 | Pasarela de pagos para Colombia | Fase 6 |
| P6 | Proveedores de LLM y embeddings; responsable de curar el corpus | Fase 7 |
| P7 | Limpieza de metadata de PDF (hoy el PDF se entrega intacto solo a su propietario); está por determinar si requiere validación jurídica | Descarga de documentos PDF por otros roles y producción |
| V1 | Posición y significado de `FOLLOW_UP` (`DATABASE_SPEC.md`, estados del caso) | Fase de profesionales |
| V2 | Diferencia entre `RESOLVED` y `CLOSED`, y salidas de `RESPONSE_RECEIVED` | Fase de profesionales |
| V4 | Posición de `LEGAL_REVIEW` respecto al pricing y la asignación profesional | Fases de pricing y de profesionales |
| V5 | Retrocesos de estado, por ejemplo por información faltante | Fase de documentos |
| V6 | Salida del caso cuando no procede actuar o el usuario no acepta la oferta | Fase de pricing |
| V7 | Cancelación: quién cancela y desde qué estados (tras el pago, reembolsos: validación jurídica) | Fase en que se habilite |
