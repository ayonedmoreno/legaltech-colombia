# SECURITY_SPEC.md

**Versión:** 0.5 (línea base; antivirus y metadata de documentos, Fase 3)
**Fecha:** 2026-09-28
**Estado:** Aprobado (cierre de las Fases 1 y 2; rebanadas 1 y 2 de la Fase 3, 2026-09-27 y 2026-09-28)
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

- Casos (Fase 2, primera rebanada): `case:create`, `case:list` y `case:read` solo para el rol `USER` y sobre sus propios casos; los repositorios filtran siempre por el usuario y un caso ajeno, inexistente o con identificador inválido responde 404. PROFESSIONAL, ADMIN y SUPER_ADMIN no acceden a casos hasta sus fases (asignaciones, acceso administrativo justificado y auditado, §11).
- Documentos (Fase 3, primera rebanada): `document:upload`, `document:list` y `document:download` solo para `USER` y sobre documentos de sus propios casos; el caso se busca siempre con el usuario y un documento se busca siempre con su caso, así que un caso o documento ajeno, inexistente o con identificador inválido responde 404.
- Estados del caso (`DATABASE_SPEC.md`, «Estados y transiciones del caso»): ninguna transición está habilitada todavía y el usuario no inicia ningún cambio de estado. `PAID` solo lo provocará un webhook de pago verificado (`PROJECT_SPEC.md` s.23); las transiciones de un profesional, solo sobre casos asignados, en su fase. Cada transición, al habilitarse, escribirá el historial y `case.status_changed` en la misma transacción que el cambio.

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
- Base de datos con mínimo privilegio: el rol de la aplicación no es propietario de ninguna tabla, no tiene `DELETE` ni `TRUNCATE`, no accede a `_prisma_migrations` y en `audit_logs` solo lee e inserta; cada tabla nueva recibe sus permisos explícitamente en su migración (`DATABASE_SPEC.md`, «Permisos del rol de aplicación»).
- **Redacción de logs:** contraseñas, tokens, cookies, cabeceras `Authorization` y `Set-Cookie`, y datos personales no se registran en claro.
- Clasificación de datos: credenciales y tokens (críticos), datos personales de usuarios (sensibles), metadatos operativos (internos).
- Retención, borrado, consentimiento y transferencia internacional de datos personales: **pendientes de validación jurídica colombiana**; hasta entonces no se codifican políticas y se minimiza la recolección.

## 7. Rate limiting y abuso

- Límites por IP y por cuenta en los endpoints de autenticación (ADR-002).
- Cuotas por usuario para operaciones costosas (OCR, IA) cuando existan.
- Limitación conocida: el límite por IP en memoria no se comparte entre instancias; se resolverá antes de escalar horizontalmente.
- **IP del cliente y proxies.** La IP (límite por IP, auditoría, sesiones) es siempre la del par TCP, salvo que el par figure en `API_TRUST_PROXY` (lista explícita de IPs/CIDR, vacía por defecto; no se aceptan presets ni entradas que confíen en todas las direcciones: cualquier rango `/0` o el rango IPv4 mapeado `::ffff:0:0/96`, y una sola entrada prohibida invalida toda la lista). Si `X-Forwarded-For` falta, está vacío o no es una dirección IP, se usa el par TCP (nunca se responde 400 por ello). El reenvío `/api/*` de Next.js no añade la IP del cliente ni elimina un `X-Forwarded-For` enviado por el cliente, así que confiar en él permitiría falsificar la IP: la dirección del servidor web no debe figurar en `API_TRUST_PROXY` mientras no exista el borde de confianza de P3. Mientras no haya un proxy de borde que fije `X-Forwarded-For` (topología de despliegue, decisión P3), detrás del proxy web todas las peticiones comparten la IP del servidor web: el límite por IP se vuelve global (falla cerrado; no se puede eludir) y la auditoría registra esa IP. Consecuencia: un solo cliente puede agotar el límite para todos (5 registros o 10 logins cada 10 minutos en todo el sitio), una denegación de servicio del registro y del login; no es aceptable para un despliegue público hasta resolverlo (barrera antes de producción, §12). Esta limitación es transitoria y deliberada (decisión D2-A): se mantiene, sin cambiar la estrategia del limitador, mientras no exista un borde de confianza (decisión de despliegue P3), y no se publica la aplicación en una topología expuesta a este riesgo hasta resolverlo.

## 8. Auditoría

