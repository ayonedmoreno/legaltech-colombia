---
name: legaltech-security-and-data-rules
description: Decisiones vigentes de seguridad y datos de LegalTech Colombia (autenticación, sesiones, CSRF, IDOR, RBAC, auditoría, storage privado, límites, antivirus, metadata, estados CLEAN/INFECTED/SCAN_FAILED, reprocesamiento, cuota, objetos huérfanos, permisos PostgreSQL), con qué está implementado y qué sigue pendiente. Úsalo antes de tocar autenticación, autorización, documentos, almacenamiento, auditoría, migraciones o permisos.
---

# Seguridad y datos: decisiones vigentes

Las fuentes de verdad son ADR-002, ADR-003, `SECURITY_SPEC.md` 0.7, `DATABASE_SPEC.md` 0.7 y `API_SPEC.md` 0.8. Si este skill difiere de ellas, mandan ellas, y hay que reportar la diferencia. Ningún valor de esta página se cambia sin decisión explícita (`legaltech-project-rules`).

- **Este skill no crea reglas:** resume las decisiones documentadas.
- **No es autoridad superior** a una decisión explícita del usuario: si una decisión posterior cambia algo de aquí, prevalece ella y el skill se actualiza tras la revisión del usuario.
- **Lo marcado 🔴 es pendiente, no un requisito.** No se describe cómo se resolverá, porque no está decidido.

Leyenda: 🟢 implementado · 🟡 parcial · 🔴 pendiente.

## Autenticación y sesiones (ADR-002) 🟢

- **Sesión:**
  - es opaca: un token de 256 bits del que en la base de datos solo se guarda el hash SHA-256;
  - va en la cookie `__Host-session` (HttpOnly, Secure, SameSite=Lax, sin Domain).
- **Contraseñas:** Argon2id, de 12 a 128 caracteres, sin reglas de composición.
- **Mismo origen:** la web reenvía `/api/*` a la API, así que no se habilita CORS.
- **Expiración:** por inactividad y absoluta.
- **Rotación:**
  - periódica: cada 1 h para USER y cada 15 min para los roles internos, contada desde la creación, mediante `POST /api/auth/session/rotate`, con 60 s de gracia y conservando el techo absoluto;
  - al iniciar sesión, la sesión previa del navegador se revoca con `ROTATED`;
  - las rotaciones no se auditan.
- **Revocación:** logout, sesión propia por ID, `logout-all` y todas al restablecer la contraseña. Cada revocación y su evento de auditoría van en la misma transacción.
- **Verificación y recuperación:** tokens de un solo uso guardados como hash; respuestas genéricas, sin enumeración de cuentas.
- **Rate limiting:**
  - por IP: 5 registros y 10 logins cada 10 min;
  - por cuenta (D3): retardo de min(30·2^(F−5), 900) s a partir de 5 fallos en 24 h, con la clave SHA-256 del email, `pg_advisory_xact_lock`, la hora de PostgreSQL, `Retry-After` exacto y 503 si no se obtiene el bloqueo.
- **`NODE_ENV`:** es obligatorio y sin valor por defecto (D1).
- **Barrera MFA:** en producción, ADMIN y SUPER_ADMIN no pueden iniciar sesión. 🔴 MFA (TOTP) en sí no está implementado.
- **`API_TRUST_PROXY`:** lista explícita, vacía por defecto; se rechazan `/0` y `::ffff:0:0/96` (D2-G). 🟡 Detrás del proxy web el límite por IP es global hasta tener un borde de confianza (D2-A, P3).
- 🔴 **Pendiente:** entrega real de email; MFA; límite compartido entre instancias.
- G2/D1b, el tratamiento de las sesiones ya existentes (ADR-002, nota D1), es **DECISIÓN HISTÓRICA / ESTADO NO VERIFICADO**.

## CSRF 🟢

Toda petición que modifica exige la cookie `__Host-csrf`, la cabecera `X-CSRF-Token` ligada a la sesión (se obtiene con `GET /api/auth/csrf`) y la comprobación de `Origin`. En la subida de documentos, sesión y CSRF se comprueban antes de leer el cuerpo.

## Autorización, RBAC e IDOR (ADR-003) 🟢

