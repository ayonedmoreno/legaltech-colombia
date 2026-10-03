# API_SPEC.md

**Versión:** 0.11 (OCR: lectura del texto por el propietario; Fase 3)
**Fecha:** 2026-10-01
**Estado:** Aprobado (cierre de las Fases 1 y 2; rebanadas 1 y 2 de la Fase 3, 2026-09-27 y 2026-09-28). Describe la implementación actual. En la sección «OCR del documento» cada endpoint indica si está implementado o solo previsto.
**Alcance:** autenticación, infraestructura, casos (crear, listar y consultar los propios) y documentos del caso (subir, listar y descargar los propios; reprocesamiento administrativo de un tratamiento fallido). OCR: estados, lectura del texto por el propietario y reprocesamiento ADMIN. Pagos y demás se añaden con su fase.
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
- **Expiración:** por inactividad (deslizante: cada petición autenticada la extiende) y absoluta (techo fijo que la actividad no puede extender). Valores por rol en `auth.session.ts`: `USER` 7 días de inactividad y 30 absolutos; roles internos más cortos, hoy `PROFESSIONAL` y `ADMIN` 1 día y 7 días, `SUPER_ADMIN` 12 h y 3 días (a confirmar, ADR-002).
- **Revocación:** una sesión revocada (`revoked_at`) deja de autenticar de inmediato. Restablecer la contraseña revoca todas las sesiones del usuario (motivo `PASSWORD_RESET`). La rotación del identificador (ADR-002) se describe en `POST /api/auth/session/rotate`; al iniciar sesión, la sesión que ya tuviera el navegador se revoca con motivo `ROTATED`.

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
| `auth.login.rate_limited` | Intento de login rechazado (429) por el límite por cuenta; no cuenta como fallo. Se escribe en la misma transacción que decide el bloqueo, con la hora de PostgreSQL. No se registra por el 429 del límite por IP ni por el 503 | Sin actor | `emailHash` (SHA-256 del correo normalizado), `retryAfterSeconds` |
| `auth.logout` | Logout con una sesión válida | Usuario | — |
| `auth.password.reset_requested` | Solicitud de recuperación de contraseña (`POST /api/auth/password/forgot`), exista o no la cuenta; cuenta para el límite por email | Usuario si existe; sin actor si el correo no existe | `emailHash` (SHA-256 del correo normalizado) |
| `auth.password.reset_completed` | Contraseña restablecida con un token válido (`POST /api/auth/password/reset`) | Usuario | — |
| `auth.email.verified` | Email verificado con un token válido (`POST /api/auth/email/verify`) | Usuario verificado | — |
| `auth.logout_all` | Cierre de todas las sesiones del usuario (`POST /api/auth/logout-all`) | Usuario | — |
| `auth.session.revoked` | Revocación de una sesión propia por ID (`DELETE /api/auth/sessions/:sessionId`) | Usuario | — (la sesión revocada es la entidad) |
| `case.created` | Creación de un caso (`POST /api/cases`), en la misma transacción que el caso y su historial | Usuario propietario | — (el caso es la entidad y `case_id`; `new_value`: `type`, `status`) |
| `document.uploaded` | Documento subido a un caso propio (`POST /api/cases/:caseId/documents`), en la misma transacción que la fila del documento | Usuario propietario | — (el documento es la entidad y el caso, `case_id`; `new_value`: `fileType`, `fileSize`, `status`; nunca el nombre del archivo) |
| `document.scan_clean` | El tratamiento de seguridad terminó sin amenazas (y, en JPEG o PNG, con su copia sin la metadata que retira la política): el documento pasa a `CLEAN`. Lo escribe el worker en la misma transacción que el estado | Sin actor (sistema) | — (documento y `case_id`; `new_value`: `status`) |
| `document.scan_infected` | El antivirus detectó una amenaza: el documento pasa a `INFECTED` | Sin actor (sistema) | — (`new_value`: `status`, `signature`) |
| `document.scan_failed` | El tratamiento no se pudo completar tras agotar los intentos: el documento pasa a `SCAN_FAILED` | Sin actor (sistema) | — (`new_value`: `status`, `attempts`) |
| `document.reprocess_requested` | Un ADMIN pide reprocesar un documento `SCAN_FAILED` (`POST /api/admin/documents/:documentId/reprocess`), en la misma transacción que el job `document.reprocess` | ADMIN | `reason` (la justificación; nunca el nombre del archivo) |
| `document.scan_reprocessed` | El worker devuelve a `PENDING_SCAN` un documento que seguía `SCAN_FAILED`, con una ronda nueva de intentos y su job `document.scan`, en la misma transacción | Sin actor (sistema) | — (`new_value`: `status`, `previousAttempts`) |
| `document.ocr_completed` | El OCR de un documento terminó con texto: `ocr_status` pasa a `COMPLETED`. Lo escribe el worker con su `OcrResult`, en la misma transacción | Sin actor (sistema) | — (`new_value`: `status`, `pages`, `attempts`; nunca texto) |
| `document.ocr_failed` | El OCR falló de forma permanente, agotó sus intentos o se abandonó: `ocr_status` pasa a `FAILED` | Sin actor (sistema) | — (`new_value`: `status`, `code` normalizado, `attempts`) |
| `document.ocr_reprocess_requested` | Un ADMIN pide reprocesar un OCR `FAILED` (`POST /api/admin/documents/:documentId/ocr/reprocess`), en la misma transacción que el job `document.ocr_reprocess` | ADMIN | `reason` (la justificación; nunca el nombre del archivo ni texto) |
| `document.ocr_reprocessed` | El worker devuelve a `PENDING` un OCR que seguía `FAILED`, con una ronda nueva de intentos y su job `document.ocr`, en la misma transacción | Sin actor (sistema) | — (`new_value`: `status`, `previousAttempts`) |
| `user.seeded` | Cuenta interna creada por el seed de desarrollo (`pnpm db:seed`, ADR-003); nunca en producción | Sin actor | `role` |

