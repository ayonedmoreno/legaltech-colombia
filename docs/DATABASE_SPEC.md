# DATABASE_SPEC.md

**Versión:** 0.1 (rebanada de identidad, Sprint 1)
**Fecha:** 2026-09-24
**Estado:** Borrador para aprobación
**Alcance:** únicamente `User`, `Session`, `EmailVerificationToken`, `PasswordResetToken` y `AuditLog`.
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
- Una sesión es válida si `revoked_at IS NULL` y ahora es menor que `idle_expires_at` y que `absolute_expires_at`.
- Las sesiones expiradas se eliminan mediante un job de limpieza (se añade con el worker).

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

## Relaciones

```
users 1 ── * sessions
users 1 ── * email_verification_tokens
users 1 ── * password_reset_tokens
users 1 ── * audit_logs (actor)
```

## Migraciones

- Migración inicial (`init_identity`) con el esquema de este documento, más una migración SQL manual con el CHECK de email, el trigger append-only de `audit_logs` y los permisos del rol de aplicación.
- Toda modificación al esquema actualiza este documento en el mismo cambio.

## Pendiente (fuera de esta rebanada)

- Datos de MFA (TOTP y códigos de recuperación), previo a producción para ADMIN y SUPER_ADMIN (ADR-002).
- Política de retención y borrado de datos personales y de auditoría (validación jurídica).
