# API_SPEC.md

**Versión:** 0.1 (endpoints de autenticación, Sprint 1)
**Fecha:** 2026-09-24
**Estado:** Borrador para aprobación
**Alcance:** únicamente los endpoints de autenticación. Casos, documentos, pagos y demás se añaden con su fase.
**Referencias:** ADR-002, ADR-003, `SECURITY_SPEC.md`, `DATABASE_SPEC.md`.

Este documento se mantiene sincronizado con el OpenAPI generado por la API. Toda modificación de un endpoint actualiza este archivo en el mismo cambio.

## Convenciones

- Prefijo `/api`. JSON en request y response (`Content-Type: application/json`).
- Campos en `camelCase` en inglés.
- Autenticación por cookie de sesión `httpOnly` (ADR-002).
- Métodos no seguros (POST, PATCH, DELETE) con sesión requieren `X-CSRF-Token`; se obtiene con `GET /api/auth/csrf`.
- El registro y el login previos a tener sesión no requieren token de sesión, pero verifican `Origin`.
- Los identificadores son UUID.

### Formato de error

```json
{
  "error": {
    "code": "INVALID_CREDENTIALS",
    "message": "Credenciales inválidas.",
    "details": [],
    "requestId": "..."
  }
}
```

`message` es para mostrar al usuario en español; `code` es estable y en inglés. `details` solo se usa en errores de validación (`field`, `issue`).

### Códigos de error comunes

| HTTP | `code` | Uso |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Cuerpo o parámetros inválidos |
| 401 | `UNAUTHENTICATED` | Sin sesión válida |
| 401 | `INVALID_CREDENTIALS` | Email o contraseña incorrectos (mensaje genérico) |
| 403 | `CSRF_INVALID` | Token CSRF ausente o inválido, u origen no permitido |
| 403 | `FORBIDDEN` | La policy niega la acción |
| 404 | `NOT_FOUND` | Recurso inexistente o no visible para el actor |
| 429 | `RATE_LIMITED` | Límite excedido (`Retry-After`) |
| 500 | `INTERNAL_ERROR` | Error inesperado, sin detalles internos |

## Endpoints

### `GET /api/auth/csrf`

Devuelve el token CSRF de la sesión actual. Requiere sesión.

- **200:** `{ "csrfToken": "string" }`
- **401:** `UNAUTHENTICATED`

Para peticiones sin sesión (registro, login, recuperación) se comprueba `Origin` y no se exige token.

### `POST /api/auth/register`

Crea una cuenta con rol `USER` y envía el email de verificación.

- **Body:** `{ "email": "string", "password": "string", "fullName": "string" }`
- **Reglas:** email válido y normalizado; contraseña de 12 a 128 caracteres; `fullName` no vacío.
- **202:** `{ "status": "accepted" }`. La respuesta es idéntica exista o no el correo, para evitar enumeración. Si el correo ya existe, se envía un aviso a esa dirección en lugar de crear otra cuenta.
- **400:** `VALIDATION_ERROR`
- **429:** `RATE_LIMITED`
- **Auditoría:** `auth.register.requested`

### `POST /api/auth/login`

Inicia sesión y establece la cookie de sesión.

- **Body:** `{ "email": "string", "password": "string" }`
- **200:** `{ "user": User }` más `Set-Cookie` de sesión (rotada al iniciar sesión).
- **401:** `INVALID_CREDENTIALS` (mismo mensaje para correo inexistente, contraseña errónea o cuenta suspendida)
- **429:** `RATE_LIMITED`
- **Auditoría:** `auth.login.succeeded`, `auth.login.failed`
- **Nota:** en producción, los roles ADMIN y SUPER_ADMIN no pueden iniciar sesión hasta que MFA esté implementado (ADR-002).

### `POST /api/auth/logout`

Revoca la sesión actual. Requiere sesión y CSRF.

