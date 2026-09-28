# DATABASE_SPEC.md

**Versión:** 0.6 (recuperación del tratamiento y mínimo privilegio del worker, Fase 3)
**Fecha:** 2026-09-28
**Estado:** Aprobado (cierre de las Fases 1 y 2, 2026-09-27; rebanadas 1 y 2 de la Fase 3 aprobadas el 2026-09-27 y el 2026-09-28)
**Alcance:** `User`, `Session`, `EmailVerificationToken`, `PasswordResetToken`, `AuditLog` y `EmailOutbox` (Sprint 1B); `Case` y `CaseStatusHistory` (Fase 2); `Document` (Fase 3, primera rebanada).
**Fuera de alcance:** `Infraction`, `Authority`, `DocumentVersion`, `Payment`, `LegalSource`, `Professional` y demás entidades de `PROJECT_SPEC.md` s.15. Se añaden por rebanadas aprobadas antes de cada fase.

## Convenciones

- Motor: PostgreSQL. ORM: Prisma. Nombres en inglés.
- Modelos Prisma en `PascalCase`; tablas y columnas en `snake_case` (`@@map` / `@map`).
- Claves primarias `uuid`. Timestamps `timestamptz` en UTC.
- Ninguna columna guarda contraseñas ni tokens en claro; solo hashes.
- Las restricciones que Prisma no expresa (CHECK, triggers, permisos) se incluyen en migraciones SQL manuales.

## Enums

| Enum | Valores |
|---|---|
| `Role` | `USER`, `PROFESSIONAL`, `ADMIN`, `SUPER_ADMIN` |
| `UserStatus` | `ACTIVE`, `SUSPENDED` |
| `SessionRevokedReason` | `LOGOUT`, `LOGOUT_ALL`, `PASSWORD_RESET`, `PASSWORD_CHANGE`, `ROTATED`, `ROLE_CHANGE`, `ADMIN_REVOKE`, `EXPIRED` |
| `EmailOutboxKind` | `EMAIL_VERIFICATION`, `PASSWORD_RESET`, `PASSWORD_RESET_COMPLETED` |
| `CaseType` | `TRAFFIC_CITATION` (comparendo), `INFRACTION` (infracción), `PHOTO_ENFORCEMENT` (fotodetección), `TRANSPORT` (transporte), `NOTIFICATION` (notificación), `ADMINISTRATIVE_PROCEEDING` (actuación administrativa), `OTHER` (otro): los 7 tipos de `PROJECT_SPEC.md` s.9 paso 2, sin añadir ninguno |
| `DocumentFileType` | `PDF`, `JPEG`, `PNG` (`PROJECT_SPEC.md` s.9 paso 4; fotografías y escaneos llegan como JPEG, PNG o PDF) |
| `DocumentStatus` | `UPLOADED`, `PENDING_SCAN`, `SCANNING`, `CLEAN`, `INFECTED`, `SCAN_FAILED` (tratamiento de seguridad del documento; ver `documents`) |
| `DocumentOcrStatus` | `NOT_STARTED` (primera rebanada; los demás valores llegan con el OCR, P4) |
| `CaseStatus` | Los 15 estados iniciales de `PROJECT_SPEC.md` s.8: `DRAFT`, `DOCUMENTS_PENDING`, `PRELIMINARY_ANALYSIS`, `PAYMENT_PENDING`, `PAID`, `LEGAL_REVIEW`, `DOCUMENT_PREPARATION`, `READY_TO_FILE`, `FILED`, `WAITING_RESPONSE`, `RESPONSE_RECEIVED`, `FOLLOW_UP`, `RESOLVED`, `CLOSED`, `CANCELLED` |

## Tablas

### `users`

| Columna | Tipo | Restricciones |
|---|---|---|
| `id` | uuid | PK |
| `email` | text | NOT NULL, UNIQUE, CHECK `email = lower(btrim(email))` |
| `email_verified_at` | timestamptz | NULL |
| `password_hash` | text | NOT NULL (Argon2id, formato con parámetros) |
| `full_name` | text | NOT NULL |
| `role` | `Role` | NOT NULL, DEFAULT `USER` |
| `status` | `UserStatus` | NOT NULL, DEFAULT `ACTIVE` |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() |
| `updated_at` | timestamptz | NOT NULL |

- El email se normaliza en la aplicación (minúsculas, sin espacios) antes de guardarse.
- Minimización de datos: en el Sprint 1 no se recogen documentos de identidad ni otros datos personales.
- Los usuarios no se eliminan físicamente en el Sprint 1; se suspenden. La política de borrado depende de una decisión jurídica pendiente.