Nunca se registran contraseñas, tokens (en claro o hash) ni correos en claro. Los eventos de una petición HTTP guardan `requestId`, `ip` y `userAgent`; los del sistema sin petición (`document.scan_*`, escritos por el worker, y `user.seeded`) los dejan vacíos.

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

`message` es para mostrar al usuario en español; `code` es estable, en inglés y está definido en `packages/contracts/src/error.ts`. `details` solo se usa en errores de validación (`field`, `issue`). Un encabezado `x-request-id` acompaña a cada respuesta: el que envió el cliente si tiene 1 a 64 caracteres de `[A-Za-z0-9._-]`, o uno generado por la API. Es un identificador de correlación, no una prueba de autenticidad.

### Códigos de error

| HTTP | `code` | Uso |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Cuerpo inválido o con campos no declarados |
| 401 | `UNAUTHENTICATED` | Sin sesión válida (ausente, revocada, expirada, o usuario suspendido) |
| 401 | `INVALID_CREDENTIALS` | Email o contraseña incorrectos, o cuenta suspendida (mismo mensaje y forma) |
| 403 | `CSRF_INVALID` | Token CSRF ausente o inválido, u origen no permitido |
| 403 | `FORBIDDEN` | Rol ADMIN o SUPER_ADMIN intentando iniciar sesión en producción sin MFA (ADR-002); subir un documento a un caso propio que no está en `DRAFT` o que excedería la cuota de espacio del usuario; descargar un documento propio que no está `CLEAN`; reprocesar un documento que no está `SCAN_FAILED` |
| 404 | `NOT_FOUND` | Ruta inexistente, o recurso ajeno, inexistente o con identificador inválido (IDOR, ADR-003) |
| 413 | `PAYLOAD_TOO_LARGE` | Cuerpo mayor que el límite del endpoint (por ejemplo, un documento de más de 10 MiB) |
| 415 | `VALIDATION_ERROR` | `Content-Type` no admitido por el endpoint |
| 429 | `RATE_LIMITED` | Límite por IP o por cuenta excedido (`Retry-After`); mismo mensaje en ambos casos |
| 503 | `SERVICE_UNAVAILABLE` | No se pudo evaluar el límite por cuenta del login (bloqueo, conexión o transacción no disponibles); el intento no se concede (`Retry-After: 1`), sin detalles internos. También: el almacenamiento de documentos falla o no responde al subir un documento (no se guarda nada) |
| 500 | `INTERNAL_ERROR` | Error inesperado, sin detalles internos |

`INVALID_OR_EXPIRED_TOKEN` lo usan `POST /api/auth/email/verify` y `POST /api/auth/password/reset` para un token desconocido, usado o caducado (misma respuesta en los tres casos).
`SERVICE_UNAVAILABLE` existe en el contrato; su mensaje es "Servicio no disponible temporalmente. Inténtalo más tarde." y lo usa el login cuando no puede evaluar el límite por cuenta (D3-2).

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
- **Verificación inicial:** una cuenta nueva registra, en la misma transacción, el email de verificación inicial en el outbox (decisión P6). El token se genera al despachar el email; un registro duplicado no registra nada.

### `POST /api/auth/login`

Inicia sesión y establece las cookies de sesión y CSRF.

- **Body:** `{ "email": "string", "password": "string" }`
- **200:** `{ "user": User }` más `Set-Cookie` de sesión y de CSRF.
- **401:** `INVALID_CREDENTIALS` (mismo mensaje y forma para correo inexistente, contraseña errónea o cuenta suspendida)
- **403:** `CSRF_INVALID` (origen no permitido) / `FORBIDDEN` (rol ADMIN o SUPER_ADMIN en producción sin MFA, ADR-002)
- **429:** `RATE_LIMITED` (límite por IP o por cuenta, con `Retry-After`; mismo mensaje en ambos casos)
- **503:** `SERVICE_UNAVAILABLE` (no se pudo aplicar el límite por cuenta; `Retry-After: 1`; el intento no se concede)
- **Rotación al iniciar sesión (ADR-002; decisión P12):** si la petición trae la cookie de una sesión existente, tras crear la nueva esa sesión anterior se revoca con motivo `ROTATED`. Un login fallido no la toca.
- **Auditoría:** `auth.login.success`, `auth.login.failed`, `auth.login.rate_limited`

