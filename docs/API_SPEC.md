# API_SPEC.md

**Versión:** 0.2 (autenticación implementada, Sprint 1B)
**Fecha:** 2026-09-24
**Estado:** Describe la implementación actual. Los endpoints marcados "Diseñados, no implementados" son diseño aprobado, aún sin código.
**Alcance:** endpoints de autenticación e infraestructura. Casos, documentos, pagos y demás se añaden con su fase.
**Referencias:** ADR-002, ADR-003, `SECURITY_SPEC.md`, `DATABASE_SPEC.md`, `packages/contracts`.

Este documento se mantiene manualmente junto a los esquemas de `packages/contracts` (la API todavía no genera OpenAPI). Toda modificación de un endpoint actualiza este archivo en el mismo cambio.

## Convenciones

- Prefijo `/api`. JSON en request y response (`Content-Type: application/json`).
- Campos en `camelCase` en inglés. Identificadores UUID.
- Los cuerpos se validan con esquemas Zod estrictos de `packages/contracts`: un campo no declarado (por ejemplo `role`) produce `VALIDATION_ERROR`.

### Sesión y cookies (ADR-002)

- **Sesión opaca:** al iniciar sesión el servidor genera un token aleatorio de 256 bits. En la base de datos solo se guarda su hash SHA-256 (`sessions.token_hash`); el valor en claro solo existe en la cookie del cliente.
- **Cookie de sesión** `__Host-session`: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, sin atributo `Domain`. El prefijo `__Host-` se usa siempre (también en desarrollo local, donde los navegadores aceptan cookies `Secure` en `http://localhost`).
- **Cookie CSRF** `__Host-csrf`: `Secure`, `SameSite=Lax`, `Path=/`, sin `Domain` y **sin** `HttpOnly` a propósito (ver doble envío abajo).
- No se firman las cookies: el token es en sí un secreto de alta entropía validado contra su hash.
- **Expiración:** por inactividad (deslizante: cada petición autenticada la extiende) y absoluta (techo fijo que la actividad no puede extender). Valores por rol en `auth.session.ts`: `USER` 7 días de inactividad y 30 absolutos; roles internos más cortos (a confirmar, ADR-002).
- **Revocación:** una sesión revocada (`revoked_at`) deja de autenticar de inmediato. No se implementa rotación del identificador en este sprint (no existen aún cambio ni restablecimiento de contraseña, que son los eventos que la disparan).

### CSRF: doble envío de cookie (ADR-002)

- Al iniciar sesión se genera un token CSRF distinto del de sesión; se envía en la cookie `__Host-csrf` y solo su hash se guarda (`sessions.csrf_token_hash`).
- Las peticiones no seguras que usan una sesión válida deben enviar el mismo valor en el encabezado `X-CSRF-Token` **y** un `Origin` (o, en su defecto, `Referer`) igual a `APP_ORIGIN`. Falta de token, token distinto u origen distinto: `403 CSRF_INVALID`. Sin `Origin` ni `Referer` se rechaza (falla cerrado).
- Las peticiones previas a tener sesión (`register`, `login`) verifican `Origin`/`Referer` y no exigen token CSRF.
- `GET /api/auth/csrf` devuelve el token vigente.

### Eventos de auditoría (`audit_logs.action`)

| Evento | Cuándo | Actor | Metadata |
|---|---|---|---|
| `auth.register` | Registro (nuevo o duplicado) | Usuario creado; sin actor si el correo ya existía | `outcome`: `created` / `duplicate` |
| `auth.login.success` | Login correcto | Usuario | — |
| `auth.login.failed` | Credenciales inválidas, cuenta suspendida o rol bloqueado por la barrera MFA | Usuario si existe; sin actor si el correo no existe | `emailHash` (SHA-256 del correo normalizado); `reason: mfa_required_production` si aplica |
| `auth.logout` | Logout con una sesión válida | Usuario | — |
| `user.seeded` | Cuenta interna creada por el seed de desarrollo (`pnpm db:seed`, ADR-003); nunca en producción | Sin actor | `role` |

Nunca se registran contraseñas, tokens (en claro o hash) ni correos en claro. Todos los eventos guardan `requestId`, `ip` y `userAgent`.

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