- `AuditLog` append-only (`DATABASE_SPEC.md`).
- Eventos mínimos del Sprint 1: registro, login exitoso y fallido, logout, revocaciones (de una sesión propia por ID y de todas las sesiones), verificación de email, solicitud y uso de recuperación de contraseña. Los nombres exactos están en `API_SPEC.md`.
- Fase 2 (rebanada `Case`): `case.created`, con `case_id`, en la misma transacción que el caso y su historial de estados. Cada cambio de estado futuro se auditará igual (`PROJECT_SPEC.md` s.8 y s.25).
- Los cambios de rol se auditarán cuando exista el flujo administrativo, que queda fuera del Sprint 1 (ADR-003: la matriz del Sprint 1 solo cubre acciones de autenticación y del propio usuario). Las rotaciones periódicas de sesión no se auditan (decisión P9 del Sprint 1B).
- Sin contraseñas, tokens ni hashes en los valores registrados.
- Cada evento de un cambio de estado se escribe en la misma transacción que el cambio: login fallido y bloqueo (D3), verificación de email, restablecimiento de contraseña, logout, revocación por ID y cierre de todas las sesiones (Sprint 1B, H1). Se guardan ambos o ninguno, y una revocación repetida o concurrente no genera un segundo evento.

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
| Documentos | 3 | Bucket privado, URLs prefirmadas cortas, verificación del contenido real, antivirus, límites de tamaño, limpieza de metadata, acceso siempre autorizado. **Implementado en la primera rebanada:** bucket privado detrás de `StorageProvider` (API S3), URL prefirmada de 60 s emitida solo tras autorizar al propietario y con `Content-Disposition: attachment`, tipo verificado por la firma del contenido (PDF, JPEG, PNG), límite de 10 MB (valor técnico provisional, configurable), sesión y CSRF comprobados antes de leer el cuerpo, clave de almacenamiento sin el nombre del archivo. **Implementado en la segunda rebanada:** análisis antivirus con ClamAV dentro de nuestra infraestructura (ningún documento sale a un servicio externo), en un worker aparte y fuera de la petición HTTP; un documento solo se descarga en `CLEAN`, y nunca con otro estado ni por defecto ante un error; copia derivada sin metadata identificable para JPEG (EXIF/GPS, XMP, IPTC, comentarios, donde aparezcan, también entre barridos) y PNG (`eXIf`, `tEXt`, `zTXt`, `iTXt`), sin recodificar la imagen y sin lo que haya después del final de la imagen (`EOI`, `IEND`), y el original conservado privado e intacto; rol de base de datos propio para el worker. **Pendiente:** limpieza de metadata de PDF (decisión pendiente; hoy el PDF se entrega tal como se recibió). |
| Pagos | 6 | Firma de webhook, verificación server-to-server, idempotencia, nunca activar por el frontend |
| IA y documentos no confiables | 7 | El contenido de documentos se trata como no confiable (inyección de instrucciones), salidas validadas, citas obligatorias, registro `AiRun` |
| Acceso administrativo a datos de terceros | 9 | Justificación registrada y auditoría reforzada |

## 12. Barreras antes de producción

- [ ] MFA implementado y obligatorio para ADMIN y SUPER_ADMIN.
- [ ] Revisión de seguridad y pruebas de penetración.
- [ ] Backups configurados y restauración probada.
- [ ] Rate limiting compartido entre instancias, o despliegue de una sola instancia documentado.
- [ ] Límite por IP por cliente real: borde de confianza que fija `X-Forwarded-For` y `API_TRUST_PROXY` acorde (P3). Hasta entonces el límite por IP es global y no se publica (§7).
- [ ] Decisiones jurídicas de datos personales y términos definidas con validación colombiana.
- [ ] Rotación y gestión de secretos en el entorno de despliegue.
- [x] Documentos: antivirus y limpieza de metadata de JPEG y PNG (Fase 3, segunda rebanada).
- [ ] Documentos: firmas de ClamAV actualizadas en producción (freshclam, o imagen reconstruida a diario). En desarrollo y CI las firmas vienen fijadas en la imagen y no se actualizan, para que los tests sean reproducibles y no dependan de la red.
- [ ] Documentos: decisión sobre la limpieza de metadata de PDF (hoy no se modifica el PDF).
- [ ] Almacenamiento de producción (P3): proveedor y región con validación jurídica de la transferencia internacional de datos personales; bucket sin acceso público, cifrado en reposo y credenciales con permisos solo sobre ese bucket.
- [ ] Entrega real de email: proveedor y worker de la Fase 3 (ADR-001). En el Sprint 1B el outbox solo se despacha con un comando de desarrollo que escribe los mensajes en ficheros locales; sin esto, verificación de email y recuperación de contraseña no llegan al usuario.

## 13. Respuesta a incidentes

Procedimiento por definir antes del piloto (responsables, contacto, plazos y obligaciones de notificación). Las obligaciones legales de notificación dependen de validación jurídica.