- **Modelo:**
  - los roles son un enum: USER, PROFESSIONAL, ADMIN y SUPER_ADMIN;
  - la matriz vive en código, con policies puras `can(actor, action, resource)` y denegación por defecto;
  - no hay tablas Role ni Permission.
- **IDOR:**
  - los repositorios siempre filtran por el actor;
  - un recurso ajeno, inexistente o con identificador malformado responde **404**;
  - hay tests de acceso cruzado obligatorios para cada recurso con dueño.
- **Acciones vigentes:**
  - `user:read`, `session:list` y `session:revoke` sobre uno mismo;
  - `case:create`, `case:list` y `case:read`, solo USER y sobre lo propio;
  - `document:upload`, `document:list` y `document:download`, solo USER y sobre lo propio;
  - `document:reprocess`, **solo ADMIN** (SUPER_ADMIN no; decisión del 2026-10-01).
- **Roles sin acceso todavía:** PROFESSIONAL, ADMIN y SUPER_ADMIN no acceden a casos ni documentos hasta sus fases.
- **Alta de cuentas:** el registro público solo crea USER; las cuentas internas, solo por el script de siembra de desarrollo.
- 🔴 **Pendiente:** asignaciones de PROFESSIONAL; acceso administrativo justificado; cambios de rol con su auditoría y la rotación de sesiones.

## Auditoría 🟢 (registro) / 🔴 (consulta)

- **Garantías:**
  - `audit_logs` es append-only: la API y el propietario no pueden hacer UPDATE ni DELETE (permisos más trigger), y se comprueba en CI;
  - cada evento de un cambio de estado va en la misma transacción que el cambio;
  - nunca se registran contraseñas, tokens, hashes, correos en claro ni nombres de archivo.
- **Eventos:**
  - autenticación: `auth.*`;
  - casos: `case.created`;
  - documentos: `document.uploaded`, `document.scan_clean`, `document.scan_infected` (con la firma), `document.scan_failed`, `document.reprocess_requested` (con el ADMIN como actor y su justificación) y `document.scan_reprocessed` (con los intentos anteriores);
  - desarrollo: `user.seeded`.
- **AUD-02** — **DECISIÓN HISTÓRICA / ESTADO NO VERIFICADO:** en el Sprint 1B se observó que `auth.register` y `auth.login.success` se escribían fuera de la transacción de su cambio. No está en `docs/` ni se ha verificado su estado actual. No es una regla activa (ver `legaltech-decision-log`).
- 🔴 **Pendiente:** pantalla de consulta y política de retención (jurídica).

## Documentos

**Almacenamiento** 🟢

- **Bucket:** privado, detrás de `StorageProvider`. La clave es `cases/{caseId}/documents/{id}`, sin el nombre del archivo.
- **Descarga:** URL prefirmada de 60 s con `attachment`, emitida solo tras autorizar.
- **Timeouts:** 5 s para conectar, 30 s de inactividad y 45 s por petición, con `throwOnRequestTimeout`. Se mantienen los reintentos estándar del SDK (3 intentos).
- 🟡 SeaweedFS solo en desarrollo y CI. 🔴 El almacenamiento de producción depende de P3.

**Subida** 🟢

- **Tipo:** se decide por el contenido (magic bytes), nunca por la extensión; solo PDF, JPEG y PNG.
- **Nombre:** de 1 a 255 caracteres, sin rutas ni caracteres de control.
- **Caso:** solo casos `DRAFT` propios.
- **Límite único: 10 MiB** (`DOCUMENT_MAX_BYTES` en `contracts`):
  - no es configurable y el servicio rechaza un límite mayor;
  - el búfer del proxy web es de 11 MiB;
  - el middleware web responde 413 por `Content-Length`, y la API vuelve a comprobarlo.
- **Orden de escritura:** primero el almacenamiento; después la fila, `document.uploaded` y el job `document.scan` en una sola transacción. El documento nace en `PENDING_SCAN`.
- **Compensación:**
  - un fallo del almacenamiento responde **503** y borra el objeto, que pudo llegar a escribirse;
  - un fallo de la base de datos también borra el objeto.

**Cuota: 100 MiB por usuario** (`DOCUMENT_QUOTA_BYTES`) 🟢