### `sessions`

| Columna | Tipo | Restricciones |
|---|---|---|
| `id` | uuid | PK |
| `user_id` | uuid | NOT NULL, FK `users(id)` ON DELETE CASCADE |
| `token_hash` | text | NOT NULL, UNIQUE (SHA-256 del token) |
| `csrf_token_hash` | text | NOT NULL |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() |
| `last_seen_at` | timestamptz | NOT NULL |
| `idle_expires_at` | timestamptz | NOT NULL |
| `absolute_expires_at` | timestamptz | NOT NULL |
| `rotated_at` | timestamptz | NULL |
| `revoked_at` | timestamptz | NULL |
| `revoked_reason` | `SessionRevokedReason` | NULL |
| `ip` | inet | NULL |
| `user_agent` | text | NULL |

- Índices: `(user_id)`, `(user_id, revoked_at)`, `(absolute_expires_at)` para limpieza.
- Una sesión es válida si `revoked_at IS NULL` y ahora es menor que `idle_expires_at` y que `absolute_expires_at`; si `rotated_at` no es nulo, además, solo durante los 60 s siguientes a `rotated_at` (gracia de la rotación, Sprint 1B).
- `rotated_at` marca cuándo se rotó la sesión; se fija con una sola sentencia condicional (`revoked_at IS NULL AND rotated_at IS NULL`), así que una sesión se rota una vez. En la siguiente rotación del usuario, las sesiones con la gracia cumplida se revocan con motivo `ROTATED`.
- Las revocaciones de la API (`LOGOUT`, `LOGOUT_ALL`, revocación por ID) se aplican con una sentencia condicional (`revoked_at IS NULL`) y su evento de auditoría se escribe en la misma transacción, solo si la sentencia revocó algo (Sprint 1B, H1): ambos o ninguno, sin eventos duplicados.
- Las sesiones expiradas se eliminan mediante un job de limpieza (se añade con el worker). El rol de aplicación no tiene `DELETE` (ver «Permisos del rol de aplicación»): la migración que introduzca ese job le concederá el permiso, o el job usará un rol propio.

### `email_verification_tokens`

| Columna | Tipo | Restricciones |
|---|---|---|
| `id` | uuid | PK |
| `user_id` | uuid | NOT NULL, FK `users(id)` ON DELETE CASCADE |
| `token_hash` | text | NOT NULL, UNIQUE |
| `expires_at` | timestamptz | NOT NULL |
| `used_at` | timestamptz | NULL |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() |

- Índice: `(user_id)`.
- Sprint 1B: el token se genera al despachar el email de verificación y caduca a las 24 h. Al emitir uno nuevo, los anteriores sin usar del usuario quedan marcados como usados (decisión P7). Se consume con una sola sentencia condicional (sin usar y sin caducar, con la hora de PostgreSQL), en la misma transacción que fija `users.email_verified_at`.

### `password_reset_tokens`

| Columna | Tipo | Restricciones |
|---|---|---|
| `id` | uuid | PK |
| `user_id` | uuid | NOT NULL, FK `users(id)` ON DELETE CASCADE |
| `token_hash` | text | NOT NULL, UNIQUE |
| `expires_at` | timestamptz | NOT NULL |
| `used_at` | timestamptz | NULL |
| `requested_ip` | inet | NULL |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() |

- Índice: `(user_id)`.
- Sprint 1B: el token se genera al despachar el email de restablecimiento y caduca a los 30 min; uno nuevo invalida los anteriores sin usar (decisión P7). Se consume con una sola sentencia condicional (sin usar y sin caducar, con la hora de PostgreSQL), en la transacción que sustituye la contraseña, invalida los demás tokens del usuario, revoca todas sus sesiones (`PASSWORD_RESET`), registra el aviso por email y audita. `requested_ip` queda vacío: el outbox guarda solo la intención.

### `audit_logs`

Basada en `PROJECT_SPEC.md` s.25. `case_id` se añadió con la rebanada de `Case`.

| Columna | Tipo | Restricciones |
|---|---|---|
| `id` | uuid | PK |
| `occurred_at` | timestamptz | NOT NULL, DEFAULT now() |
| `actor_user_id` | uuid | NULL, FK `users(id)` ON DELETE RESTRICT |
| `actor_role` | `Role` | NULL |
| `action` | text | NOT NULL (p. ej. `auth.login.failed`) |
| `entity_type` | text | NULL |
| `entity_id` | text | NULL |
| `case_id` | uuid | NULL, FK `cases(id)` ON DELETE RESTRICT |
| `previous_value` | jsonb | NULL |
| `new_value` | jsonb | NULL |
| `metadata` | jsonb | NULL |
| `request_id` | text | NULL |
| `ip` | inet | NULL |
| `user_agent` | text | NULL |

