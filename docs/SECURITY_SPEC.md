# SECURITY_SPEC.md

**Versión:** 0.1 (línea base)
**Fecha:** 2026-09-24
**Estado:** Borrador para aprobación
**Referencias:** `PROJECT_SPEC.md` s.26, s.27; ADR-002; ADR-003. Marcos de referencia: OWASP Top 10 y OWASP ASVS.

Este documento fija la línea base de seguridad. Cada fase la amplía en el mismo cambio que introduce nuevas superficies (documentos, pagos, IA).

## 1. Principios

- Seguridad desde el comienzo, no al final (s.26).
- Mínimo privilegio y deny by default.
- Defensa en profundidad: ningún control depende de uno solo.
- El backend es la única autoridad; nada de lo que envíe el cliente se toma como cierto.
- Los datos personales se minimizan, se protegen y no se filtran en logs.

## 2. Autenticación y sesiones

Ver ADR-002. Resumen: sesiones opacas en cookie `httpOnly`, Argon2id, revocación, expiración y rotación, CSRF, verificación de email, recuperación segura de contraseña, rate limiting y MFA obligatorio para ADMIN y SUPER_ADMIN antes de producción.

La API exige `NODE_ENV` explícito (`development`, `test` o `production`); sin él no arranca, para que la barrera MFA de producción no pueda desactivarse por omisión (ADR-002).

## 3. Autorización

Ver ADR-003. Resumen: rol más propiedad/asignación del recurso en cada request, protección explícita contra IDOR (404 para recursos ajenos), policies puras y tests de acceso cruzado.

## 4. Transporte y navegador

- TLS en todos los entornos no locales; HSTS en producción.
- Cookies `Secure` y `httpOnly` (ADR-002).
- Cabeceras de seguridad con `helmet` en la API y equivalentes en Next.js (CSP, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors`).
  - CSP de Next.js con nonce por petición (`apps/web/src/middleware.ts`): solo se ejecutan scripts con el nonce (`'strict-dynamic'`), sin `'unsafe-inline'` para scripts; `object-src 'none'`, `base-uri`/`form-action`/`connect-src 'self'`, `frame-ancestors 'none'` y `upgrade-insecure-requests` en producción. Las páginas se renderizan dinámicamente para que cada una lleve su nonce. HSTS lo pone el proxy que termina TLS.
- CORS con lista explícita de orígenes; sin comodines. Con el origen único de ADR-002 (Next.js reenvía `/api/*` a la API) no se habilita CORS.

## 5. Validación de entrada y salida

- Todo body, query y param se valida con Zod en el borde; lo no declarado se rechaza.
- Errores uniformes que no filtran trazas, SQL ni detalles internos.
- Salida serializada mediante esquemas explícitos (nunca se devuelve la fila de base de datos completa).

## 6. Datos y secretos

- Secretos solo por variables de entorno; `.env` ignorado por git; `.env.example` sin valores reales.
- Escaneo de secretos (gitleaks) y de dependencias en CI.
- Contraseñas y tokens: solo hashes en la base de datos.
- **Redacción de logs:** contraseñas, tokens, cookies, cabeceras `Authorization` y `Set-Cookie`, y datos personales no se registran en claro.
- Clasificación de datos: credenciales y tokens (críticos), datos personales de usuarios (sensibles), metadatos operativos (internos).
- Retención, borrado, consentimiento y transferencia internacional de datos personales: **pendientes de validación jurídica colombiana**; hasta entonces no se codifican políticas y se minimiza la recolección.

## 7. Rate limiting y abuso

- Límites por IP y por cuenta en los endpoints de autenticación (ADR-002).
- Cuotas por usuario para operaciones costosas (OCR, IA) cuando existan.
- Limitación conocida: el límite por IP en memoria no se comparte entre instancias; se resolverá antes de escalar horizontalmente.
- **IP del cliente y proxies.** La IP (límite por IP, auditoría, sesiones) es siempre la del par TCP, salvo que el par figure en `API_TRUST_PROXY` (lista explícita de IPs/CIDR, vacía por defecto; no se aceptan comodines ni presets). El reenvío `/api/*` de Next.js no añade la IP del cliente ni elimina un `X-Forwarded-For` enviado por el cliente, así que confiar en él permitiría falsificar la IP. Mientras no haya un proxy de borde que fije `X-Forwarded-For` (topología de despliegue, decisión P3), detrás del proxy web todas las peticiones comparten la IP del servidor web: el límite por IP se vuelve global (falla cerrado; no se puede eludir) y la auditoría registra esa IP. Consecuencia: un solo cliente puede agotar el límite para todos (5 registros o 10 logins cada 10 minutos en todo el sitio), una denegación de servicio del registro y del login; no es aceptable para un despliegue público hasta resolverlo (barrera antes de producción, §12).

## 8. Auditoría

- `AuditLog` append-only (`DATABASE_SPEC.md`).
- Eventos mínimos del Sprint 1: registro, login exitoso y fallido, logout, revocaciones, verificación de email, solicitud y uso de recuperación de contraseña, cambios de rol.
- Sin contraseñas, tokens ni hashes en los valores registrados.

## 9. Registro y observabilidad

- Logs estructurados con `request_id` en cada petición.
- Seguimiento de errores con scrubbing de datos personales.
- Health checks (`live` y `ready`) sin información sensible.

## 10. Cadena de suministro y CI

- `pnpm-lock.yaml` versionado y instalación con `--frozen-lockfile` en CI.
- Auditoría de dependencias y actualizaciones automatizadas (Dependabot o Renovate).
- Dependencias justificadas; no se añaden sin necesidad (`PROJECT_SPEC.md` s.31).
- CI obligatoria: lint, typecheck, tests, build y escaneo de secretos.

## 11. Superficies futuras (se detallan en su fase)

| Superficie | Fase | Controles previstos |
|---|---|---|
| Documentos | 3 | Bucket privado, URLs prefirmadas cortas, verificación del contenido real, antivirus, límites de tamaño, limpieza de metadata, acceso siempre autorizado |
| Pagos | 6 | Firma de webhook, verificación server-to-server, idempotencia, nunca activar por el frontend |
| IA y documentos no confiables | 7 | El contenido de documentos se trata como no confiable (inyección de instrucciones), salidas validadas, citas obligatorias, registro `AiRun` |
| Acceso administrativo a datos de terceros | 9 | Justificación registrada y auditoría reforzada |

## 12. Barreras antes de producción

- [ ] MFA implementado y obligatorio para ADMIN y SUPER_ADMIN.
- [ ] Revisión de seguridad y pruebas de penetración.
- [ ] Backups configurados y restauración probada.
- [ ] Rate limiting compartido entre instancias, o despliegue de una sola instancia documentado.
- [ ] Decisiones jurídicas de datos personales y términos definidas con validación colombiana.
- [ ] Rotación y gestión de secretos en el entorno de despliegue.

## 13. Respuesta a incidentes

Procedimiento por definir antes del piloto (responsables, contacto, plazos y obligaciones de notificación). Las obligaciones legales de notificación dependen de validación jurídica.