- **204**
- **401 / 403:** `UNAUTHENTICATED` / `CSRF_INVALID`
- **Auditoría:** `auth.logout`

### `POST /api/auth/logout-all`

Revoca todas las sesiones del usuario. Requiere sesión y CSRF.

- **204**
- **Auditoría:** `auth.logout_all`

### `GET /api/auth/me`

Devuelve el usuario autenticado.

- **200:** `{ "user": User }`
- **401:** `UNAUTHENTICATED`

### `GET /api/auth/sessions`

Lista las sesiones activas del usuario (solo las propias).

- **200:** `{ "sessions": [Session] }`, con la sesión actual marcada.
- **401:** `UNAUTHENTICATED`

### `DELETE /api/auth/sessions/:sessionId`

Revoca una sesión propia. Requiere sesión y CSRF.

- **204**
- **404:** `NOT_FOUND`, también cuando la sesión pertenece a otro usuario (protección IDOR, ADR-003).
- **Auditoría:** `auth.session.revoked`

### `POST /api/auth/email/verify`

Confirma el email con el token recibido.

- **Body:** `{ "token": "string" }`
- **204**
- **400:** `INVALID_OR_EXPIRED_TOKEN` (token inexistente, usado o expirado, sin distinguirlos)
- **Auditoría:** `auth.email.verified`

### `POST /api/auth/email/verification/resend`

Reenvía el email de verificación. Requiere sesión y CSRF.

- **202:** `{ "status": "accepted" }`
- **429:** `RATE_LIMITED`

### `POST /api/auth/password/forgot`

Solicita la recuperación de contraseña.

- **Body:** `{ "email": "string" }`
- **202:** `{ "status": "accepted" }`, siempre, exista o no la cuenta.
- **429:** `RATE_LIMITED`
- **Auditoría:** `auth.password.reset_requested`

### `POST /api/auth/password/reset`

Establece una nueva contraseña con el token recibido.

- **Body:** `{ "token": "string", "newPassword": "string" }`
- **204:** revoca todas las sesiones del usuario y envía aviso por email.
- **400:** `INVALID_OR_EXPIRED_TOKEN` / `VALIDATION_ERROR`
- **Auditoría:** `auth.password.reset_completed`

## Esquemas

### `User`

```json
{
  "id": "uuid",
  "email": "string",
  "fullName": "string",
  "role": "USER | PROFESSIONAL | ADMIN | SUPER_ADMIN",
  "emailVerified": true,
  "createdAt": "ISO-8601"
}
```

### `Session`

```json
{
  "id": "uuid",
  "createdAt": "ISO-8601",
  "lastSeenAt": "ISO-8601",
  "ip": "string | null",
  "userAgent": "string | null",
  "current": true
}
```

Nunca se devuelven `passwordHash`, hashes de tokens ni tokens en claro.

## Rate limits (valores iniciales, configurables)

| Endpoint | Por IP | Por cuenta/email |
|---|---|---|
| `POST /api/auth/register` | Límite estricto | n/a |
| `POST /api/auth/login` | Límite moderado | Retardo progresivo tras intentos fallidos |
| `POST /api/auth/password/forgot` | Límite estricto | Límite por correo |
| `POST /api/auth/email/verification/resend` | Límite estricto | Límite por usuario |

Los valores numéricos se fijan al implementar y se documentan aquí.

## Infraestructura

Endpoints operativos sin autenticación ni datos sensibles. No forman parte de la funcionalidad de autenticación.

### `GET /api/health/live`

Indica que el proceso está vivo.

- **200:** `{ "status": "ok" }`

### `GET /api/health/ready`

Indica que la API puede atender tráfico (comprueba la conexión a la base de datos).

- **200:** `{ "status": "ok" }`
- **503:** `{ "status": "unavailable" }`

## Fuera de esta versión

Gestión de usuarios por administradores, MFA, cambio de contraseña con sesión activa y el resto de módulos de la spec (s.28).
