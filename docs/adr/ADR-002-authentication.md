# ADR-002: Autenticación y sesiones

- **Estado:** Aceptado
- **Fecha:** 2026-09-24
- **Decidido por:** responsable del producto (aprobación de D2 con requisitos adicionales)
- **Referencias:** `PROJECT_SPEC.md` s.6, s.26, s.27; `SECURITY_SPEC.md`; `API_SPEC.md`

## Contexto

La plataforma maneja documentos y datos personales sensibles. La spec exige autenticación segura, control de acceso por recurso y auditoría, pero no define el mecanismo de sesión.

## Decisión

Autenticación propia, integrada en la API, con **sesiones opacas** guardadas en PostgreSQL.

### Requisitos aprobados

1. Sesiones opacas mediante cookie `httpOnly`.
2. Contraseñas con **Argon2id**.
3. **Revocación** de sesiones.
4. **Expiración y rotación** de sesiones.
5. **Protección CSRF**.
6. **Verificación de email**.
7. **Recuperación segura** de contraseña.
8. **Rate limiting**.
9. **MFA obligatorio para ADMIN y SUPER_ADMIN antes de producción**.
10. Sin secretos en el repositorio.

### Diseño

**Sesión**
- Token de 256 bits generado con CSPRNG. En la base solo se guarda su hash (SHA-256); el token en claro solo existe en la cookie.
- Cookie: `httpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, sin atributo `Domain`, con prefijo `__Host-` cuando aplique.
- La API y la web se exponen bajo un único origen (la web reenvía `/api/*` a la API) para que la cookie no requiera CORS con credenciales. Se valida en el Sprint 1B; si el despliegue impone dominios distintos, se documenta en un ADR.
- Expiración por inactividad y expiración absoluta, ambas configurables. Valores iniciales propuestos, a confirmar: usuarios 7 días de inactividad y 30 días absolutos; roles internos (PROFESSIONAL, ADMIN, SUPER_ADMIN) más cortos.
- **Rotación** del identificador de sesión al iniciar sesión, al cambiar de privilegios, al cambiar o restablecer la contraseña y periódicamente durante el uso.
- **Revocación:** cierre de sesión, cierre de todas las sesiones, revocación de una sesión propia por ID, revocación de todas al restablecer contraseña y revocación administrativa (cuando exista el flujo administrativo).

**Contraseñas**
- Argon2id con parámetros iniciales según la recomendación vigente de OWASP, calibrados en el hardware de producción (verificar al implementar).
- Longitud mínima de 12 caracteres y máxima de 128, sin reglas de composición arbitrarias. La comprobación contra contraseñas filtradas queda como mejora posterior.

**CSRF**
- `SameSite=Lax` más verificación de `Origin`/`Referer` en métodos no seguros más un token CSRF ligado a la sesión, enviado en el encabezado `X-CSRF-Token` y obtenido mediante `GET /api/auth/csrf`.

**Verificación de email y recuperación de contraseña**
- Tokens de 256 bits, guardados solo como hash, de un solo uso y con expiración corta.
- Respuestas genéricas que no revelan si un correo está registrado (evita enumeración de usuarios).
- Al restablecer la contraseña se revocan todas las sesiones y se notifica por email.
- Reenvío de verificación con rate limit.
- Un usuario con email sin verificar puede iniciar sesión; las acciones sensibles futuras exigirán email verificado.

**Rate limiting**
- Por IP en el borde de la API.
- Por cuenta y por email en los endpoints de autenticación, con retardo progresivo en lugar de bloqueo permanente (evita denegación de servicio contra una cuenta).
- El contador por cuenta se deriva de los eventos de `AuditLog` de intentos fallidos (índice dedicado), sin tabla adicional.
- Limitación conocida: el límite por IP en memoria no se comparte entre instancias. Si la API corre con varias instancias antes de resolver esto, se documentará en un ADR.

**MFA**
- TOTP con códigos de recuperación para ADMIN y SUPER_ADMIN.
- **Barrera de producción:** en `NODE_ENV=production`, ningún ADMIN o SUPER_ADMIN puede iniciar sesión hasta que MFA esté implementado y enrolado (la comprobación falla cerrada). MFA no forma parte del Sprint 1; se planifica antes de habilitar cualquier cuenta administrativa en producción.

**Alta de cuentas y roles**
- El registro público solo crea usuarios con rol `USER`.
- Las cuentas PROFESSIONAL, ADMIN y SUPER_ADMIN no se crean por el registro público (ver ADR-003).

**Auditoría**
- Eventos de registro, login exitoso y fallido, logout, revocaciones, verificación de email y recuperación de contraseña se registran en `AuditLog`, sin almacenar contraseñas, tokens ni hashes.

**Secretos**
- Solo por variables de entorno; `.env` fuera del control de versiones; `.env.example` sin valores reales; escaneo de secretos en CI.

## Consecuencias

- Control total y revocación inmediata de sesiones, a costa de mantener el código de autenticación (se limita con tests de seguridad y una superficie pequeña).
- Cada request autenticada consulta la base de datos (aceptable para el MVP; optimizable con cache tras un ADR).
- El diseño de rotación y CSRF exige que el frontend sea consciente del token CSRF.

## Alternativas consideradas

- **JWT sin estado:** revocación difícil; rechazado.
- **Proveedor externo de identidad:** menos código propio, pero dependencia y coste; puede reconsiderarse con un ADR.
- **Rate limiting en Redis:** descartado por la restricción de no introducir Redis.