- Índices: `(actor_user_id, occurred_at)`, `(action, occurred_at)`, `(entity_type, entity_id)`, `(case_id, occurred_at)` y uno parcial para conteo de intentos fallidos por cuenta.
- **Append-only:** el rol de base de datos de la aplicación no tiene `UPDATE` ni `DELETE` sobre esta tabla, y un trigger rechaza ambos como segunda barrera.
- **Redacción obligatoria:** `previous_value`, `new_value` y `metadata` nunca contienen contraseñas, tokens ni hashes.
- `actor_user_id` nulo se usa para eventos sin usuario identificado (p. ej. login fallido de un correo inexistente; en ese caso el correo se guarda en `metadata` únicamente como hash).
- La política de retención de auditoría depende de una decisión jurídica pendiente.

### `email_outbox`

Patrón outbox (ARCHITECTURE_REPORT §2; Sprint 1B, decisión C2): cada email pendiente es una intención registrada en la misma transacción que el cambio que la provoca.

| Columna | Tipo | Restricciones |
|---|---|---|
| `id` | uuid | PK |
| `kind` | `EmailOutboxKind` | NOT NULL |
| `user_id` | uuid | NOT NULL, FK `users(id)` ON DELETE CASCADE |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() |
| `sent_at` | timestamptz | NULL (pendiente mientras es NULL) |

- Índice: `(sent_at, created_at)`, para recorrer las pendientes por antigüedad.
- **Nunca guarda un token ni otro secreto** (ADR-002: los tokens solo se guardan como hash). El token de un email se genera en memoria al despacharlo; solo su hash se guarda, en su tabla.
- El despacho toma cada pendiente con `FOR UPDATE SKIP LOCKED`, compone y envía el mensaje, y la marca como enviada en la misma transacción; si algo falla, sigue pendiente. En el Sprint 1B lo invocan los tests y un comando de desarrollo (`pnpm email:dispatch`); en la Fase 3 lo invocará el worker (ADR-001).

### `cases`

Objeto central y genérico de la plataforma (`PROJECT_SPEC.md` s.7 y s.35). Primera rebanada de la Fase 2: solo el propietario, el tipo y el estado. `Infraction`, `Authority`, documentos, pagos y asignaciones llegan con sus fases.

| Columna | Tipo | Restricciones |
|---|---|---|
| `id` | uuid | PK |
| `user_id` | uuid | NOT NULL, FK `users(id)` ON DELETE RESTRICT (propietario) |
| `type` | `CaseType` | NOT NULL |
| `status` | `CaseStatus` | NOT NULL, DEFAULT `DRAFT` |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() |
| `updated_at` | timestamptz | NOT NULL |

- Índice: `(user_id, created_at)`, para el listado de los casos de un usuario.
- Minimización de datos: sin texto libre ni datos personales; al crear el caso solo se elige el tipo (`PROJECT_SPEC.md` s.9 paso 2).
- **Estados y transiciones:** ver «Estados y transiciones del caso». En esta rebanada solo `DRAFT` es alcanzable: un caso nace en `DRAFT` y ninguna transición está habilitada (tampoco la cancelación).
- Los casos no se eliminan.

#### Estados y transiciones del caso

Máquina de estados de dominio (ARCHITECTURE_REPORT, hallazgo 11), aprobada el 2026-09-27. Está implementada como capa pura en `apps/api/src/modules/cases/case-status.ts`, sin endpoints ni persistencia propia. `case_status_history` es la única traza de los cambios de estado.

Las fases siguen la numeración de `PROJECT_SPEC.md` s.34: Documents F3, Pricing F4, Payments F5, Legal AI F6, Professionals F7. ARCHITECTURE_REPORT §6 propone otro orden, sin decidir (P1).

**Estados**

