---
name: legaltech-project-rules
description: Reglas de LegalTech Colombia que no cambian sin autorización explícita, regla de precedencia entre fuentes y comprobación anti-regresión. Úsalo SIEMPRE antes de modificar código, documentación, esquema o permisos en este repositorio, y ante cualquier contradicción entre documentos, código o instrucciones.
---

# Reglas del proyecto (contrato de continuidad)

Cada regla de esta página viene de `PROJECT_SPEC.md`, de un ADR, de una SPEC o de una instrucción explícita del usuario. Estas reglas preservan decisiones ya tomadas. No bloquean mejoras: si algo parece mejorable, se **propone**, distinguiendo siempre entre «esto ya está decidido» y «esto requiere una nueva decisión». Nunca se cambia una condición en silencio para facilitar una implementación.

Skills relacionados: `legaltech-project-context` (qué existe), `legaltech-decision-log` (por qué), `legaltech-current-state` (dónde estamos), `legaltech-development-workflow` (cómo se trabaja), `legaltech-security-and-data-rules` (seguridad y datos).

## 1. Regla de precedencia

Ante dos fuentes que dicen cosas distintas, manda la de mayor rango:

1. Decisiones explícitas del usuario (responsable del producto), dadas en el chat.
2. `docs/PROJECT_SPEC.md`.
3. ADRs vigentes (`docs/adr/ADR-001`, `ADR-002`, `ADR-003`).
4. Especificaciones técnicas vigentes (`docs/ARCHITECTURE_REPORT.md`, `API_SPEC.md`, `DATABASE_SPEC.md`, `SECURITY_SPEC.md`).
5. Estado real del código.
6. Tests y evidencia de validación.
7. Documentación secundaria (README, comentarios, estos skills, la memoria).

**Si hay contradicción, NO se resuelve inventando una interpretación:** se reporta (qué fuentes, qué dicen, dónde) y se pide decisión. La precedencia sirve para saber qué fuente pesa más al reportar, no para resolver en silencio.

### Autoridad de estos skills

- Estos skills son documentación secundaria (rango 7). **No son una autoridad superior** a una decisión explícita del usuario ni a los documentos de rango 2–4.
- Si un skill contradice una fuente superior, manda la fuente superior y hay que reportar que el skill quedó desactualizado.
- Si un skill choca con una decisión del usuario posterior a él, **prevalece la decisión posterior**. El skill se actualiza después, con revisión del usuario.
- Los skills **no crean reglas**: solo recogen lo que ya está en la documentación o en decisiones explícitas. Lo pendiente que aparece en ellos es pendiente, no un requisito.

### Contradicciones conocidas

Cada una se reporta si afecta a la tarea. Nunca se corrige ni se interpreta sin decisión.

- **CONTRADICCIÓN DOCUMENTAL CONOCIDA — NO RESOLVER AUTOMÁTICAMENTE.** `ARCHITECTURE_REPORT.md` §5 termina con «Fuera de alcance por ahora: Cases, Documents, OCR…». Sin embargo, la Fase 2 (Cases) está cerrada y Documents está implementado en parte (ver `legaltech-project-context`). La frase parece anterior a esas fases, pero no se corrige sin decisión.
- **CONTRADICCIÓN DOCUMENTAL CONOCIDA — NO RESOLVER AUTOMÁTICAMENTE.** `PROJECT_SPEC.md` tiene caracteres mal codificados (p. ej. «TrÃ¡nsito» por «Tránsito»). No se reescribe ni se recodifica sin autorización. Al citarlo, interpretar solo el texto, sin cambiar su contenido.
- **CONTRADICCIÓN DOCUMENTAL CONOCIDA — NO RESOLVER AUTOMÁTICAMENTE.** Nomenclatura P4/P5:
  - en `ARCHITECTURE_REPORT.md` §7, P4 es el proveedor de OCR y P5 la pasarela de pagos;
  - en las decisiones del Sprint 1B (2026-09-27, cierre de la Fase 1, criterio 9 de §5) se aprobaron unos «valores P4/P5», y esos P-números del Sprint 1B se refieren a otra cosa;
  - al citar una «P», indicar siempre de qué lista viene.
- **CONTRADICCIÓN DOCUMENTAL CONOCIDA — NO RESOLVER AUTOMÁTICAMENTE.** Numeración de fases:
  - la tabla de `ARCHITECTURE_REPORT.md` §7 usa la numeración de la propuesta de §6 (P1, sin decidir), p. ej. «P5 bloquea Fase 6» o «P6 bloquea Fase 7»;
  - la vigente es la de `PROJECT_SPEC.md` s.34, donde Payments es la Fase 5 y Legal AI la Fase 6.