`message` es para mostrar al usuario en español; `code` es estable, en inglés y está definido en `packages/contracts/src/error.ts`. `details` solo se usa en errores de validación (`field`, `issue`). Un encabezado `x-request-id` acompaña a cada respuesta.

### Códigos de error usados por la autenticación

| HTTP | `code` | Uso |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Cuerpo inválido o con campos no declarados |
| 401 | `UNAUTHENTICATED` | Sin sesión válida (ausente, revocada, expirada, o usuario suspendido) |
| 401 | `INVALID_CREDENTIALS` | Email o contraseña incorrectos, o cuenta suspendida (mismo mensaje y forma) |
| 403 | `CSRF_INVALID` | Token CSRF ausente o inválido, u origen no permitido |
| 403 | `FORBIDDEN` | Rol ADMIN o SUPER_ADMIN intentando iniciar sesión en producción sin MFA (ADR-002) |
| 404 | `NOT_FOUND` | Ruta inexistente |
| 429 | `RATE_LIMITED` | Límite por IP o por cuenta excedido (`Retry-After`) |
| 500 | `INTERNAL_ERROR` | Error inesperado, sin detalles internos |

`INVALID_OR_EXPIRED_TOKEN` existe en el contrato pero solo lo usarán los endpoints de verificación de email y recuperación de contraseña (no implementados).

## Endpoints

### `GET /api/auth/csrf`

Devuelve el token CSRF de la sesión actual. Requiere sesión.

- **200:** `{ "csrfToken": "string" }`
- **401:** `UNAUTHENTICATED`

**Diseño (Sprint 1B):** doble envío de cookie (*double-submit*). El token CSRF se genera al iniciar sesión y viaja en una cookie separada de la de sesión (`__Host-csrf`), legible por JavaScript a propósito — a diferencia de la cookie de sesión, que es `httpOnly`. El servidor solo guarda y compara el hash del token (`sessions.csrf_token_hash`), nunca el valor en claro. Este endpoint devuelve el token vigente de la cookie si coincide con la sesión, o genera y persiste uno nuevo si la cookie falta o no coincide (por ejemplo, tras perderla o en una sesión creada antes de esta rebanada).

Para peticiones sin sesión (registro, login) se comprueba `Origin`/`Referer` y no se exige token CSRF. Con sesión, los métodos no seguros comprueban `Origin`/`Referer` **y** `X-CSRF-Token`.

### `POST /api/auth/register`

Crea una cuenta con rol `USER`.

- **Body:** `{ "email": "string", "password": "string", "fullName": "string" }`
- **Reglas:** solo se aceptan estos tres campos (`role` u otro campo adicional produce `VALIDATION_ERROR`); email válido y normalizado; contraseña de 12 a 128 caracteres; `fullName` no vacío.
- **202:** `{ "status": "accepted" }`. La respuesta es idéntica exista o no el correo, para evitar enumeración; si ya existe, no se crea una segunda cuenta.
- **400:** `VALIDATION_ERROR`
- **403:** `CSRF_INVALID` (origen no permitido)
- **429:** `RATE_LIMITED`
- **Auditoría:** `auth.register` (metadata `outcome: "created" | "duplicate"`)
- **Nota (Sprint 1B):** no se envía email de verificación todavía; `EmailVerificationToken` se usa en una rebanada posterior (`POST /api/auth/verify-email`, `POST /api/auth/resend-verification`).

### `POST /api/auth/login`

Inicia sesión y establece las cookies de sesión y CSRF.

- **Body:** `{ "email": "string", "password": "string" }`
- **200:** `{ "user": User }` más `Set-Cookie` de sesión y de CSRF.
- **401:** `INVALID_CREDENTIALS` (mismo mensaje y forma para correo inexistente, contraseña errónea o cuenta suspendida)
- **403:** `CSRF_INVALID` (origen no permitido) / `FORBIDDEN` (rol ADMIN o SUPER_ADMIN en producción sin MFA, ADR-002)
- **429:** `RATE_LIMITED` (límite por IP o por cuenta, con `Retry-After`)
- **Auditoría:** `auth.login.success`, `auth.login.failed`