| Estado | Paso de s.9 | Significado según los documentos | Fase |
|---|---|---|---|
| `DRAFT` | 2 | Caso creado; primer estado inicial (s.8) | F2 (implementado) |
| `DOCUMENTS_PENDING` | 4 | Se esperan documentos | F3 |
| `PRELIMINARY_ANALYSIS` | 5-6 | OCR, extracción y diagnóstico preliminar | F3 y F6 |
| `PAYMENT_PENDING` | 7-8 | Valoración, oferta y pago pendiente (s.5) | F4 y F5 |
| `PAID` | 9 | "Confirmado el pago, el caso pasa a `PAID`" | F5 |
| `LEGAL_REVIEW` | 10 | "Se realiza el análisis completo" | F7 |
| `DOCUMENT_PREPARATION` | 11 | "Se preparan las actuaciones que correspondan" | F7 |
| `READY_TO_FILE` | 11 | Actuación lista y aprobada (ningún documento sale sin aprobación profesional; s.6 "aprobar documentos") | F7 |
| `FILED` | 11 | Actuación radicada; la radicación automática no es prioritaria (s.33) | F7 |
| `WAITING_RESPONSE` | 12 | Se espera la respuesta de la autoridad | F7 |
| `RESPONSE_RECEIVED` | 13 | "Las respuestas recibidas se incorporan al expediente" | F7 |
| `FOLLOW_UP` | — | Sin definir (V1) | Pendiente |
| `RESOLVED` | — | Sin definir (V2) | Pendiente |
| `CLOSED` | 14 | "Se cierra cuando finaliza la gestión contratada" | Pendiente (V2) |
| `CANCELLED` | — | Sin fuente (V7) | Pendiente |

**Transiciones documentadas.** Tipo **E**: explícita en los documentos; tipo **I**: inferida directamente del orden de s.8 y s.9. **Ninguna está habilitada**: cada una se habilita, con su endpoint o disparador, su permiso, el historial y `case.status_changed` en la misma transacción, en la fase que posee su disparador real.

| # | Transición | Tipo | Disparador documentado | Actor | Fase |
|---|---|---|---|---|---|
| T0 | (creación) → `DRAFT` | E | Crear el caso (`POST /api/cases`) | USER propietario | F2, activa |
| T1 | `DRAFT` → `DOCUMENTS_PENDING` | I | Datos iniciales completos (s.9 paso 3) | Pendiente | Cuestionario o F3 |
| T2 | `DOCUMENTS_PENDING` → `PRELIMINARY_ANALYSIS` | I | Documentos cargados; "el sistema realizará OCR y extracción" (paso 5) | Sistema | F3 |
| T3 | `PRELIMINARY_ANALYSIS` → `PAYMENT_PENDING` | I | Valoración y oferta (s.5; paso 7) | Pendiente | F4 |
| T4 | `PAYMENT_PENDING` → `PAID` | **E** | Webhook de pago verificado; nunca el frontend (s.9 paso 9, s.23) | Sistema | F5 |
| T5 | `PAID` → `LEGAL_REVIEW` | I | Apertura formal y gestión (pasos 9-10) | Pendiente | F7 |
| T6 | `LEGAL_REVIEW` → `DOCUMENT_PREPARATION` | I | Análisis completo (paso 10) | PROFESSIONAL asignado (s.6 "actualizar estados") | F7 |
| T7 | `DOCUMENT_PREPARATION` → `READY_TO_FILE` | I | Documentos aprobados (s.6 "aprobar documentos") | PROFESSIONAL asignado | F7 |
| T8 | `READY_TO_FILE` → `FILED` | I | Actuación registrada (s.6 "registrar actuaciones") | PROFESSIONAL asignado | F7; además requiere V8 |
| T9 | `FILED` → `WAITING_RESPONSE` | I | Actuación radicada (paso 12) | Pendiente | F7 |
| T10 | `WAITING_RESPONSE` → `RESPONSE_RECEIVED` | I | Respuesta incorporada (paso 13) | PROFESSIONAL asignado | F7 |

Ningún cambio de estado lo inicia el usuario (s.6: el usuario "consulta estados"); el actor de T1, T3, T5 y T9 queda pendiente de su fase.

**Pendientes de decisión (no se resuelven por inferencia; ARCHITECTURE_REPORT §7):**

- **V1:** posición y significado de `FOLLOW_UP` (s.9 pone "Seguimiento" antes de "Respuesta"; s.8, después de `RESPONSE_RECEIVED`).
- **V2:** diferencia entre `RESOLVED` y `CLOSED`; por tanto, las salidas de `RESPONSE_RECEIVED` y el paso a `CLOSED`.
- **V3:** `changed_by_user_id` es NOT NULL, pero T4 la dispara el sistema. La migración de la fase de pagos permitirá un cambio sin usuario (nulo o actor de sistema).
- **V4:** posición de `LEGAL_REVIEW` respecto al pricing y la asignación profesional (hallazgo 1; s.21 "activar revisión profesional cuando corresponda").
- **V5:** retrocesos, por ejemplo por información faltante (paso 6).
- **V6:** salida cuando no procede actuar o el usuario no acepta la oferta.
- **V7:** cancelación: quién cancela y desde qué estados (tras el pago, reembolsos: validación jurídica).
- **V8:** autorización o mandato para radicar ante las autoridades (validación jurídica).