- **Cómputo:** suma de `file_size` de todos los documentos de los casos del usuario.
- **Comprobaciones:** una previa y la definitiva bajo `pg_advisory_xact_lock` (espacio de nombres "DOCQ" y clave por usuario), así que las subidas concurrentes no la superan. Si se supera: 403 `FORBIDDEN`.
- **Qué cuenta:** todo documento almacenado, también `INFECTED` y `SCAN_FAILED`.
- 🔴 **Liberación de la cuota: no decidida.** Depende de la futura eliminación y retención de documentos. Los 100 MiB **no** son todavía una cuota acumulativa permanente decidida por producto.
- **No hay cuotas** por IP, día ni mes (decisión del 2026-10-01).

**Antivirus y tratamiento** (worker) 🟢

- **Dónde:** ClamAV dentro de la infraestructura propia (ningún documento sale a un servicio externo), fuera de la petición HTTP.
- **Resultado:** solo la respuesta exacta `stream: OK` produce `CLEAN`; un error o un timeout (60 s) nunca.
- **Reintentos:** 5 intentos (`scan_attempts`).
- **Barrido:** cada 60 s, con `FOR UPDATE SKIP LOCKED` y un plazo de reclamo de 600 s; un reclamo abandonado con 5 o más intentos pasa a `SCAN_FAILED`.
- **Medición con ClamAV caído** (prueba del 2026-10-01; un dato observado, no un requisito): 742 s hasta `SCAN_FAILED`.
- 🔴 **ClamAV de producción** (despliegue, firmas, actualización, monitorización, `AlertExceedsMax` y `AlertEncrypted`): sin decidir.

**Metadata** 🟢 JPEG/PNG · 🔴 PDF

- **JPEG:** se quitan EXIF/GPS, XMP, IPTC y COM, también entre barridos.
- **PNG:** se quitan `eXIf`, `tEXt`, `zTXt` e `iTXt`.
- **Cómo:** sin recodificar, y descartando lo que haya tras `EOI` o `IEND`.
- **Qué se conserva:** APP0/JFIF, APP2/ICC, `APPn` de fabricantes, `tIME`, `iCCP`. Ampliar la política no está decidido.
- **Original:** nunca se modifica; la copia derivada es otro objeto (`sanitized_storage_key`).
- **PDF:** se entrega intacto, solo a su propietario. Su limpieza es la decisión pendiente P7.

**Estados del documento** 🟢

| Estado                                 | Etiqueta en la UI                 | ¿Descargable?                                             |
| -------------------------------------- | --------------------------------- | --------------------------------------------------------- |
| `UPLOADED` (heredado) / `PENDING_SCAN` | Pendiente de análisis             | No                                                        |
| `SCANNING`                             | En análisis                       | No                                                        |
| `CLEAN`                                | Disponible                        | **Sí** (PDF: original; JPEG y PNG: la copia sin metadata) |
| `INFECTED`                             | Bloqueado: se detectó una amenaza | No; terminal, nunca se reprocesa                          |
| `SCAN_FAILED`                          | Bloqueado: no se pudo analizar    | No; solo sale por reprocesamiento ADMIN                   |

**Reprocesamiento** 🟢 API · 🔴 interfaz

- **Endpoint:** `POST /api/admin/documents/:documentId/reprocess` con `{reason}` de 1 a 500 caracteres, solo ADMIN (los demás roles reciben 404) y con CSRF.
- **Respuestas:** 403 si el documento no está en `SCAN_FAILED`; 202 si se acepta.
- **En la API:** `document.reprocess_requested` y el job `document.reprocess` en una sola transacción.
- **En el worker:** bloquea la fila con `FOR UPDATE` y, solo si sigue en `SCAN_FAILED`, pone `PENDING_SCAN` y `scan_attempts = 0`, encola el escaneo y escribe `document.scan_reprocessed`. El historial queda en la auditoría.
- **Nunca automático** y sin reintentos ilimitados. En producción no se puede usar mientras ADMIN no tenga MFA.

**Objetos huérfanos** 🟢 registro · 🔴 reconciliación

- **Cuándo se registran:** si un borrado de compensación falla, incluido un PutObject guardado cuya respuesta se perdió, se escribe en el log `storage.orphan_object` con `storageKey` y `origin`:
  - `upload`, en la API;
  - `scan_failed_copy`, en el worker, cuando no se pudo borrar la copia derivada de un tratamiento fallido.
