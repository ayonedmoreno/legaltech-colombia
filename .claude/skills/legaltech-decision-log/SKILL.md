---
name: legaltech-decision-log
description: Registro de las decisiones importantes de LegalTech Colombia (fecha, problema, decisión, motivo, alcance, qué NO se decidió y referencia). Úsalo para saber si algo ya está decidido antes de proponer o implementar un cambio, y para detectar conflictos entre una nueva necesidad y una decisión anterior.
---

# Registro de decisiones

**Reglas de uso**

- Una decisión histórica **no se modifica** porque una implementación posterior parezca más conveniente.
- Si una nueva necesidad choca con una decisión registrada: **detenerse, reportar el conflicto** (decisión, fuente, por qué choca) y esperar una decisión nueva. La nueva decisión se **añade** al final con su fecha y la entrada anterior queda tal cual, marcada como «sustituida por …».
- «Qué NO se decidió» es tan vinculante como la decisión: lo no decidido no se implementa por inferencia.
- Las fuentes formales mandan sobre este registro (`legaltech-project-rules`, precedencia). Cuando hay commit o documento, se cita.
- Decisor: «el usuario» es el responsable del producto, que decide en el chat.
- Este registro **no es una autoridad superior** a una decisión explícita del usuario. Si una decisión posterior choca con una entrada, prevalece la posterior, y este registro se actualiza (añadiendo una entrada) tras la revisión del usuario.
- Solo recoge decisiones respaldadas por la documentación o por una instrucción explícita. **No crea reglas.** Lo marcado como pendiente o no decidido no es un requisito.

---

### DEC-01 · 2026-09-24 · Stack y monorepo (D1)

- **Problema:** cómo organizar los motores, el trabajo asíncrono y qué excluir del MVP.
- **Decisión:**
  - monorepo con pnpm y Turborepo; Next.js, Fastify, PostgreSQL y Prisma;
  - monolito modular más un worker; pg-boss detrás de `JobQueue`; almacenamiento S3 privado detrás de `StorageProvider`;
  - `legal-engine` y `pricing-engine` como paquetes puros.
- **Motivo:** menos infraestructura y motores testeables sin framework.
- **Alcance:** todo el MVP.
- **No decidido:** nada fuera del ADR. Están excluidos microservicios, Redis, GraphQL, LangChain, LlamaIndex, vector DB separada y NestJS, salvo un ADR posterior.
- **Ref.:** `docs/adr/ADR-001`.

### DEC-02 · 2026-09-24 · Autenticación (D2)

- **Problema:** la spec no define el mecanismo de sesión.
- **Decisión:**
  - sesiones opacas en PostgreSQL y cookie httpOnly; Argon2id;
  - revocación, expiración y rotación; CSRF; verificación de email; recuperación; rate limiting;
  - MFA obligatorio para ADMIN y SUPER_ADMIN antes de producción.
- **Motivo:** revocación inmediata y control total.
- **Alternativas rechazadas:** JWT sin estado; proveedor externo de identidad (ADR-002: «puede reconsiderarse con un ADR»); rate limiting en Redis.
- **Ref.:** `ADR-002`.

### DEC-03 · 2026-09-24 · Roles y autorización (D3)

- **Decisión:**
  - 4 roles como enum; la matriz en código, con policies puras;
  - rol y propiedad comprobados siempre; un recurso ajeno responde 404;
  - sin tablas Role ni Permission.
- **No decidido:** permisos dinámicos (requerirían un ADR y una migración).
- **Ref.:** `ADR-003`.

### DEC-04 · 2026-09-24 · Idioma (D4) y base de datos incremental (D5)

- **Decisión:**
  - código, base de datos y API en inglés; interfaz y rutas en español;
  - `DATABASE_SPEC.md` crece por rebanadas.
- **Ref.:** `ARCHITECTURE_REPORT.md` §5.

### DEC-05 · 2026-09-26 · `NODE_ENV` obligatorio (D1 del Sprint 1B)