### `case_status_history`

Historial de estados de cada caso (`PROJECT_SPEC.md` s.8: "todos los cambios de estado deberán registrarse en un historial").

| Columna | Tipo | Restricciones |
|---|---|---|
| `id` | uuid | PK |
| `case_id` | uuid | NOT NULL, FK `cases(id)` ON DELETE RESTRICT |
| `from_status` | `CaseStatus` | NULL (solo en la entrada de creación) |
| `to_status` | `CaseStatus` | NOT NULL |
| `changed_by_user_id` | uuid | NOT NULL, FK `users(id)` ON DELETE RESTRICT |
| `changed_at` | timestamptz | NOT NULL, DEFAULT now() |

- Índice: `(case_id, changed_at)`.
- Append-only para la aplicación (solo `SELECT` e `INSERT`).
- La creación de un caso escribe, en una sola transacción, el caso, su entrada `NULL → DRAFT` y el evento `case.created` (con `case_id`): se guarda todo o nada.

### `documents`

Documentos de un caso (`PROJECT_SPEC.md` s.16: "cada documento deberá asociarse a un caso"). El archivo no se guarda en PostgreSQL sino en almacenamiento de objetos privado (s.16; ADR-001 punto 8), detrás de `StorageProvider`; aquí solo están sus metadatos.

| Columna | Tipo | Restricciones |
|---|---|---|
| `id` | uuid | PK |
| `case_id` | uuid | NOT NULL, FK `cases(id)` ON DELETE RESTRICT |
| `file_name` | text | NOT NULL (nombre original, de 1 a 255 caracteres, sin rutas ni caracteres de control) |
| `file_type` | `DocumentFileType` | NOT NULL (determinado por el contenido del archivo, no por su extensión) |
| `storage_key` | text | NOT NULL, UNIQUE (`cases/{case_id}/documents/{id}`: sin el nombre del archivo) |
| `file_size` | integer | NOT NULL, CHECK `file_size > 0` (bytes) |
| `uploaded_by_user_id` | uuid | NOT NULL, FK `users(id)` ON DELETE RESTRICT |
| `created_at` | timestamptz | NOT NULL |
| `status` | `DocumentStatus` | NOT NULL, DEFAULT `PENDING_SCAN` (ver «Tratamiento de seguridad del documento») |
| `ocr_status` | `DocumentOcrStatus` | NOT NULL, DEFAULT `NOT_STARTED` |
| `scan_attempts` | integer | NOT NULL, DEFAULT 0, CHECK `scan_attempts >= 0` (tratamientos empezados) |
| `scan_started_at` | timestamptz | NULL (inicio del tratamiento en curso; identifica el reclamo del worker) |
| `scanned_at` | timestamptz | NULL (fin del tratamiento con `CLEAN`, `INFECTED` o `SCAN_FAILED`) |
| `scan_signature` | text | NULL (solo con `INFECTED`: nombre de la firma que detectó el antivirus) |
| `sanitized_storage_key` | text | NULL, UNIQUE (copia derivada sin la metadata que retira la política; solo JPEG y PNG `CLEAN`) |

- Índices: `(case_id, created_at)` y `(status)`.
- El archivo se escribe en el almacenamiento antes que la fila; la fila, `document.uploaded` (con `case_id`) y el job `document.scan` se escriben en una transacción, con una sola hora de PostgreSQL. Si la transacción falla, se borra el objeto recién escrito; si también falla ese borrado, queda un objeto huérfano sin fila, que nadie puede descargar (se registra en el log).
- **El original nunca se modifica ni se borra**: queda privado e intacto en `storage_key`. La copia derivada es un objeto aparte (`{storage_key}.sanitized`).
- Sin `DocumentVersion` todavía.

#### Tratamiento de seguridad del documento (Fase 3, segunda rebanada)

Lo hace el worker (`apps/worker`), fuera de la petición HTTP: análisis antivirus con ClamAV dentro de nuestra infraestructura y, para JPEG y PNG, una copia derivada sin la metadata que retira la política (ver **Metadata** más abajo). **Solo un documento `CLEAN` se puede descargar**, y se descarga la versión que pasó el tratamiento: la copia derivada para JPEG y PNG, el original intacto para PDF.

