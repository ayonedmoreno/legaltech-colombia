# DATABASE_SPEC.md

**Versión:** 0.2 (rebanada de identidad y outbox de email, cierre de la Fase 1)
**Fecha:** 2026-09-27
**Estado:** Aprobado para el cierre de la Fase 1 (2026-09-27)
**Alcance:** únicamente `User`, `Session`, `EmailVerificationToken`, `PasswordResetToken`, `AuditLog` y `EmailOutbox` (Sprint 1B).
**Fuera de alcance:** `Case`, `Document`, `Payment`, `LegalSource`, `Professional` y demás entidades de `PROJECT_SPEC.md` s.15. Se añaden por rebanadas aprobadas antes de cada fase.

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

Basada en `PROJECT_SPEC.md` s.25. `case_id` se añadirá en la rebanada de `Case`.

| Columna | Tipo | Restricciones |
|---|---|---|
| `id` | uuid | PK |
| `occurred_at` | timestamptz | NOT NULL, DEFAULT now() |
| `actor_user_id` | uuid | NULL, FK `users(id)` ON DELETE RESTRICT |
| `actor_role` | `Role` | NULL |
| `action` | text | NOT NULL (p. ej. `auth.login.failed`) |
| `entity_type` | text | NULL |
| `entity_id` | text | NULL |
| `previous_value` | jsonb | NULL |
| `new_value` | jsonb | NULL |
| `metadata` | jsonb | NULL |
| `request_id` | text | NULL |
| `ip` | inet | NULL |
| `user_agent` | text | NULL |

- Índices: `(actor_user_id, occurred_at)`, `(action, occurred_at)`, `(entity_type, entity_id)`, y uno parcial para conteo de intentos fallidos por cuenta.
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

## Relaciones

```
users 1 ── * sessions
users 1 ── * email_verification_tokens
users 1 ── * password_reset_tokens
users 1 ── * audit_logs (actor)
users 1 ── * email_outbox
```

## Migraciones

- Migración inicial (`init_identity`) con el esquema de este documento, más una migración SQL manual con el CHECK de email, el trigger append-only de `audit_logs` y los permisos del rol de aplicación.
- `email_outbox` (Sprint 1B): tabla `email_outbox` y enum `email_outbox_kind`.
- `app_role_least_privilege` (Sprint 1B): el rol de aplicación pasa a tener solo los permisos de la tabla siguiente y deja de recibir permisos por defecto.
- Cada migración que cree una tabla concede en ella, explícitamente, los permisos que la aplicación necesite (y los añade al test `database.privileges.integration.test.ts`); sin ese `GRANT`, el rol de aplicación no puede usarla.
- Toda modificación al esquema actualiza este documento en el mismo cambio.

## Permisos del rol de aplicación

El rol de propietario (migraciones) crea las tablas; el rol de aplicación (`DATABASE_URL`, en tiempo de ejecución) no es superusuario ni propietario de ninguna y tiene exactamente:

| Tabla | Permisos |
|---|---|
| `users`, `sessions`, `email_verification_tokens`, `password_reset_tokens`, `email_outbox` | `SELECT`, `INSERT`, `UPDATE` |
| `audit_logs` | `SELECT`, `INSERT` (append-only) |
| `_prisma_migrations` | ninguno |

- Sin `DELETE` ni `TRUNCATE` en ninguna tabla, sin `CREATE` en el esquema, sin tablas temporales (el arranque de desarrollo retira `TEMPORARY` a `PUBLIC`) y sin permisos por defecto sobre tablas o secuencias futuras. `UPDATE` en `email_outbox` cubre también el `SELECT ... FOR UPDATE SKIP LOCKED` del despacho.
- Lo comprueba `apps/api/src/database.privileges.integration.test.ts`, que en CI se ejecuta como el rol de aplicación.
- Las bases de desarrollo creadas antes de este cambio conservan `TEMPORARY` para `PUBLIC` hasta recrear el volumen (`pnpm db:down` y borrar el volumen) o ejecutar como propietario `REVOKE TEMPORARY ON DATABASE legaltech FROM PUBLIC;`. Producción replica esta separación con sus propios roles y secretos.

## Pendiente (fuera de esta rebanada)

- Datos de MFA (TOTP y códigos de recuperación), previo a producción para ADMIN y SUPER_ADMIN (ADR-002).
- Política de retención y borrado de datos personales y de auditoría (validación jurídica).