- **Problema:** la barrera MFA de producción podía desactivarse si faltaba `NODE_ENV`.
- **Decisión:** `NODE_ENV` es obligatorio, sin valor por defecto; si falta o no es válido, la API no arranca.
- **No decidido:** el tratamiento de las sesiones ya existentes, p. ej. las creadas con una configuración incorrecta. ADR-002 lo deja «pendiente como decisión separada»; ver G2/D1b al final, **DECISIÓN HISTÓRICA / ESTADO NO VERIFICADO**.
- **Ref.:** `cf0191b`; ADR-002.

### DEC-06 · 2026-09-26 · IP del cliente detrás de proxies (D2-A, D2-G)

- **Decisión:**
  - se mantiene el límite por IP en memoria, que detrás del proxy web es global; no se publica hasta tener un borde de confianza;
  - se rechazan `/0` y `::ffff:0:0/96` en `API_TRUST_PROXY`.
- **Motivo:** falla cerrado; no se puede eludir.
- **No decidido:** el borde de confianza (D2-B), que depende de P3.
- **Ref.:** `daebd81`; `SECURITY_SPEC.md` §7.

### DEC-07 · 2026-09-26 · Límite de login por cuenta (D3)

- **Decisión:**
  - retardo de min(30·2^(F−5), 900) s con 5 o más fallos en 24 h, con la clave SHA-256 del email;
  - transacción con `pg_advisory_xact_lock` y `lock_timeout` de 2 s; la hora la da PostgreSQL;
  - `Retry-After` exacto; `auth.login.rate_limited` en la misma transacción; 503 si no se obtiene el bloqueo.
- **Ref.:** `fbfddb7`, `590b1d6`, `c73d278`, `c255242`; ADR-002.

### DEC-08 · 2026-09-27 · Sprint 1B: outbox, rotación, transacciones de revocación y mínimo privilegio

- **Decisión:**
  - **outbox (C2):** guarda solo la intención, nunca el token; en el Sprint 1B solo se despacha con un comando de desarrollo;
  - **rotación (P9–P12):** cada 1 h para USER y cada 15 min para los roles internos, con 60 s de gracia y sin auditarse;
  - **H1:** cada revocación y su evento de auditoría en una misma transacción;
  - **mínimo privilegio:** el rol de aplicación tiene solo los permisos que usa;
  - se aprobaron unos «valores P4/P5» del Sprint 1B (criterio 9 del cierre de la Fase 1). **CONTRADICCIÓN DOCUMENTAL CONOCIDA — NO RESOLVER AUTOMÁTICAMENTE:** no son las P4/P5 de `ARCHITECTURE_REPORT.md` §7 (OCR y pagos), y su contenido exacto no está recogido en este registro; verificarlo en las SPEC antes de citarlo.
- **No decidido:** entrega real de email. Ver también AUD-02 al final (**DECISIÓN HISTÓRICA / ESTADO NO VERIFICADO**).
- **Ref.:** `40eaea1`, `0a6d324`, `18702e9`, `20997c4`, `ef7920c`.

### DEC-09 · 2026-09-27 · Cierre de la Fase 1

- **Decisión:** se aprueba el criterio de salida de 11 puntos y se cierra la Fase 1.
- **Ref.:** `ef7920c`; CI run 36360859619; `ARCHITECTURE_REPORT.md` §5.

### DEC-10 · 2026-09-27 · Primera rebanada de Case

- **Decisión:**
  - **A:** sin cancelación ni transiciones; solo `DRAFT`;
  - **B:** 7 tipos de caso;
  - **C:** sin 409;
  - **D:** «cerrados» son `RESOLVED`, `CLOSED` y `CANCELLED`;
  - **E:** no se exige email verificado;
  - sin límite de casos por usuario; etiquetas de estado en español.