| Estado | Significado |
|---|---|
| `UPLOADED` | Estado heredado: documento guardado antes de que existiera el antivirus (primera rebanada), sin job. Las subidas nuevas nunca pasan por él: entran en `PENDING_SCAN` con su job en la misma transacción. El barrido del worker lo pasa a `PENDING_SCAN` y lo pone en cola. |
| `PENDING_SCAN` | Pendiente de tratamiento, con un job `document.scan` en cola. Estado inicial de todo documento nuevo. |
| `SCANNING` | Un worker lo reclamó y lo está tratando. |
| `CLEAN` | Sin amenazas y, si es JPEG o PNG, con su copia derivada guardada. Estado final; el único descargable. |
| `INFECTED` | El antivirus detectó una amenaza. Estado final; nunca se descarga. El original se conserva privado. |
| `SCAN_FAILED` | No se pudo completar el tratamiento tras agotar los intentos (antivirus caído, tiempo agotado, respuesta inesperada, objeto ausente o fallo al quitar la metadata). Estado final en esta rebanada; nunca se descarga. Volver a tratarlo es una operación futura, no expuesta todavía. |

Transiciones, todas con una sentencia condicional dentro de una transacción:

| Desde | Hasta | Cuándo |
|---|---|---|
| (nuevo) | `PENDING_SCAN` | Subida: fila, `document.uploaded` y job en la misma transacción. |
| `UPLOADED` | `PENDING_SCAN` | Barrido del worker (documentos anteriores al antivirus): estado y job en la misma transacción. |
| `PENDING_SCAN` | `SCANNING` | Reclamo: `UPDATE … WHERE status = 'PENDING_SCAN'`; suma 1 a `scan_attempts` y fija `scan_started_at`. Solo un worker lo consigue. |
| `SCANNING` | `SCANNING` | Reclamo de un tratamiento abandonado (`scan_started_at` más antiguo que el plazo de reclamo: el worker que lo tenía murió). |
| `SCANNING` | `CLEAN`, `INFECTED` | Resultado. Solo lo escribe el worker que tiene el reclamo (mismo `scan_started_at`). |
| `SCANNING` | `PENDING_SCAN` | Error transitorio con intentos pendientes: el job se reintenta. |
| `SCANNING` | `SCAN_FAILED` | Error sin intentos pendientes (5 intentos). |
| `SCANNING` | `PENDING_SCAN` | Barrido del worker: reclamo abandonado (más antiguo que el plazo de reclamo, 600 s) con intentos pendientes (`scan_attempts` < 5); estado y nuevo job en la misma transacción. |
| `SCANNING` | `SCAN_FAILED` | Barrido del worker: reclamo abandonado sin intentos pendientes (`scan_attempts` ≥ 5), con `document.scan_failed` en la misma transacción. Un archivo que tumba al worker no se reintenta indefinidamente. |

- **Barrido de recuperación:** el worker lo ejecuta al arrancar y después cada `SCAN_SWEEP_INTERVAL_SECONDS` (60 s por defecto), sin depender de reinicios, de los reintentos de pg-boss (que se agotan) ni de su planificador (`schedule`, desactivado). Bloquea las filas con `FOR UPDATE SKIP LOCKED` y vuelve a comprobar la condición sobre la fila bloqueada, así que varios workers a la vez actúan una sola vez sobre cada documento, sin esperarse. Al quitar `scan_started_at`, el worker que tenía el reclamo ya no puede escribir un resultado.
- **Recuperación, no transición del caso:** las vueltas a `PENDING_SCAN` (reintento y barrido) son recuperación de trabajos del tratamiento del documento; no cambian `scan_attempts` (lo suma el reclamo) ni el estado del `Case`.
- **Idempotencia:** un job cuyo documento no está en `PENDING_SCAN` (ni es un `SCANNING` abandonado) no hace nada. Un job repetido o simultáneo nunca trata dos veces el mismo documento ni escribe dos resultados.
- **Nunca `CLEAN` por defecto:** solo la respuesta exacta de "sin amenazas" de ClamAV produce `CLEAN`; cualquier otra respuesta, error o tiempo agotado es un error.
- **Metadata** (decisión del 2026-09-28): JPEG: se recorre toda la estructura y se quitan los segmentos EXIF (con GPS) y XMP (`APP1`), IPTC (`APP13`) y comentarios (`COM`) donde aparezcan, también entre los barridos de un JPEG progresivo; los datos de imagen se copian byte a byte, sin recodificar, y se descarta lo que haya después de `EOI`. PNG: se quitan los bloques `eXIf`, `tEXt`, `zTXt` e `iTXt` (incluye XMP), se conservan los demás, que forman la imagen, y se descarta lo que haya después de `IEND`. **La política no retira toda la metadata posible:** se conservan, entre otros, en JPEG los segmentos `APP0` (JFIF, que puede llevar una miniatura), `APP2` (perfil de color ICC e índice MPF), `APP12` y los demás `APPn` de fabricantes; en PNG, `tIME` (fecha de modificación), `iCCP` (nombre del perfil de color) y los bloques auxiliares privados. Retirarlos sería ampliar la política, algo no decidido. El original nunca se sobrescribe: la copia derivada es otro objeto (`sanitized_storage_key`). **PDF: no se modifica**; su limpieza de metadata es una decisión pendiente. Si la limpieza falla, cuenta como error del tratamiento y el documento no se habilita.
- **Auditoría** (sin actor: la hace el sistema), en la misma transacción que el cambio, con `case_id` y sin el nombre del archivo: `document.scan_clean`, `document.scan_infected` (con la firma en `new_value`) y `document.scan_failed`. El reclamo y los reintentos no se auditan.