### `POST /api/auth/logout`

Revoca la sesión actual.

- **204** — también cuando la sesión ya no era válida (ninguna sesión, ya revocada o expirada): el logout es siempre seguro. En ese caso no se exige CSRF, porque no hay nada que proteger.
- Con una sesión válida, requiere `Origin` correcto y `X-CSRF-Token`: **403** `CSRF_INVALID` si faltan o no coinciden.
- **Auditoría:** `auth.logout` (solo cuando había una sesión que revocar), en la misma transacción que la revocación: se guardan ambas o ninguna. Si otra petición la revocó entretanto, no se escribe un segundo evento.

### `GET /api/auth/me`

Devuelve el usuario autenticado. Autorizado por la policy del módulo de autenticación (`user:read` sobre el propio usuario, ADR-003).

- **200:** `{ "user": User }`
- **401:** `UNAUTHENTICATED` — sin sesión, sesión inválida/expirada, o usuario suspendido.
- **404:** `NOT_FOUND` si la policy denegara la lectura (ADR-003: nunca 403, para no confirmar la existencia del recurso). Con la matriz del Sprint 1 no ocurre para el propio usuario.

### `GET /api/auth/sessions`

Lista las sesiones activas del usuario autenticado, solo las propias (`session:list`, ADR-003): no revocadas y dentro de su expiración por inactividad y absoluta. La sesión con la que se hace la petición se marca con `current: true`.

- **200:** `{ "sessions": [Session] }`, de la usada más recientemente a la menos.
- **401:** `UNAUTHENTICATED` — sin sesión, sesión inválida/expirada, o usuario suspendido.
- **404:** `NOT_FOUND` si la policy denegara el listado (ADR-003). Con la matriz del Sprint 1 no ocurre para el propio usuario.
- Petición segura (GET): no exige token CSRF. Sin evento de auditoría.
- Una sesión ya rotada, aunque siga en su periodo de gracia, no se lista: la sustituye la nueva.

### `DELETE /api/auth/sessions/:sessionId`

Revoca una sesión propia activa (`session:revoke`, ADR-003), con motivo `LOGOUT`. Requiere sesión y CSRF; ambos se comprueban antes de mirar la sesión indicada.

- **204:** sin cuerpo. Si la sesión revocada es la de la petición, además se borran las cookies de sesión y CSRF, como en `POST /api/auth/logout`.
- **401:** `UNAUTHENTICATED` — sin sesión válida.
- **403:** `CSRF_INVALID` — token CSRF u origen incorrectos.
- **404:** `NOT_FOUND`, con la misma respuesta cuando la sesión pertenece a otro usuario, no existe, no es un identificador válido o ya está revocada o expirada (protección IDOR, ADR-003).
- **Auditoría:** `auth.session.revoked`, con el usuario como actor y la sesión revocada como entidad, en la misma transacción que la revocación (ambas o ninguna; una revocación concurrente de la misma sesión responde 404 sin evento).

### `POST /api/auth/email/verify`

Confirma el email con el token del enlace de verificación. Petición previa a tener sesión, como `register` y `login`: verifica `Origin`/`Referer` y no exige token CSRF.

- **Body:** `{ "token": "string" }` (1 a 256 caracteres).
- **204:** el token existía, no estaba usado ni caducado: queda usado y el email, verificado.
- **400:** `INVALID_OR_EXPIRED_TOKEN` — token inexistente, usado o caducado, sin distinguirlos; `VALIDATION_ERROR` si el cuerpo no es válido.
- **403:** `CSRF_INVALID` — origen no permitido.
- **Auditoría:** `auth.email.verified`, en la misma transacción que el uso del token y la verificación: se guarda todo o nada (si falla, el enlace sigue siendo válido).
- **Enlace del email:** `APP_ORIGIN/verificar-correo#token=…`. El token va en el fragmento de la URL, que el navegador nunca envía a ningún servidor; la página lo lee y lo envía en el cuerpo de esta petición (decisión P14).
- **Token:** 256 bits, solo se guarda su hash, un solo uso, caduca a las 24 h. Se genera al despachar el email (outbox, decisión C2); uno nuevo invalida los anteriores sin usar (decisión P7).

### `POST /api/auth/email/verification/resend`

Registra un nuevo email de verificación para el usuario de la sesión. Requiere sesión y CSRF. Si el email ya está verificado, no registra nada y responde igual.

- **202:** `{ "status": "accepted" }`.
- **401:** `UNAUTHENTICATED` — sin sesión válida.
- **403:** `CSRF_INVALID`.
- **429:** `RATE_LIMITED`, con `Retry-After` (límites en la tabla de rate limits).
- **503:** `SERVICE_UNAVAILABLE`, con `Retry-After: 1`, si no se pudo evaluar el límite por cuenta (mismo criterio que el login, D3).
- Sin evento de auditoría propio.