- **No decidido:** P2 (alcance del MVP: tipos de caso, autoridades, ciudades).
- **Ref.:** `7656168`…`b60ad0c`.

### DEC-11 · 2026-09-27 · Máquina de estados del caso (rebanada A)

- **Decisión:**
  - T1–T10 documentadas y **todas deshabilitadas**; T4 (`PAID`) solo por un webhook verificado, en la fase de pagos;
  - el alcance es solo `case-status.ts` puro y sus tests: sin endpoints, sin UPDATE, sin `case.status_changed`, sin migraciones.
- **No decidido:** V1, V2 y V4–V8 (y V3, la columna de actor del sistema). **Nunca se resuelven por inferencia.**
- **Ref.:** `105e340`, `02592e9`; `DATABASE_SPEC.md` «Estados y transiciones del caso».

### DEC-12 · 2026-09-27 · Cierre de la Fase 2 sin cuestionario

- **Problema:** `PROJECT_SPEC.md` s.9 paso 3 enuncia un cuestionario dinámico, pero ningún documento define sus preguntas.
- **Decisión:** no se implementa; no se inventa contenido jurídico (s.31). Fase 2 cerrada con alcance reducido.
- **No decidido:** el contenido del cuestionario.
- **Ref.:** `f0853c4`; `ARCHITECTURE_REPORT.md` §5.

### DEC-13 · 2026-09-27 · Fase 3, rebanada 1 (subida y descarga)

- **Decisión:**
  - subida con el cuerpo crudo (`application/octet-stream` más `X-File-Name`) y tipo por magic bytes (PDF, JPEG, PNG);
  - solo en `DRAFT`; primero el almacenamiento y después la transacción;
  - URL prefirmada de 60 s con `attachment`; código `PAYLOAD_TOO_LARGE`; SeaweedFS para desarrollo y CI.
- **Autorización de método:** el usuario autoriza que yo tome decisiones técnicas reversibles, las documente y continúe. Hay que detenerse por arquitectura, alcance, seguridad crítica, negocio o cuestiones jurídicas.
- **Ref.:** `e9b847f`…`66e23f3` (subidos a origin).

### DEC-14 · 2026-09-28 · Fase 3, rebanada 2 (tratamiento de seguridad)

- **Decisión:**
  - ClamAV en infraestructura propia, en el worker, con pg-boss;
  - solo `CLEAN` se descarga;
  - política de metadata exacta para JPEG y PNG, sin recodificar; el original queda intacto;
  - rol `legaltech_worker`; los procesos de ejecución no hacen DDL.
- **No decidido:**
  - P7 (metadata de PDF, que se entrega intacto solo a su propietario);
  - ClamAV de producción;
  - ampliar la política de metadata.
- **Ref.:** `2d96706`…`f6bd73b`.

### DEC-15 · 2026-09-28 · Rebanada 3.2b (recuperación y mínimo privilegio del worker)

- **Decisión:**
  - `UPLOADED` pasa a ser un estado heredado;
  - barrido cada 60 s con un plazo de reclamo de 600 s; con 5 o más intentos, `SCAN_FAILED`;
  - sin el planificador de pg-boss;
  - se retiran los permisos que el worker no usa. Si algún permiso resultara necesario, no se fuerza el REVOKE.
- **Ref.:** `91b4b28`, `4c2dee4`, `c7d6cbb`.

### DEC-16 · 2026-10-01 · Cierre de la rebanada de documentos (timeouts, límite, cuota, reproceso)