#### Cola de trabajos (pg-boss)

pg-boss 12.35.0 sobre el mismo PostgreSQL (ADR-001 punto 7), en el esquema `pgboss`, con la cola `document.scan`.

- **El esquema y la cola los crea el rol propietario** con una migración versionada (el SQL que exporta `getConstructionPlans` de esa versión, y `create_queue` sin particionar, que no ejecuta DDL). Actualizar pg-boss exige una migración con su cambio de esquema.
- En tiempo de ejecución **ningún proceso de la aplicación ejecuta DDL**. Las dos instancias arrancan con `migrate: false` (solo comprueba la versión), `schedule: false` (sin planificador), `persistWarnings: false` y `reindex: false`:
  - **API** (`startPgBossForApi`): además `supervise: false`. Solo encola, en la misma transacción que la fila del documento.
  - **Worker** (`startPgBossForWorker`): `supervise: true` y `persistQueueStats: false`. Consume la cola y hace la supervisión (caducidad de trabajos, conteos de la cola), el mantenimiento (retención de trabajos y limpieza de dependencias) y la resolución de flujos, todo DML. No envía trabajos con dependencias ni usa publicación/suscripción.
- Reintentos de la cola: 4 (5 intentos en total), con espera creciente; el worker además cuenta los intentos en `scan_attempts` y marca `SCAN_FAILED` al agotarlos.

## Relaciones

```
users 1 ── * sessions
users 1 ── * email_verification_tokens
users 1 ── * password_reset_tokens
users 1 ── * audit_logs (actor)
users 1 ── * email_outbox
users 1 ── * cases (propietario)
cases 1 ── * case_status_history
cases 1 ── * audit_logs (case_id)
cases 1 ── * documents
users 1 ── * documents (uploaded_by)
```

## Migraciones

- Migración inicial (`init_identity`) con el esquema de este documento, más una migración SQL manual con el CHECK de email, el trigger append-only de `audit_logs` y los permisos del rol de aplicación.
- `email_outbox` (Sprint 1B): tabla `email_outbox` y enum `email_outbox_kind`.
- `app_role_least_privilege` (Sprint 1B): el rol de aplicación pasa a tener solo los permisos de la tabla siguiente y deja de recibir permisos por defecto.
- `cases` (Fase 2): enums `case_type` y `case_status`, tablas `cases` y `case_status_history`, columna `audit_logs.case_id`, y sus permisos.
- `documents` (Fase 3): enums `document_file_type`, `document_status` y `document_ocr_status`, tabla `documents` y sus permisos.
- `document_scan_states` y `document_scan` (Fase 3, segunda rebanada): nuevos estados de `document_status`; columnas `scan_*` y `sanitized_storage_key`; esquema `pgboss` con la cola `document.scan`; permisos del rol de worker.
- `worker_pgboss_least_privilege` (Fase 3, cierre de la segunda rebanada): retira al rol del worker los permisos de `pgboss` que no usa con su configuración (`DELETE` en `job`; `INSERT` y `UPDATE` en `job_dependency`; `SELECT` en `schedule`, `subscription`, `bam` y `warning`; `UPDATE` de `cron_on`, `bam_on` y `reindex_on`).
- Cada migración que cree una tabla concede en ella, explícitamente, los permisos que la aplicación necesite (y los añade al test `database.privileges.integration.test.ts`); sin ese `GRANT`, el rol de aplicación no puede usarla.
- Toda modificación al esquema actualiza este documento en el mismo cambio.

## Permisos de los roles de ejecución