### `POST /api/auth/session/rotate`

Rotación periódica del identificador de sesión (ADR-002: "periódicamente durante el uso"; decisiones P9–P11 del Sprint 1B). Requiere sesión y CSRF (`session:revoke` sobre la propia sesión, ADR-003).

- **200:** `{ "rotated": boolean }`.
  - `true`: la sesión tenía ya la antigüedad de su intervalo de rotación. Se crea una sesión nueva (identificador y token CSRF nuevos, con el **mismo techo absoluto**: la rotación nunca alarga la vida de la sesión) y la respuesta fija las cookies nuevas de sesión y CSRF.
  - `false`: todavía no tocaba, o la sesión ya había sido rotada (por ejemplo, por otra petición simultánea); no cambia nada.
- **Intervalo:** 1 h para `USER`; 15 min para `PROFESSIONAL`, `ADMIN` y `SUPER_ADMIN`, contado desde la creación de la sesión.
- **Gracia:** la sesión anterior sigue siendo válida 60 s tras la rotación, para las peticiones ya en curso; después deja de autenticar. Durante la gracia no está revocada, así que `logout`, `logout-all` y el restablecimiento de contraseña también la cortan. En la siguiente rotación del usuario, las sesiones con la gracia ya cumplida se revocan con motivo `ROTATED`.
- **Concurrencia:** una sola sentencia condicional marca la sesión como rotada; dos peticiones simultáneas no pueden rotarla dos veces.
- **401:** `UNAUTHENTICATED`. **403:** `CSRF_INVALID`.
- **Auditoría:** ninguna (decisión P9): la rotación es un mecanismo automático, no una acción del usuario.
- **Disparo:** la web lo llama desde el navegador al abrir `/panel` y cada 5 minutos mientras está abierto; la API decide si toca. La comprobación de sesión que hace el servidor web (`GET /api/auth/me`) nunca rota, porque su respuesta no llega al navegador.

### `POST /api/auth/logout-all`

Revoca todas las sesiones del usuario que no estén revocadas, incluida la de la petición, con motivo `LOGOUT_ALL` (`session:revoke` sobre las propias, ADR-003). Las ya revocadas conservan su primera revocación. Requiere sesión y CSRF.

- **204:** sin cuerpo; se borran las cookies de sesión y CSRF.
- **401:** `UNAUTHENTICATED` — sin sesión válida (también al repetir la llamada con la sesión ya revocada).
- **403:** `CSRF_INVALID` — token CSRF u origen incorrectos; no se revoca nada.
- **Auditoría:** `auth.logout_all`, con el usuario como actor y como entidad, en la misma transacción que las revocaciones (todas o ninguna); solo si se revocó al menos una sesión.

### `POST /api/auth/password/forgot`

Solicita la recuperación de contraseña. Petición previa a tener sesión: verifica `Origin`/`Referer`, no exige token CSRF.

- **Body:** `{ "email": "string" }`.
- **202:** `{ "status": "accepted" }`, siempre, exista o no la cuenta. Si existe, se registra en el outbox el email de restablecimiento; su token se genera al despacharlo.
- **400:** `VALIDATION_ERROR`. **403:** `CSRF_INVALID` (origen no permitido).
- **429:** `RATE_LIMITED`, con `Retry-After` (límites en la tabla de rate limits); el límite por email se aplica igual a correos inexistentes.
- **503:** `SERVICE_UNAVAILABLE`, con `Retry-After: 1`, si no se pudo evaluar el límite por email (mismo criterio que el login, D3).
- **Auditoría:** `auth.password.reset_requested` (también para correos inexistentes, con el correo solo como hash). Una solicitud rechazada por el límite no se audita ni cuenta.
- **Enlace del email:** `APP_ORIGIN/restablecer-contrasena#token=…` (token en el fragmento, decisión P14).
- **Token:** 256 bits, solo se guarda su hash, un solo uso, caduca a los 30 min; uno nuevo invalida los anteriores sin usar (decisión P7).

### `POST /api/auth/password/reset`

Establece una nueva contraseña con el token del enlace. Petición previa a tener sesión: verifica `Origin`/`Referer`, no exige token CSRF.

- **Body:** `{ "token": "string", "newPassword": "string" }` (contraseña de 12 a 128 caracteres).
- **204:** en una sola transacción, el token queda usado (y los demás tokens de restablecimiento del usuario, invalidados), la contraseña se sustituye, **todas las sesiones del usuario se revocan** con motivo `PASSWORD_RESET`, se registra el aviso por email y se audita. No inicia sesión.
- **400:** `INVALID_OR_EXPIRED_TOKEN` — token inexistente, usado o caducado, sin distinguirlos, sin cambiar nada; `VALIDATION_ERROR` si el cuerpo no es válido.
- **403:** `CSRF_INVALID` (origen no permitido).
- **429:** `RATE_LIMITED` por IP: cada petición calcula el hash Argon2id de la contraseña nueva, exista o no el token.
- **Auditoría:** `auth.password.reset_completed`. El aviso por email no lleva ningún token.