- **Decisión:**
  - **almacenamiento:**
    - timeouts de 5 s para conectar, 30 s de inactividad y 45 s por petición; se mantienen los reintentos del SDK;
    - no se detecta el abandono del cliente;
    - 503 con compensación;
    - un PutObject que se guardó sin respuesta no puede quedar huérfano en silencio: si el borrado falla, se registra `storage.orphan_object`;
  - **límite:** 10 MiB único, sin configuración por encima; se corrige el 500 que daba el proxy;
  - **cuota:** 100 MiB por usuario, segura ante la concurrencia, contando todo documento almacenado (`INFECTED` y `SCAN_FAILED` incluidos); sin cuotas por IP, día ni mes;
  - **`SCAN_FAILED`:**
    - reprocesamiento interno `SCAN_FAILED → PENDING_SCAN`, **solo ADMIN** (no SUPER_ADMIN, no USER), con una justificación auditada;
    - reinicia los intentos a 0 y el historial queda en la auditoría;
    - no hay reintentos ilimitados ni automáticos; `INFECTED` es terminal;
  - no se cambia el RBAC general ni los permisos de PostgreSQL.
- **No decidido:**
  - el recolector o la reconciliación de huérfanos;
  - **la política de liberación de la cuota**: depende de la futura eliminación y retención; los 100 MiB no son una cuota acumulativa permanente decidida por producto;
  - OCR (P4), P3 y P7.
- **Ref.:** `c9e8139`; `API_SPEC` 0.8, `DATABASE_SPEC` 0.7, `SECURITY_SPEC` 0.7.

### DEC-17 · 2026-10-01 · Correcciones de la auditoría general del 2026-09-28

- **Decisión:** van en un commit aparte de la rebanada:
  - test G04 (caducidad absoluta de la sesión);
  - comentarios obsoletos en `auth.policy.ts` y `auth.repository.ts`.

  Otros dos comentarios obsoletos, mezclados en los mismos bloques del diff que la rebanada, quedan en el commit de la rebanada y se mencionan en su mensaje.

- **Ref.:** `75cff33`; mensaje de `c9e8139`.

### DEC-18 · 2026-10-01 · Evidencia de validación fuera de Git

- **Decisión:** no se añade a `docs/` un documento con los resultados del CI y del red-team para el cierre funcional. La evidencia de ejecución es distinta del código y las pruebas.
- **No decidido:** una tarea específica de documentación que conserve la evidencia formalmente, si se pide más adelante.

### DEC-19 · 2026-10-01 · Push

- **Decisión:** el push **no está autorizado**. Cada push requiere una autorización explícita.
- **Sustituida por DEC-21.**

### DEC-20 · 2026-10-01 · Diseño del OCR (rebanada documental de la Fase 3)

- **Problema:** la Fase 3 (`PROJECT_SPEC.md` s.34) incluye el OCR, que depende de P4 y tiene huecos y contradicciones documentales.
- **Decisión:** el diseño aprobado, decisión por decisión, está en `ARCHITECTURE_REPORT.md` §5 («Fase 3: diseño del OCR»; OCR-A1 a OCR-A15), con el detalle en `DATABASE_SPEC.md` 0.8, `API_SPEC.md` 0.9 y `SECURITY_SPEC.md` 0.8. Resumen:
  - la Fase 3 = OCR y texto; extracción, IA y RAG fuera (A1);
  - texto no verificado y no confiable, que solo lee el propietario, con 404 para el resto (A3, A13);
  - solo entran documentos `CLEAN`, sin backfill (A6);
  - el PDF depende de P7 solo si va a un tercero (A7);
  - el modelo (A10), la operación (A11) y el RBAC y los permisos (A12), con el worker limitado a INSERT y una activación con invariante;
  - auditoría sin contenido (A14);
  - criterio de salida en borrador (A15), en el que P3 no es requisito del cierre técnico.
- **Motivo:** cerrar las decisiones antes de tocar código, sin inventar el proveedor ni el contenido jurídico.
- **Alcance:** diseño y documentación. **No autoriza** migraciones, permisos ni código.
- **No decidido:**
  - OCR-A10.5 (ubicación del texto; depende de B8);
  - P3, P4 y P7, y B1–B8;
  - la pregunta 8b (documentos sintéticos), abierta (resuelta después en DEC-22);
  - las preguntas 8a (validación jurídica) y 7 (lista de entidades), bloqueadas;
  - quién revisa (A4, aplazada).