El rol de propietario (migraciones) crea las tablas y el esquema `pgboss`. Dos roles de ejecución, ninguno superusuario, propietario ni con `CREATE`: el de la aplicación (`DATABASE_URL`, la API) y el del worker (`WORKER_DATABASE_URL`, desde la Fase 3). El rol de aplicación tiene exactamente:

| Tabla | Permisos |
|---|---|
| `users`, `sessions`, `email_verification_tokens`, `password_reset_tokens`, `email_outbox` | `SELECT`, `INSERT`, `UPDATE` |
| `audit_logs` | `SELECT`, `INSERT` (append-only) |
| `documents` | `SELECT`, `INSERT` (nunca cambia el estado del tratamiento: eso lo hace el worker) |
| Esquema `pgboss` | `USAGE`; `SELECT` en `pgboss.version` y `pgboss.queue`; `INSERT` y `SELECT (id)` en `pgboss.job_common` (encolar; `SELECT (id)` lo exige `INSERT … RETURNING id`) |
| `cases`, `case_status_history` | `SELECT`, `INSERT` (sin transiciones en esta rebanada; `UPDATE` en `cases` se concederá con la primera transición) |
| `_prisma_migrations` | ninguno |

- Sin `DELETE` ni `TRUNCATE` en ninguna tabla, sin `CREATE` en el esquema, sin tablas temporales (el arranque de desarrollo retira `TEMPORARY` a `PUBLIC`) y sin permisos por defecto sobre tablas o secuencias futuras. `UPDATE` en `email_outbox` cubre también el `SELECT ... FOR UPDATE SKIP LOCKED` del despacho.
- Lo comprueba `apps/api/src/database.privileges.integration.test.ts`, que en CI se ejecuta como el rol de aplicación.

El rol del worker (`legaltech_worker`) tiene exactamente lo que el tratamiento de documentos necesita:

| Tabla | Permisos |
|---|---|
| `documents` | `SELECT`, y `UPDATE` solo de `status`, `scan_attempts`, `scan_started_at`, `scanned_at`, `scan_signature` y `sanitized_storage_key` (permiso por columna: el nombre, la clave del original, el caso y el tamaño no se pueden cambiar) |
| `audit_logs` | `INSERT` |
| Esquema `pgboss` | `USAGE`; sin `CREATE` |
| `pgboss.job_common` (tabla de la cola) | `SELECT`, `INSERT`, `UPDATE`, `DELETE` (obtener, completar, reintentar y caducar trabajos; retención) |
| `pgboss.job` (tabla padre) | `SELECT`, `INSERT`, `UPDATE` (al completar se actualizan los dependientes; la sentencia de fallo y reintento la nombra). Sin `DELETE`: pg-boss borra por la tabla de la cola |
| `pgboss.job_dependency` | `SELECT` (al completar) y `DELETE` (limpieza del mantenimiento). Sin `INSERT` ni `UPDATE`: no se envían trabajos con dependencias |
| `pgboss.queue` | `SELECT`, `UPDATE` (la supervisión y el mantenimiento anotan sus tiempos y conteos en la fila de la cola) |
| `pgboss.version` | `SELECT`, y `UPDATE` solo de `flow_on` y `monitor_backoff_on` (resolución de flujos y supervisión; nunca la versión del esquema) |
| Todo lo demás | ninguno. En `pgboss`, sin acceso a `schedule`, `subscription`, `bam` ni `warning`: solo los usarían el planificador, la publicación/suscripción, las migraciones de pg-boss y los avisos persistidos, todos desactivados |

- Lo comprueban, como el rol del worker, `apps/worker/src/worker.privileges.integration.test.ts` (los permisos exactos y los rechazos) y `apps/worker/src/pgboss.supervision.integration.test.ts` (una pasada real de supervisión y mantenimiento de pg-boss con esos permisos). Activar el planificador, los avisos persistidos, los trabajos con dependencias o la publicación/suscripción, o actualizar pg-boss, exige revisar estos permisos con una migración.
- Las bases de desarrollo creadas antes de este cambio conservan `TEMPORARY` para `PUBLIC` hasta recrear el volumen (`pnpm db:down` y borrar el volumen) o ejecutar como propietario `REVOKE TEMPORARY ON DATABASE legaltech FROM PUBLIC;`. Producción replica esta separación con sus propios roles y secretos.

## Pendiente (fuera de esta rebanada)

- Datos de MFA (TOTP y códigos de recuperación), previo a producción para ADMIN y SUPER_ADMIN (ADR-002).
- Política de retención y borrado de datos personales y de auditoría (validación jurídica).
