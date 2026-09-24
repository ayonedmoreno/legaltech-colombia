# ADR-001: Stack tecnológico y monorepo

- **Estado:** Aceptado
- **Fecha:** 2026-09-24
- **Decidido por:** responsable del producto (aprobación de D1)
- **Referencias:** `PROJECT_SPEC.md` s.10, s.14, s.36; `ARCHITECTURE_REPORT.md`

## Contexto

La spec define frontend Next.js, backend Node.js/TypeScript con API REST, PostgreSQL con Prisma, componentes independientes (`legal-engine`, `pricing-engine`), IA desacoplada del proveedor y trabajos pesados (OCR, embeddings, análisis). Ambigüedades a resolver: cómo se organizan los motores (¿módulos o paquetes?), cómo se ejecuta el trabajo asíncrono y qué se excluye del MVP.

## Decisión

1. **Monorepo** con **pnpm workspaces + Turborepo**.
2. **Frontend:** Next.js (App Router), React, TypeScript estricto, Tailwind CSS.
3. **API:** **Fastify + TypeScript**, REST, contratos con Zod y OpenAPI generado.
4. **Base de datos:** PostgreSQL con **Prisma**. Migraciones versionadas; SQL crudo cuando Prisma no cubra el caso (extensiones, constraints, índices especiales).
5. **Monolito modular** para el MVP: un único servicio de API con módulos internos.
6. **Worker separado** (`apps/worker`) para trabajos asíncronos, creado cuando exista el primer job (Fase 3).
7. **Cola de trabajos:** **pg-boss** sobre PostgreSQL, detrás de una interfaz `JobQueue`.
8. **Storage privado de objetos** compatible con S3, detrás de una interfaz `StorageProvider`.
9. **Paquetes independientes** en `packages/`: `contracts`, `database`, `legal-engine`, `pricing-engine`, `ai` (más `tooling` para configuración compartida).
10. Los módulos `legal/` y `pricing/` de la API son **adaptadores finos** (HTTP y persistencia); la lógica vive en los paquetes.
11. **Runtime:** Node.js LTS vigente al inicializar (versión fijada en `.nvmrc` y en `engines`).

### Reglas de dependencia

- `apps/*` pueden depender de `packages/*`.
- `packages/*` nunca dependen de `apps/*`.
- `legal-engine` y `pricing-engine` no dependen de `database`, `ai`, Fastify ni Next.js.
- `contracts` solo depende de Zod.
- El acceso a datos pasa por `packages/database`; ningún otro paquete importa `@prisma/client` directamente.

### Excluido salvo ADR posterior que lo justifique

Microservicios, Redis, GraphQL, LangChain, LlamaIndex, vector DB separada, NestJS.

## Consecuencias

**Positivas**
- Menos infraestructura que operar (Postgres, storage y el proceso worker).
- Motores testeables sin base de datos ni framework.
- Contratos compartidos entre frontend y API con tipos consistentes.
- Interfaces (`JobQueue`, `StorageProvider`, `LLMProvider`, etc.) permiten cambiar proveedores sin tocar el dominio.

**Negativas y riesgos**
- pg-boss comparte recursos con la base transaccional; si la carga crece habrá que reevaluarlo mediante un nuevo ADR.
- Prisma no soporta el tipo `vector` de forma nativa: SQL crudo para similitud (Fase 7).
- El rate limiting por IP en memoria no escala a varias instancias sin un almacén compartido (ver ADR-002).
- Un monorepo exige disciplina en los límites entre paquetes; se verificará con reglas de lint.

## Alternativas consideradas

- **NestJS:** más estructura y DI, pero más magia y dependencias; se prefirió Fastify con módulos explícitos.
- **BullMQ + Redis:** rechazado para el MVP por añadir infraestructura.
- **Polirepo:** rechazado; complica la sincronización de contratos y la documentación.
- **Motores como módulos de la API:** rechazado; acopla reglas jurídicas y de precios al framework.