- **Ref.:** `ARCHITECTURE_REPORT.md` §5; `docs/ocr-provider-evaluation.md` (no normativo).

### DEC-21 · 2026-10-01 · Push de los 14 commits

- **Decisión:** el usuario autorizó explícitamente el push de `main` (`66e23f3..7f64f79`), tras una auditoría de los 14 commits. Sustituye a DEC-19 para ese push. Cada push futuro sigue requiriendo su propia autorización explícita.
- **Ref.:** CI de GitHub, run 36941991867, en verde sobre `7f64f79`.

### DEC-22 · 2026-10-01 · Documentos sintéticos en la primera ronda de la evaluación del OCR (pregunta 8b)

- **Problema:** la evaluación de proveedores (B8, P4) necesita documentos de prueba, y los reales anonimizados dependen de una validación jurídica bloqueada (8a).
- **Decisión:** opción A. Se admiten documentos sintéticos en la primera ronda: sin datos personales reales, sin logos ni membretes de autoridades reales, con plantillas genéricas y generación reproducible.
- **Alcance:**
  - concluyentes para B8 (con densidad de texto representativa), B5, B7, B4, B3 y la idempotencia del proveedor;
  - la calidad (B2) es provisional y nunca justifica P4 por sí sola;
  - la implementación puede empezar antes de P4 detrás de `OcrProvider`, pero la Fase 3 no se cierra sin P4.
- **No decidido:**
  - el uso de un proveedor externo, la creación de cuentas y la subida de documentos, que no quedan autorizados;
  - dónde vive el generador;
  - la ronda con documentos reales anonimizados (8a, bloqueada), y P4.
- **Ref.:** `ARCHITECTURE_REPORT.md` §5; `docs/ocr-provider-evaluation.md`.

---

## Decisiones pendientes conocidas (no tomar por inferencia)

Son decisiones **pendientes**: no son requisitos ni alcance de ninguna rebanada, y este registro no propone contenido para ellas.

- **De `ARCHITECTURE_REPORT.md` §7:**
  - P1: reorden del roadmap;
  - P2: alcance del MVP;
  - P3: nube y región;
  - P4: OCR;
  - P5: pasarela de pagos;
  - P6: proveedores de LLM y embeddings, y responsable del corpus;
  - P7: metadata de PDF;
  - V1–V8: estados del caso.
- **Jurídicas:**
  - quién presta el servicio y su responsabilidad; mandato para radicar;
  - términos y condiciones; reembolsos;
  - retención, borrado, consentimiento y transferencia internacional de datos personales.
- **Técnicas:**
  - MFA; entrega real de email;
  - reconciliación de huérfanos y liberación de la cuota;

## DECISIÓN HISTÓRICA / ESTADO NO VERIFICADO

Estos puntos provienen de revisiones de sesiones anteriores. **No están en `docs/`**, y no se ha comprobado si siguen abiertos, se resolvieron o se descartaron.

- **No son decisiones activas ni requisitos.** No se implementan ni se citan como vigentes hasta verificarlos contra el código y obtener una decisión del usuario.
- **AUD-02** — **DECISIÓN HISTÓRICA / ESTADO NO VERIFICADO.** Se observó que `auth.register` y `auth.login.success` se auditaban fuera de la transacción de su cambio. Quedó como residuo sin decisión (Sprint 1B, 2026-09-27).
- **G2/D1b** — **DECISIÓN HISTÓRICA / ESTADO NO VERIFICADO.** Tratamiento de las sesiones creadas con una configuración incorrecta. ADR-002 (nota D1) solo dice que es una decisión separada pendiente.
- **D14** — **DECISIÓN HISTÓRICA / ESTADO NO VERIFICADO.** Se observó (2026-09-26) que los errores de validación de `loadEnv` mostraban el valor recibido de `NODE_ENV` y `LOG_LEVEL`. No consta si se corrigió.