- **Efecto:** el objeto huérfano nunca se sirve, porque no tiene fila.
- 🔴 **No hay recolector ni reconciliación automática.** No se implementa sin decisión.

**OCR** 🟢 implementado y desactivado · 🔴 proveedor (ver `DATABASE_SPEC.md`, «OCR del documento»)

- **Implementado:**
  - solo entran documentos `CLEAN`, y su estado de OCR se escribe con el resultado del antivirus;
  - reclamo con token, reintentos, barrido, reprocesamiento solo ADMIN (`document:reprocess_ocr`), activación del propietario con invariante;
  - un PDF se vuelve a comprobar en cada job (A7);
  - los logs solo llevan códigos normalizados, nunca el error del proveedor.
- **Texto (OCR-A10.5):**
  - se guarda en PostgreSQL (`ocr_result_pages`), en la misma transacción que su `OcrResult`;
  - la base de datos garantiza las páginas 1..n, sin duplicados, y que no cambia después;
  - no cuenta para la cuota.
- **Lectura:** solo el `USER` propietario (`document:read_ocr`), con 404 para cualquier otro rol o recurso ajeno; nunca texto histórico si el estado actual no es `COMPLETED`; se devuelve sin cachear.
- **Web:** texto escapado (nunca HTML) y siempre con el aviso de no verificado; sin edición.
- **Permisos:** el worker solo inserta en `ocr_results` y `ocr_result_pages`, sin SELECT ni `RETURNING`; la API solo los lee.
- 🔴 **Pendiente:** proveedor (P4); límite de páginas (PENDIENTE DE DECISIÓN B7).

## Permisos PostgreSQL (`DATABASE_SPEC.md` «Permisos de los roles de ejecución») 🟢

- **`legaltech_owner`:** solo migraciones. Es el único que ejecuta DDL.
- **`legaltech_app` (API):**
  - S/I/U en `users`, `sessions`, `email_verification_tokens`, `password_reset_tokens` y `email_outbox`;
  - S/I en `audit_logs`, `cases`, `case_status_history` y `documents`;
  - solo SELECT en `ocr_results` y `ocr_result_pages` (lectura del texto por el propietario);
  - en `pgboss`: USAGE, SELECT de `version` y `queue`, INSERT y SELECT(id) de `job_common`;
  - nada en `_prisma_migrations`; sin DELETE, TRUNCATE ni CREATE.
- **`legaltech_worker`:**
  - `documents`: SELECT y UPDATE solo de `status`, `scan_attempts`, `scan_started_at`, `scanned_at`, `scan_signature`, `sanitized_storage_key`, `ocr_status`, `ocr_attempts` y `ocr_started_at`;
  - `ocr_results` y `ocr_result_pages`: solo INSERT;
  - `audit_logs`: INSERT;
  - `pgboss`: `job_common` S/I/U/D, `job` S/I/U, `job_dependency` S/D, `queue` S/U, `version` S más UPDATE(`flow_on`, `monitor_backoff_on`);
  - nada en `schedule`, `subscription`, `bam` ni `warning`.
- **Cómo se comprueba:** `database.privileges.integration.test.ts` (API), `worker.privileges.integration.test.ts` y `pgboss.supervision.integration.test.ts`.
- **pg-boss:** arranca con `migrate`, `schedule`, `persistWarnings` y `reindex` desactivados. La API además desactiva `supervise`.
- **Regla** (instrucción del usuario): ningún cambio de permisos sin un test que lo demuestre y sin autorización. Si el UPDATE de casos llega a hacer falta, se concederá con la primera transición.

## Barreras antes de producción (`SECURITY_SPEC.md` §12), todas 🔴 salvo la indicada

- MFA; pentest; backups; límite compartido entre instancias.
- Límite por IP real (P3); decisiones jurídicas de datos; gestión de secretos.
- ClamAV de producción; metadata de PDF (P7); reconciliación de huérfanos y política de cuota.
- Almacenamiento de producción (P3); entrega real de email.
- 🟢 Ya cumplida: antivirus y metadata de JPEG y PNG.