### `POST /api/cases`

Crea un caso del usuario autenticado (`case:create`, ADR-003; `PROJECT_SPEC.md` s.9 paso 2). Requiere sesión y CSRF. El caso nace en `DRAFT`; en la misma transacción se escriben su historial (`NULL → DRAFT`) y el evento de auditoría.

- **Cuerpo:** `{ "type": CaseType }`. Cualquier otro campo (`status`, `userId`…) produce `VALIDATION_ERROR`: el estado y el propietario los fija el servidor.
- **201:** `{ "case": Case }`.
- **400:** `VALIDATION_ERROR`.
- **401:** `UNAUTHENTICATED`.
- **403:** `CSRF_INVALID`.
- **404:** `NOT_FOUND` si la policy lo deniega: en esta rebanada solo el rol `USER` crea casos (PROFESSIONAL, ADMIN y SUPER_ADMIN quedan fuera hasta sus fases).
- No exige email verificado (ADR-002 solo lo exige para acciones sensibles; crear un caso no lo es en esta rebanada).
- **Auditoría:** `case.created`.

### `GET /api/cases`

Lista los casos del usuario autenticado, solo los propios (`case:list`), del más reciente al más antiguo.

- **200:** `{ "cases": [Case] }`.
- **401:** `UNAUTHENTICATED`.
- **404:** `NOT_FOUND` si la policy lo deniega (roles distintos de `USER` en esta rebanada).
- Petición segura (GET): sin CSRF ni evento de auditoría.

### `GET /api/cases/:caseId`

Devuelve un caso propio con su historial de estados (`case:read`).

- **200:** `{ "case": Case, "statusHistory": [CaseStatusChange] }`, historial en orden cronológico.
- **401:** `UNAUTHENTICATED`.
- **404:** `NOT_FOUND`, con la misma respuesta cuando el caso pertenece a otro usuario, no existe o el identificador no es un UUID (IDOR, ADR-003), y cuando la policy lo deniega.
- Petición segura (GET): sin CSRF ni evento de auditoría.

**Fuera de esta rebanada:** `PATCH /api/cases/:caseId` (`PROJECT_SPEC.md` s.28), la cancelación y cualquier otra transición de estado (la máquina de estados está documentada en `DATABASE_SPEC.md`; cada transición se expone en la fase que posee su disparador), el cuestionario dinámico y los endpoints de documentos, análisis, precio, pago y actuaciones.

### `POST /api/cases/:caseId/documents`

Sube un documento a un caso propio (`document:upload`; `PROJECT_SPEC.md` s.9 paso 4, s.16). Requiere sesión y CSRF, que se comprueban **antes** de leer el cuerpo.

