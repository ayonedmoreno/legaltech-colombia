# ADR-003: Roles y autorización

- **Estado:** Aceptado
- **Fecha:** 2026-09-24
- **Decidido por:** responsable del producto (aprobación de D3)
- **Referencias:** `PROJECT_SPEC.md` s.6, s.15, s.27; `SECURITY_SPEC.md`

## Contexto

La spec define cuatro roles fijos y lista las entidades `Role` y `Permission`. Un RBAC dinámico (permisos editables por SUPER_ADMIN) añadiría complejidad que el MVP no necesita. La s.27 exige verificar rol, recurso, permiso y pertenencia al ámbito.

## Decisión

1. **Roles del MVP:** `USER`, `PROFESSIONAL`, `ADMIN`, `SUPER_ADMIN`, modelados como enum en la base de datos.
2. La matriz de permisos vive **en código**, como datos tipados y versionados. Las tablas `Role` y `Permission` de la s.15 **no se crean** en el MVP; si surge la necesidad de permisos dinámicos, se documentará con un ADR y una migración.
3. La autorización comprueba **siempre rol y propiedad/asignación del recurso**.
4. Protección **explícita contra IDOR**.
5. Las policies quedan **preparadas para crecer**: cada módulo expone su `policy` y cada recurso nuevo la incorpora desde su primer endpoint.

### Modelo de policies

```
can(actor, action, resource?) -> Decision
```

- `actor`: usuario autenticado (id, rol, estado).
- `action`: cadena tipada, p. ej. `session:revoke`, `user:read`.
- `resource`: entidad concreta con los datos necesarios para verificar propiedad o asignación.
- Deny by default: si no hay regla que permita, se niega.
- Las policies son funciones puras, sin acceso a base de datos, y se prueban de forma unitaria.

### Protección contra IDOR

- Todo repositorio de recursos con dueño recibe el **alcance del actor** (`scope`) y filtra por él en la consulta; no existen métodos `findById` sin alcance para recursos de usuarios.
- Un recurso que existe pero no pertenece al actor responde **404** (no 403), para no confirmar su existencia.
- Identificadores UUID no secuenciales.
- Suite de tests de acceso cruzado obligatoria para cada recurso con dueño: un usuario no puede leer, modificar ni revocar recursos de otro.
- La comprobación se hace en el servidor en cada request; nunca se confía en identificadores enviados por el cliente para determinar el ámbito.

### Reglas por rol (líneas base)

| Rol            | Principio                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `USER`         | Solo accede a sus propios recursos.                                                                         |
| `PROFESSIONAL` | Solo accede a recursos asignados a él (cuando existan casos).                                               |
| `ADMIN`        | Gestiona usuarios `USER` y `PROFESSIONAL` y operación; su acceso a datos de terceros se justifica y audita. |
| `SUPER_ADMIN`  | Configuración y elevación de roles. Único que puede otorgar `ADMIN` y `SUPER_ADMIN`.                        |

En el Sprint 1 la matriz solo cubre acciones de autenticación y del propio usuario (por ejemplo `session:list`, `session:revoke`, `user:read` sobre sí mismo). Las acciones sobre casos, documentos, pagos y demás se añaden con cada fase, junto con sus tests.

### Asignación de roles

- El registro público crea únicamente `USER`.
- Las cuentas internas (PROFESSIONAL, ADMIN, SUPER_ADMIN) se crean por un mecanismo controlado (script de siembra para desarrollo; flujo administrativo cuando exista), nunca por el endpoint público.
- Todo cambio de rol se registra en `AuditLog` y rota las sesiones del usuario afectado.

## Consecuencias

- Menos tablas y menos superficie de configuración en el MVP.
- Cambiar la matriz requiere un despliegue, lo cual es deseable para un dominio sensible.
- La evolución a permisos dinámicos exigirá migración y ADR.

## Alternativas consideradas

- **Tablas `Role`/`Permission` desde el inicio:** rechazado por complejidad prematura.
- **Librería de autorización externa:** rechazada por dependencia innecesaria; las policies propias son pequeñas y testeables.