### `POST /api/auth/logout`

Revoca la sesión actual.

- **204** — también cuando la sesión ya no era válida (ninguna sesión, ya revocada o expirada): el logout es siempre seguro. En ese caso no se exige CSRF, porque no hay nada que proteger.
- Con una sesión válida, requiere `Origin` correcto y `X-CSRF-Token`: **403** `CSRF_INVALID` si faltan o no coinciden.
- **Auditoría:** `auth.logout` (solo cuando había una sesión que revocar)

### `GET /api/auth/me`

Devuelve el usuario autenticado. Autorizado por la policy del módulo de autenticación (`user:read` sobre el propio usuario, ADR-003).

- **200:** `{ "user": User }`
- **401:** `UNAUTHENTICATED` — sin sesión, sesión inválida/expirada, o usuario suspendido.
- **404:** `NOT_FOUND` si la policy denegara la lectura (ADR-003: nunca 403, para no confirmar la existencia del recurso). Con la matriz del Sprint 1 no ocurre para el propio usuario.

### Diseñados, no implementados en Sprint 1B

Estos endpoints están definidos como parte del diseño aprobado, pero esta rebanada no los implementa (quedan para las rebanadas indicadas en la sección "Fuera de esta versión" al final del documento):

#### `POST /api/auth/logout-all`

Revoca todas las sesiones del usuario. Requiere sesión y CSRF. **204**. Auditoría: `auth.logout_all`.

#### `GET /api/auth/sessions`

Lista las sesiones activas del usuario (solo las propias). **200:** `{ "sessions": [Session] }`, con la sesión actual marcada.

#### `DELETE /api/auth/sessions/:sessionId`

Revoca una sesión propia. Requiere sesión y CSRF. **204**. **404** también cuando la sesión pertenece a otro usuario (protección IDOR, ADR-003). Auditoría: `auth.session.revoked`.

#### `POST /api/auth/email/verify`

Confirma el email con el token recibido.

- **Body:** `{ "token": "string" }`
- **204**
- **400:** `INVALID_OR_EXPIRED_TOKEN` (token inexistente, usado o expirado, sin distinguirlos)
- **Auditoría:** `auth.email.verified`

#### `POST /api/auth/email/verification/resend`

Reenvía el email de verificación. Requiere sesión y CSRF.

- **202:** `{ "status": "accepted" }`
- **429:** `RATE_LIMITED`

#### `POST /api/auth/password/forgot`

Solicita la recuperación de contraseña.

- **Body:** `{ "email": "string" }`
- **202:** `{ "status": "accepted" }`, siempre, exista o no la cuenta.
- **429:** `RATE_LIMITED`
- **Auditoría:** `auth.password.reset_requested`

#### `POST /api/auth/password/reset`

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

## Rate limits (Sprint 1B, valores iniciales)

Los límites por IP son en memoria, por proceso (SECURITY_SPEC.md — no compartidos entre instancias; migrar a un almacén compartido antes de escalar horizontalmente, sin introducir Redis sin un ADR). El límite por cuenta se deriva de los eventos `auth.login.failed` de `audit_logs` (ADR-002), así que se guarda en PostgreSQL. La IP es la del par TCP salvo proxies listados en `API_TRUST_PROXY`; detrás del proxy web de ADR-002, y hasta que exista un proxy de borde, el límite por IP es global (SECURITY_SPEC.md §7).

| Endpoint | Por IP | Por cuenta |
|---|---|---|
| `POST /api/auth/register` | 5 cada 10 min | n/a |
| `POST /api/auth/login` | 10 cada 10 min | 5 intentos fallidos cada 15 min (`RATE_LIMITED`, `Retry-After`) |
| `POST /api/auth/password/forgot` | Pendiente (endpoint no implementado aún) | Pendiente |
| `POST /api/auth/email/verification/resend` | Pendiente (endpoint no implementado aún) | Pendiente |

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

Gestión de usuarios por administradores, MFA, cambio de contraseña con sesión activa, verificación de email, recuperación de contraseña, `logout-all`, listado y revocación individual de sesiones (diseñados arriba, no implementados en Sprint 1B) y el resto de módulos de la spec (s.28).