- **Cuerpo:** el archivo en bruto, con `Content-Type: application/octet-stream`.
- **Encabezado `X-File-Name`:** nombre original del archivo, codificado con `encodeURIComponent`. Obligatorio; de 1 a 255 caracteres una vez decodificado, sin `/`, `\` ni caracteres de control. No va en la URL, para que no aparezca en logs.
- **Tipos admitidos:** PDF, JPEG y PNG, determinados por la firma del contenido (magic bytes), no por la extensión ni por el `Content-Type`.
- **Tamaño máximo:** 10 MiB (`DOCUMENT_MAX_BYTES`, en `packages/contracts`), un único límite para toda la plataforma (decisión del 2026-10-01): valor técnico provisional —los documentos exigen un límite (`SECURITY_SPEC.md` §11) pero no fijan la cifra— que no se puede configurar por encima. La web lo comprueba antes de enviar el archivo. Su proxy `/api/*` (ADR-002) responde él mismo, con este mismo 413, a una subida cuyo `Content-Length` declarado supere el límite (reenviarla hacía que un archivo muy grande acabara en 500 del proxy); el resto lo reenvía con un búfer algo mayor (11 MiB, derivado de la misma constante) y la API lo vuelve a comprobar.
- **Cuota:** 100 MiB por usuario (`DOCUMENT_QUOTA_BYTES`): la suma del tamaño de sus documentos, en todos sus casos y en cualquier estado; un documento cuenta mientras existe. Se mira antes de escribir en el almacenamiento y se comprueba de nuevo, bajo un bloqueo por usuario, al escribir la fila, así que dos subidas simultáneas no pueden superarla. Valor técnico provisional; sin cuotas por IP ni por periodo. Mientras no exista la eliminación de documentos, cuenta todo documento almacenado, también `INFECTED` y `SCAN_FAILED`; cómo se libera la cuota queda pendiente de la futura funcionalidad de eliminación y retención, así que los 100 MiB no son todavía una cuota acumulativa permanente decidida por producto.
- **Almacenamiento:** las peticiones al almacenamiento tienen timeouts (5 s para conectar, 30 s de inactividad y 45 s por petición) y los reintentos estándar del SDK. Si guardar el archivo falla o caduca, **503** `SERVICE_UNAVAILABLE` ("Servicio no disponible temporalmente. Inténtalo más tarde.") y no queda ningún documento; el objeto, que pudo llegar a escribirse, se borra. Si después falla la escritura en la base de datos, el archivo también se borra. Si un borrado falla, el objeto queda sin documento (nunca se sirve) y se registra en el log como `storage.orphan_object`, con su clave, para reconciliarlo.
- **Estado del caso:** solo en `DRAFT`.
- **201:** `{ "document": Document }`, con `status: "PENDING_SCAN"` y `ocrStatus: "NOT_STARTED"`. La respuesta no espera al antivirus: en la misma transacción que la fila se encola el job `document.scan`, que procesa el worker.
- **400:** `VALIDATION_ERROR` — cuerpo vacío, falta `X-File-Name` o es inválido, o el contenido no es PDF, JPEG ni PNG.
- **401:** `UNAUTHENTICATED`. **403:** `CSRF_INVALID`.
- **403:** `FORBIDDEN` — el caso propio no está en `DRAFT` (no ocurre todavía: no hay transiciones), o la subida excedería la cuota ("Has alcanzado el espacio máximo para tus documentos (100 MB)."); no se guarda nada.
- **503:** `SERVICE_UNAVAILABLE` — el almacenamiento falló o no respondió; no se guarda nada.
- **404:** `NOT_FOUND` — caso ajeno, inexistente o con identificador inválido, o policy denegada (roles distintos de `USER`).
- **413:** `PAYLOAD_TOO_LARGE`. **415:** `VALIDATION_ERROR` si el `Content-Type` no es `application/octet-stream`.
- **Auditoría:** `document.uploaded`.

### `GET /api/cases/:caseId/documents`

Lista los documentos de un caso propio (`document:list`), del más reciente al más antiguo.

- **200:** `{ "documents": [Document] }`. **401:** `UNAUTHENTICATED`. **404:** `NOT_FOUND` (como arriba).
- Petición segura (GET): sin CSRF ni evento de auditoría.

### `GET /api/cases/:caseId/documents/:documentId/download`

Autoriza la descarga de un documento propio (`document:download`) y devuelve una URL prefirmada de vida corta del almacenamiento privado (ARCHITECTURE_REPORT §2; `SECURITY_SPEC.md` §11).

- **Solo un documento `CLEAN`.** Se descarga la versión que pasó el tratamiento de seguridad: la copia sin la metadata que retira la política para JPEG y PNG (`DATABASE_SPEC.md`, «Metadata»), el original intacto para PDF.
- **200:** `{ "url": "https://…", "expiresAt": "ISO-8601" }`. La URL caduca a los 60 s (`DOCUMENT_DOWNLOAD_URL_TTL_SECONDS`) y fuerza `Content-Disposition: attachment` con el nombre original y el `Content-Type` del tipo detectado al subirlo.
- **401:** `UNAUTHENTICATED`. **404:** `NOT_FOUND` — documento de otro caso, caso ajeno o inexistente, o identificadores inválidos.
- **403:** `FORBIDDEN` — documento propio que no está `CLEAN` (`UPLOADED`, `PENDING_SCAN`, `SCANNING`, `INFECTED` o `SCAN_FAILED`), con un único mensaje genérico; no se genera ninguna URL. El propietario ya ve el estado en el listado.
- Petición segura (GET): sin CSRF ni evento de auditoría (como las demás lecturas del propietario).

### `POST /api/admin/documents/:documentId/reprocess`

Pide que un documento cuyo tratamiento de seguridad falló (`SCAN_FAILED`) se trate otra vez (`document:reprocess`; decisión del 2026-10-01). Solo `ADMIN` (`PROJECT_SPEC.md` s.6: "administrar documentos"): es una acción administrativa sobre datos de otro usuario, justificada y auditada (ADR-003). Requiere sesión y CSRF; la policy se comprueba antes de leer la petición.

- **Cuerpo:** `{ "reason": "string" }`: la justificación, de 1 a 500 caracteres. Cualquier otro campo produce `VALIDATION_ERROR`.
- **202:** `{ "status": "accepted" }`. En una transacción se escriben `document.reprocess_requested` (actor ADMIN, con la justificación) y el job `document.reprocess`. El worker devuelve el documento a `PENDING_SCAN` solo si sigue `SCAN_FAILED`, con una ronda nueva de 5 intentos, y lo trata de nuevo (`DATABASE_SPEC.md`). Nunca reprocesa un `INFECTED`.
- **400:** `VALIDATION_ERROR` — sin justificación válida.
- **401:** `UNAUTHENTICATED`. **403:** `CSRF_INVALID`.
- **403:** `FORBIDDEN` — el documento no está `SCAN_FAILED` (`INFECTED`, `CLEAN`, pendiente o en tratamiento): solo se reintenta un tratamiento fallido.
- **404:** `NOT_FOUND` — cualquier rol distinto de `ADMIN` (también un `USER`, aunque sea el propietario del documento), documento inexistente o identificador inválido.
- No es automático: cada reprocesamiento lo pide una persona y queda auditado; no hay reintentos ilimitados. En producción no está disponible mientras un ADMIN no pueda iniciar sesión (barrera MFA, ADR-002).

**Fuera de esta rebanada:** OCR, limpieza de metadata de PDF (decisión pendiente), versiones de documentos (`DocumentVersion`), borrado de documentos y cualquier transición de estado del caso.

### OCR del documento (diseño aprobado el 2026-10-01; primera parte implementada el 2026-10-02)

Diseño aprobado (decisiones OCR-A1 a OCR-A15, `ARCHITECTURE_REPORT.md` §5; modelo y estados en `DATABASE_SPEC.md`, «OCR del documento»).

**El OCR no está activo:** no hay proveedor (P4). Por eso ningún documento tiene hoy texto ni un OCR `FAILED`. El texto se guarda en PostgreSQL (OCR-A10.5) y no cuenta para la cuota de 100 MiB.

#### `POST /api/admin/documents/:documentId/ocr/reprocess` (implementado)

`document:reprocess_ocr`; solo `ADMIN`. Mismo diseño que el reprocesamiento del escaneo:
- **Petición:** sesión y CSRF; la policy se comprueba antes de leer la petición. Cuerpo `{ "reason": "string" }`, de 1 a 500 caracteres; cualquier otro campo produce `VALIDATION_ERROR`.
- **202:** `{ "status": "accepted" }`. En una transacción se escriben `document.ocr_reprocess_requested` (actor ADMIN, con la justificación) y el job `document.ocr_reprocess`. El worker solo actúa si el documento sigue `CLEAN` con el OCR `FAILED`: lo devuelve a `PENDING` con una ronda nueva de intentos (una ejecución nueva).
- **400:** `VALIDATION_ERROR`. **401:** `UNAUTHENTICATED`. **403:** `CSRF_INVALID`.
- **403:** `FORBIDDEN` si el documento no es `CLEAN` con el OCR `FAILED`.
- **404:** cualquier otro rol (también el `USER` propietario), documento inexistente o identificador inválido.
- No da acceso al contenido ni al texto, y nunca es automático.

#### `GET /api/cases/:caseId/documents/:documentId/ocr` (implementado)

`document:read_ocr`; solo el `USER` propietario. Respuesta con `Cache-Control: no-store`.
- **200:** `{ "ocrStatus": "...", "pages": [{ "number": 1, "text": "string" }] }`.
  - `pages` solo trae texto si `ocrStatus` es `COMPLETED`, y es el de la ejecución vigente (la última `COMPLETED`).
  - En cualquier otro estado, `pages` es `[]`. **Una lista vacía significa «no hay texto disponible en este estado», no que el documento tenga cero páginas.** Tras un reprocesamiento que termina `FAILED` no se devuelve el texto de una ejecución anterior.
- **El texto es no verificado y no confiable** (OCR-A3, OCR-A13):
  - puede contener errores, y la interfaz muestra siempre ese aviso;
  - se trata como texto y nunca como HTML o instrucciones;
  - no se registra en logs.
- **401:** `UNAUTHENTICATED`.
- **404:** cualquier otro rol (`PROFESSIONAL`, `ADMIN`, `SUPER_ADMIN`), o un caso o documento ajeno, inexistente o con identificador inválido. La lectura no se audita (OCR-A14).
- No devuelve ejecuciones históricas, y no hay edición ni corrección del texto.

**Eventos de auditoría** (sin texto, fragmentos, valores ni hash del texto; el proveedor queda en `ocr_results`, no en el evento; OCR-A14): ver la tabla de eventos. No se auditan el reclamo, los reintentos, la lectura ni las marcas `EXCLUDED` y `NOT_APPLICABLE`.

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

### `Case`

```json
{
  "id": "uuid",
  "type": "TRAFFIC_CITATION | INFRACTION | PHOTO_ENFORCEMENT | TRANSPORT | NOTIFICATION | ADMINISTRATIVE_PROCEEDING | OTHER",
  "status": "DRAFT | … (los 15 estados de CaseStatus, DATABASE_SPEC.md)",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

Los tipos son los 7 de `PROJECT_SPEC.md` s.9 paso 2 (comparendo, infracción, fotodetección, transporte, notificación, actuación administrativa, otro). No se devuelve el propietario: siempre es el usuario autenticado.

### `Document`

```json
{
  "id": "uuid",
  "fileName": "string",
  "fileType": "PDF | JPEG | PNG",
  "fileSize": 12345,
  "status": "UPLOADED | PENDING_SCAN | SCANNING | CLEAN | INFECTED | SCAN_FAILED",
  "ocrStatus": "NOT_STARTED | PENDING | PROCESSING | COMPLETED | FAILED | NOT_APPLICABLE | EXCLUDED",
  "createdAt": "ISO-8601"
}
```

No se devuelven las claves de almacenamiento, el usuario que lo subió, los intentos ni la firma detectada. `UPLOADED` solo aparece en documentos anteriores al antivirus: una subida nueva entra en `PENDING_SCAN`. Con el OCR desactivado (hoy, mientras faltan P4 y OCR-A10.5), `ocrStatus` es `NOT_STARTED`. Sus valores están en `DATABASE_SPEC.md`, «OCR del documento».

### `CaseStatusChange`

```json
{
  "fromStatus": "CaseStatus | null",
  "toStatus": "CaseStatus",
  "changedAt": "ISO-8601"
}
```

## Rate limits (Sprint 1B, valores iniciales)

Los límites por IP son en memoria, por proceso (SECURITY_SPEC.md — no compartidos entre instancias; migrar a un almacén compartido antes de escalar horizontalmente, sin introducir Redis sin un ADR). El límite por cuenta se deriva de los eventos `auth.login.failed` de `audit_logs` (ADR-002), así que se guarda en PostgreSQL. La IP es la del par TCP salvo proxies listados en `API_TRUST_PROXY`; detrás del proxy web de ADR-002, y hasta que exista un proxy de borde, el límite por IP es global (SECURITY_SPEC.md §7).

Los valores de verificación de email y recuperación de contraseña (decisiones P4 y P5) quedaron aprobados como definitivos el 2026-09-27.

| Endpoint | Por IP | Por cuenta |
|---|---|---|
| `POST /api/auth/register` | 5 cada 10 min | n/a |
| `POST /api/auth/login` | 10 cada 10 min | Retardo progresivo tras 5 intentos fallidos en 24 h (`RATE_LIMITED`, `Retry-After` exacto); ver abajo |
| `POST /api/auth/password/forgot` | 5 cada 10 min | Retardo progresivo por email (hash del correo normalizado, también para correos inexistentes): con F solicitudes en 24 h y F ≥ 3, la siguiente espera min(30 s · 2^(F−3), 900 s) desde la última. Evaluado con bloqueo por email, como el login |
| `POST /api/auth/password/reset` | 5 cada 10 min | n/a (el token es de un solo uso) |
| `POST /api/auth/email/verification/resend` | 5 cada 10 min | Retardo progresivo por usuario: con F emails de verificación en 24 h (contando el del registro) y F ≥ 3, el siguiente espera min(30 s · 2^(F−3), 900 s) desde el último. Evaluado con bloqueo por usuario, como el login |

### Límite por cuenta en el login (D3)

- **Clave:** SHA-256 del email normalizado (minúsculas, sin espacios). Se aplica igual a correos inexistentes: la respuesta no revela si la cuenta existe.
- **Qué cuenta:** los `auth.login.failed` de las últimas 24 h: credenciales inválidas, correo inexistente, cuenta suspendida y barrera MFA de producción.
- **Qué no cuenta:** los intentos rechazados por el límite por cuenta (429) o por el límite por IP, las peticiones rechazadas por origen o validación, y los logins correctos. Un login correcto **no** reinicia el contador; cada fallo deja de contar al cumplir 24 h.
- **Retardo:** con F fallos en 24 h y F ≥ 5, el siguiente intento se permite a partir de `último fallo + D`, con D = min(30 · 2^(F−5), 900) s:

  | F (fallos en 24 h) | 0–4 | 5 | 6 | 7 | 8 | 9 | ≥ 10 |
  |---|---|---|---|---|---|---|---|
  | Espera | — | 30 s | 60 s | 120 s | 240 s | 480 s | 900 s |

- **Respuesta al bloqueo:** 429 `RATE_LIMITED`, con el mismo mensaje que el límite por IP ("Demasiadas solicitudes. Inténtalo más tarde."). `Retry-After` indica los segundos que faltan hasta el siguiente intento permitido, redondeados hacia arriba y como mínimo 1. Se audita `auth.login.rate_limited` en la misma transacción que decide el bloqueo: si la transacción se revierte, no queda el evento.
- **Tiempo:** lo fija PostgreSQL (`clock_timestamp()` tras obtener el bloqueo), no el reloj de la API.
- **Atomicidad:** la comprobación, la verificación y el registro del fallo forman una transacción serializada por cuenta (`pg_advisory_xact_lock`, `lock_timeout` 2 s). Si falla por bloqueo, conexión o tiempo de la transacción: 503 `SERVICE_UNAVAILABLE` ("Servicio no disponible temporalmente. Inténtalo más tarde.") con `Retry-After: 1`, sin conceder el intento y sin auditar `auth.login.rate_limited`. Cualquier otro error de base de datos sigue siendo 500.
- **Orden con el límite por IP:** primero el límite por IP y después el de cuenta. Un 429 del límite por cuenta ya ha consumido cupo del límite por IP.


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

Gestión de usuarios por administradores, MFA, cambio de contraseña con sesión activa, transiciones de estado de los casos y el resto de módulos de la spec (s.28).