- **CONTRADICCIÓN DOCUMENTAL CONOCIDA — NO RESOLVER AUTOMÁTICAMENTE.** `PROJECT_SPEC.md` s.32 dice que el repositorio «deberá contener» `AI_SPEC.md`, `LEGAL_ENGINE_SPEC.md`, `PRICING_SPEC.md`, `DEPLOYMENT.md` y `TESTING.md`, que no existen. No se crean sin decisión.

## 2. Reglas que no se cambian sin autorización explícita

Contenido jurídico y de producto:

- No inventar requisitos legales, normas, artículos, plazos ni procedimientos (`PROJECT_SPEC.md` s.3.1, s.31).
- No inventar cuestionarios jurídicos: el cuestionario dinámico (s.9 paso 3) está bloqueado hasta que exista contenido aprobado.
- No inventar transiciones de estado del caso: T1–T10 están documentadas y **todas deshabilitadas**; V1–V8 están pendientes y no se resuelven por inferencia.
- No inventar funcionalidades ni contenido no definidos (`PROJECT_SPEC.md` s.31; instrucción del usuario del 2026-10-01 para el artefacto visual). Por ejemplo, ningún documento vigente define un «sistema de beneficios» ni «herramientas jurídicas».
- No decidir cuestiones que requieren validación jurídica colombiana (retención, borrado, consentimiento, transferencia internacional, T&C, reembolsos, mandato para radicar).

Arquitectura y datos:

- No modificar la arquitectura (ADR-001: monolito modular + worker, pg-boss, `StorageProvider`, paquetes puros) sin decisión previa y, si procede, un ADR.
- No añadir dependencias excluidas (microservicios, Redis, GraphQL, LangChain, LlamaIndex, vector DB separada, NestJS) ni dependencias sin justificación.
- No modificar permisos de PostgreSQL (GRANT/REVOKE de `legaltech_app` o `legaltech_worker`) sin evidencia (un test que lo demuestre) **y** autorización. Si un test indica que hace falta, detenerse y reportar.
- No crear migraciones salvo que sean estrictamente necesarias; en ese caso, detenerse y reportar antes de ejecutarlas.
- Todo cambio de esquema actualiza `DATABASE_SPEC.md`, y todo cambio de API actualiza `API_SPEC.md`, en el mismo cambio (s.31).
- No modificar `PROJECT_SPEC.md` ni los ADRs sin autorización.

Alcance:

- No introducir funcionalidades pendientes (OCR, pagos, IA, paneles, MFA…) dentro de una rebanada cerrada ni en otra rebanada.
- No convertir una representación visual (artefactos, mockups, maquetas) en funcionalidad real: un artefacto describe, no especifica.
- Mantener separadas documentación, implementación, pruebas y validación. Un test se escribe para fijar un comportamiento **ya decidido**, nunca para fijar por accidente una decisión de producto que no existe.
- Respetar el desarrollo por rebanadas (`legaltech-development-workflow`).

Git y entorno:

- Sin commit sin autorización; sin push sin autorización **explícita** (cada push se autoriza por separado).
- Nunca `git reset`, `rebase`, `squash`, `amend`, `restore` destructivo ni reescritura de commits históricos.
- Git en esta máquina exige `git -c safe.directory=C:/legaltech-colombia …` (el repo pertenece a Administradores); no cambiar la configuración global.
- No tocar el contenedor de desarrollo `legaltech-postgres-1` (127.0.0.1:5432; instrucción del usuario). Para las pruebas se han usado contenedores desechables en otros puertos (práctica, no regla del producto; p. ej. 15432 PostgreSQL, 18333 SeaweedFS, 13310 ClamAV) que se eliminan al terminar.
- Nota operativa de esta máquina Windows, no una regla del producto: detener un proceso en segundo plano puede dejar vivos sus servidores node hijos. Hay que matarlos (`taskkill /T /F` o `Stop-Process`) antes de ejecutar la CI local.
- Nunca registrar tokens, contraseñas ni nombres de archivo en logs o auditoría.
- Si el clasificador o un permiso bloquea una herramienta, no forzarlo: reportar.

## 3. Protección contra regresiones (antes de empezar cualquier tarea)

Antes de escribir código, comprobar y, si la tarea no es trivial, enunciar:

1. **Decisiones que afectan la tarea:** buscar en `legaltech-decision-log` y en los documentos de rango 2–4.
2. **Funcionalidades cerradas que toca:** ver `legaltech-project-context` (🟢) y `legaltech-current-state`.
3. **Restricciones vigentes:** este skill y `legaltech-security-and-data-rules`.
4. **Lo que está expresamente fuera de alcance** de la rebanada en curso.

Si la modificación cambia una condición aprobada (un valor, un permiso, un estado, un código de error, un mensaje, un límite, un actor autorizado…), **señalarlo antes de implementarlo**, con:

- la condición actual y su fuente (decisión, documento o commit);
- el cambio propuesto y su motivo;
- qué se rompe o cambia para el usuario o para la seguridad.

Y esperar la decisión.
