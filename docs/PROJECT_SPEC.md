# PROJECT_SPEC.md

# Plataforma LegalTech de TrÃ¡nsito y Transporte Colombia

**VersiÃ³n:** 1.0
**Estado:** EspecificaciÃ³n maestra inicial
**Mercado inicial:** Colombia

---

## 1. InformaciÃ³n general

Plataforma web LegalTech especializada inicialmente en infracciones de trÃ¡nsito, transporte y actuaciones administrativas relacionadas en Colombia.

La plataforma combinarÃ¡:

- Inteligencia artificial.
- Base de conocimiento jurÃ­dico.
- Motor de reglas.
- GestiÃ³n documental.
- GeneraciÃ³n de documentos.
- GestiÃ³n de expedientes.
- Seguimiento de actuaciones.
- Profesionales jurÃ­dicos.
- Sistema de pagos.
- Notificaciones.

La plataforma no deberÃ¡ prometer la eliminaciÃ³n, reducciÃ³n o condonaciÃ³n de una infracciÃ³n. El producto se ofrecerÃ¡ como un servicio de anÃ¡lisis, orientaciÃ³n y gestiÃ³n jurÃ­dica segÃºn las alternativas que resulten aplicables a cada caso.

---

## 2. Objetivo principal

Permitir que un usuario pueda:

1. Crear una cuenta.
2. Registrar una situaciÃ³n relacionada con trÃ¡nsito o transporte.
3. Cargar documentos.
4. Obtener un diagnÃ³stico preliminar.
5. Conocer posibles alternativas jurÃ­dicas.
6. Conocer el valor de la asesorÃ­a y gestiÃ³n.
7. Realizar el pago.
8. Abrir formalmente un expediente.
9. Recibir anÃ¡lisis y gestiÃ³n.
10. Consultar el estado del caso.
11. Recibir documentos y comunicaciones.
12. Conocer respuestas de las autoridades.
13. Recibir orientaciÃ³n sobre los siguientes pasos.
14. Cerrar el expediente al finalizar la gestiÃ³n contratada.

---

## 3. Principios fundamentales

### 3.1 PrecisiÃ³n jurÃ­dica

La IA no deberÃ¡ inventar normas, artÃ­culos, sentencias, procedimientos o plazos.

Toda conclusiÃ³n jurÃ­dica relevante deberÃ¡ poder relacionarse con una fuente jurÃ­dica almacenada en el sistema.

### 3.2 Trazabilidad

El sistema deberÃ¡ permitir conocer:

- informaciÃ³n utilizada;
- documentos analizados;
- fuentes jurÃ­dicas consultadas;
- modelo de IA utilizado;
- usuario/profesional que revisÃ³ el resultado;
- cambios realizados.

### 3.3 SupervisiÃ³n humana

Los casos que superen determinados niveles de complejidad deberÃ¡n poder pasar a revisiÃ³n profesional.

### 3.4 Seguridad

Los documentos y datos de usuarios deberÃ¡n protegerse mediante controles de acceso adecuados.

### 3.5 Transparencia

El usuario deberÃ¡ conocer:

- quÃ© estÃ¡ pagando;
- quÃ© incluye el servicio;
- quÃ© no incluye;
- estado del caso;
- resultado obtenido;
- incertidumbres relevantes.

---

## 4. Modelo de negocio

El modelo principal serÃ¡ de **pago por caso**.

El usuario no pagarÃ¡ Ãºnicamente por un documento individual. PagarÃ¡ por un servicio de anÃ¡lisis y gestiÃ³n asociado a un expediente.

El precio podrÃ¡ depender de:

- valor econÃ³mico de la infracciÃ³n u obligaciÃ³n;
- tipo de caso;
- complejidad;
- cantidad de documentos;
- cantidad de actuaciones;
- estado del proceso;
- necesidad de intervenciÃ³n profesional;
- otros factores definidos posteriormente.

La fÃ³rmula definitiva de precios no deberÃ¡ estar codificada directamente en componentes del frontend.

Debe existir un mÃ³dulo independiente:

`Pricing Engine`

### SeparaciÃ³n de conceptos

**Valor de la obligaciÃ³n:** monto que eventualmente deba pagar el usuario a la autoridad.

**Valor del servicio:** monto que el usuario paga por asesorÃ­a y gestiÃ³n.

**Resultado:** decisiÃ³n o resultado producido por la autoridad competente.

---

## 5. Flujo comercial

```text
Usuario
   â†“
InformaciÃ³n inicial
   â†“
DiagnÃ³stico preliminar
   â†“
EstimaciÃ³n del servicio
   â†“
Oferta
   â†“
Pago
   â†“
Apertura formal del caso
   â†“
GestiÃ³n
```

El sistema no deberÃ¡ representar un resultado jurÃ­dico como garantizado.

---

## 6. Usuarios y roles

### USER

Usuario final.

Permisos:

- registrarse;
- crear casos;
- cargar documentos;
- realizar pagos;
- consultar expedientes;
- recibir documentos;
- enviar mensajes;
- consultar estados.

### PROFESSIONAL

Profesional jurÃ­dico autorizado para revisar y gestionar determinados casos.

Permisos:

- consultar casos asignados;
- revisar documentos;
- analizar informaciÃ³n;
- revisar resultados de IA;
- aprobar documentos;
- registrar actuaciones;
- actualizar estados;
- responder al usuario.

### ADMIN

Administrador operativo.

Permisos:

- gestionar usuarios;
- gestionar casos;
- gestionar pagos;
- gestionar profesionales;
- administrar documentos;
- administrar configuraciones;
- consultar estadÃ­sticas.

### SUPER_ADMIN

Administrador principal.

Permisos:

- configuraciÃ³n general;
- roles;
- permisos;
- reglas;
- auditorÃ­a;
- configuraciÃ³n del sistema.

---

## 7. Objeto principal: CASE

La aplicaciÃ³n deberÃ¡ construirse alrededor del concepto de `Case`.

Una multa no serÃ¡ el objeto principal.

Un caso podrÃ¡ contener:

```text
Case
â”œâ”€â”€ User
â”œâ”€â”€ Infraction
â”œâ”€â”€ Authority
â”œâ”€â”€ Documents
â”œâ”€â”€ Analysis
â”œâ”€â”€ Legal Sources
â”œâ”€â”€ Proceedings
â”œâ”€â”€ Payments
â”œâ”€â”€ Messages
â”œâ”€â”€ Notifications
â”œâ”€â”€ Assignments
â””â”€â”€ Audit Logs
```

Esto permitirÃ¡ posteriormente ampliar la plataforma.

---

## 8. Estados del caso

Estados iniciales:

```text
DRAFT
DOCUMENTS_PENDING
PRELIMINARY_ANALYSIS
PAYMENT_PENDING
PAID
LEGAL_REVIEW
DOCUMENT_PREPARATION
READY_TO_FILE
FILED
WAITING_RESPONSE
RESPONSE_RECEIVED
FOLLOW_UP
RESOLVED
CLOSED
CANCELLED
```

Todos los cambios de estado deberÃ¡n registrarse en un historial.

---

## 9. Flujo principal del usuario

### Paso 1 â€” Registro

El usuario crea una cuenta.

### Paso 2 â€” Crear caso

Selecciona el tipo de situaciÃ³n:

- comparendo;
- infracciÃ³n;
- fotodetecciÃ³n;
- transporte;
- notificaciÃ³n;
- actuaciÃ³n administrativa;
- otro.

### Paso 3 â€” Cuestionario dinÃ¡mico

El sistema realiza preguntas dependiendo del tipo de caso.

### Paso 4 â€” Carga documental

Se podrÃ¡n cargar:

- PDF;
- JPG;
- PNG;
- fotografÃ­as;
- documentos escaneados.

### Paso 5 â€” ExtracciÃ³n

El sistema realizarÃ¡ OCR y extracciÃ³n de informaciÃ³n.

### Paso 6 â€” DiagnÃ³stico preliminar

La IA identifica:

- tipo de documento;
- datos relevantes;
- fechas;
- autoridad;
- valores;
- posibles inconsistencias;
- informaciÃ³n faltante;
- posibles lÃ­neas de actuaciÃ³n.

### Paso 7 â€” ValoraciÃ³n

El Pricing Engine calcula el valor del servicio.

### Paso 8 â€” Pago

El usuario realiza el pago mediante el proveedor seleccionado.

### Paso 9 â€” Apertura formal

Confirmado el pago, el caso pasa a `PAID`.

### Paso 10 â€” GestiÃ³n

Se realiza el anÃ¡lisis completo.

### Paso 11 â€” Actuaciones

Se preparan las actuaciones que correspondan.

### Paso 12 â€” Seguimiento

El usuario puede consultar el estado.

### Paso 13 â€” Respuesta

Las respuestas recibidas se incorporan al expediente.

### Paso 14 â€” Cierre

El caso se cierra cuando finaliza la gestiÃ³n contratada.

---

## 10. Frontend

TecnologÃ­a inicial propuesta:

- Next.js
- React
- TypeScript
- Tailwind CSS

La interfaz serÃ¡ responsive para:

- Desktop.
- Tablet.
- MÃ³vil.

### Estructura inicial

```text
apps/
â””â”€â”€ web/

app/
â”œâ”€â”€ page.tsx
â”œâ”€â”€ login/
â”œâ”€â”€ register/
â”œâ”€â”€ dashboard/
â”œâ”€â”€ casos/
â”‚   â”œâ”€â”€ nuevo/
â”‚   â””â”€â”€ [id]/
â”œâ”€â”€ documentos/
â”œâ”€â”€ pagos/
â”œâ”€â”€ perfil/
â”œâ”€â”€ soporte/
â”œâ”€â”€ profesional/
â”‚   â”œâ”€â”€ dashboard/
â”‚   â”œâ”€â”€ casos/
â”‚   â””â”€â”€ agenda/
â””â”€â”€ admin/
    â”œâ”€â”€ dashboard/
    â”œâ”€â”€ usuarios/
    â”œâ”€â”€ casos/
    â”œâ”€â”€ pagos/
    â”œâ”€â”€ profesionales/
    â”œâ”€â”€ normativa/
    â””â”€â”€ configuracion/
```

---

## 11. Dashboard del usuario

Debe mostrar:

- casos activos;
- casos cerrados;
- pagos;
- documentos pendientes;
- alertas;
- Ãºltimas actualizaciones.

---

## 12. Dashboard profesional

Debe mostrar:

- casos asignados;
- casos pendientes;
- documentos pendientes;
- casos prÃ³ximos a vencimientos;
- respuestas recibidas;
- tareas pendientes.

---

## 13. Dashboard administrativo

Debe mostrar:

- usuarios;
- casos;
- casos activos;
- pagos;
- ingresos;
- casos por estado;
- casos por tipo;
- profesionales;
- mÃ©tricas operativas.

---

## 14. Backend

TecnologÃ­a inicial:

- Node.js
- TypeScript
- API REST
- PostgreSQL
- Prisma ORM

### MÃ³dulos iniciales

```text
apps/
â””â”€â”€ api/

src/
â”œâ”€â”€ auth/
â”œâ”€â”€ users/
â”œâ”€â”€ cases/
â”œâ”€â”€ infractions/
â”œâ”€â”€ authorities/
â”œâ”€â”€ documents/
â”œâ”€â”€ analysis/
â”œâ”€â”€ legal/
â”œâ”€â”€ pricing/
â”œâ”€â”€ payments/
â”œâ”€â”€ proceedings/
â”œâ”€â”€ notifications/
â”œâ”€â”€ messages/
â”œâ”€â”€ professionals/
â”œâ”€â”€ ai/
â”œâ”€â”€ audit/
â””â”€â”€ common/
```

---

## 15. Base de datos inicial

Entidades principales:

```text
User
Role
Permission

Case
CaseStatusHistory

Infraction
Authority

Document
DocumentVersion

LegalAnalysis
LegalSource
LegalCitation

Proceeding
ProceedingStatusHistory

Payment
PaymentTransaction

PriceRule

Professional
CaseAssignment

Notification
Message

AuditLog
```

La estructura definitiva se desarrollarÃ¡ en `DATABASE_SPEC.md`.

---

## 16. GestiÃ³n documental

Cada documento deberÃ¡ asociarse a un caso.

InformaciÃ³n mÃ­nima:

```text
document_id
case_id
file_name
file_type
storage_key
file_size
uploaded_by
created_at
status
ocr_status
```

Los archivos no deberÃ¡n almacenarse directamente en PostgreSQL.

Se utilizarÃ¡ almacenamiento de objetos.

---

## 17. OCR

Flujo:

```text
Archivo
 â†“
ValidaciÃ³n
 â†“
Storage
 â†“
OCR
 â†“
Texto extraÃ­do
 â†“
NormalizaciÃ³n
 â†“
ExtracciÃ³n de entidades
```

Entidades posibles:

- nÃºmero de comparendo;
- placa;
- fecha;
- autoridad;
- infracciÃ³n;
- valor;
- identificaciÃ³n;
- resoluciÃ³n;
- fechas de notificaciÃ³n.

La informaciÃ³n extraÃ­da automÃ¡ticamente deberÃ¡ poder ser revisada.

---

## 18. Inteligencia artificial

Funciones principales:

### ExtracciÃ³n

Extraer informaciÃ³n de documentos.

### ClasificaciÃ³n

Determinar tipo de documento/caso.

### RecuperaciÃ³n

Buscar informaciÃ³n relevante en la base jurÃ­dica.

### AnÃ¡lisis

Analizar el caso usando fuentes recuperadas.

### GeneraciÃ³n

Generar borradores de documentos.

### RevisiÃ³n

Detectar inconsistencias.

---

## 19. Arquitectura de IA

No utilizar:

```text
Usuario â†’ LLM â†’ respuesta jurÃ­dica
```

Utilizar:

```text
Documento
    â†“
OCR
    â†“
ExtracciÃ³n
    â†“
ClasificaciÃ³n
    â†“
Retriever
    â†“
Base jurÃ­dica
    â†“
Motor de reglas
    â†“
LLM
    â†“
ValidaciÃ³n
    â†“
Resultado
```

La arquitectura de IA deberÃ¡ estar desacoplada del proveedor de modelos para permitir cambiar o combinar modelos posteriormente.

---

## 20. RAG jurÃ­dico

La plataforma deberÃ¡ utilizar Retrieval Augmented Generation.

Fuentes potenciales:

- ConstituciÃ³n;
- leyes;
- decretos;
- resoluciones;
- jurisprudencia;
- conceptos;
- normativa territorial;
- documentos oficiales.

Cada fuente deberÃ¡ contener como mÃ­nimo:

```text
id
title
type
authority
publication_date
effective_date
version
status
source_url
content
embedding
```

La fecha de vigencia deberÃ¡ ser considerada.

La IA no deberÃ¡ utilizar automÃ¡ticamente una norma actual para analizar hechos histÃ³ricos sin comprobar su aplicabilidad temporal.

---

## 21. Motor jurÃ­dico

Debe existir un componente independiente:

```text
legal-engine/
```

Responsabilidades:

- evaluar reglas;
- determinar requisitos;
- evaluar fechas;
- determinar informaciÃ³n faltante;
- identificar posibles actuaciones;
- asignar nivel de complejidad;
- activar revisiÃ³n profesional cuando corresponda.

La IA no deberÃ¡ ser la Ãºnica responsable de reglas determinÃ­sticas.

---

## 22. Motor de precios

Componente:

```text
pricing-engine/
```

Entrada:

```text
case_type
infraction_value
complexity
document_count
proceeding_count
professional_review
other_factors
```

Salida:

```text
base_price
additional_fees
discount
taxes_if_applicable
final_price
currency
```

Las reglas deberÃ¡n almacenarse de forma configurable.

No colocar tarifas directamente en componentes frontend.

---

## 23. Sistema de pagos

Flujo:

```text
Create Payment
â†“
Payment Gateway
â†“
Webhook
â†“
Verify Transaction
â†“
Update Payment
â†“
Activate Case
```

El backend deberÃ¡ validar el pago mediante webhook.

Nunca se deberÃ¡ activar un caso Ãºnicamente porque el frontend indique que el pago fue exitoso.

---

## 24. Notificaciones

Canales potenciales:

- email;
- notificaciones internas;
- eventualmente WhatsApp/SMS.

Eventos:

- nuevo caso;
- documento pendiente;
- pago confirmado;
- cambio de estado;
- documento generado;
- actuaciÃ³n realizada;
- respuesta recibida;
- tarea pendiente.

---

## 25. AuditorÃ­a

Toda acciÃ³n importante deberÃ¡ generar un `AuditLog`.

Ejemplo:

```text
user_id
case_id
action
entity
entity_id
previous_value
new_value
timestamp
ip
user_agent
```

---

## 26. Seguridad

Implementar desde el comienzo:

- autenticaciÃ³n segura;
- autorizaciÃ³n por roles;
- control de acceso por recurso;
- cifrado en trÃ¡nsito;
- almacenamiento seguro;
- validaciÃ³n de archivos;
- lÃ­mites de tamaÃ±o;
- protecciÃ³n contra ataques comunes;
- rate limiting;
- logs;
- backups;
- gestiÃ³n segura de secretos.

Nunca almacenar claves API directamente en el cÃ³digo.

---

## 27. Control de acceso

El backend deberÃ¡ verificar:

```text
Â¿QuiÃ©n es el usuario?
â†“
Â¿QuÃ© rol tiene?
â†“
Â¿QuÃ© recurso solicita?
â†“
Â¿Tiene permiso?
â†“
Â¿Ese recurso pertenece a su Ã¡mbito?
```

Un usuario nunca deberÃ¡ poder consultar el expediente de otro usuario simplemente cambiando un ID en una URL.

---

## 28. API

Ejemplos iniciales:

```text
POST   /api/auth/register
POST   /api/auth/login

GET    /api/cases
POST   /api/cases
GET    /api/cases/:id
PATCH  /api/cases/:id

POST   /api/cases/:id/documents
GET    /api/cases/:id/documents

POST   /api/cases/:id/analyze
GET    /api/cases/:id/analysis

POST   /api/cases/:id/price
POST   /api/cases/:id/payment

GET    /api/cases/:id/proceedings
POST   /api/cases/:id/proceedings
```

La definiciÃ³n completa se desarrollarÃ¡ en `API_SPEC.md`.

---

## 29. Testing

MÃ³dulos crÃ­ticos deberÃ¡n tener pruebas:

- autenticaciÃ³n;
- autorizaciÃ³n;
- creaciÃ³n de casos;
- cÃ¡lculo de precios;
- pagos;
- webhooks;
- acceso a documentos;
- motor jurÃ­dico;
- cambios de estado;
- generaciÃ³n de documentos.

Tipos:

```text
Unit Tests
Integration Tests
API Tests
Security Tests
E2E Tests
```

---

## 30. Desarrollo con Claude

Claude deberÃ¡ trabajar incrementalmente.

NO deberÃ¡ intentar crear toda la aplicaciÃ³n en una sola operaciÃ³n.

Antes de modificar cÃ³digo deberÃ¡ consultar:

```text
PROJECT_SPEC.md
```

y los documentos tÃ©cnicos especÃ­ficos disponibles.

Orden recomendado:

```text
1. Arquitectura
2. InicializaciÃ³n
3. Base de datos
4. AutenticaciÃ³n
5. Usuarios
6. Casos
7. Documentos
8. Pricing Engine
9. Pagos
10. IA
11. RAG
12. Panel profesional
13. Panel administrativo
14. Notificaciones
15. AuditorÃ­a
16. Testing
17. Seguridad
18. Deploy
```

---

## 31. Reglas para Claude

Claude NO deberÃ¡:

- cambiar la arquitectura sin autorizaciÃ³n;
- eliminar funcionalidades existentes sin autorizaciÃ³n;
- introducir dependencias innecesarias;
- duplicar lÃ³gica;
- colocar secretos en el cÃ³digo;
- crear reglas jurÃ­dicas sin fuente;
- inventar informaciÃ³n jurÃ­dica;
- modificar el esquema de base de datos sin actualizar la documentaciÃ³n;
- modificar APIs sin actualizar `API_SPEC.md`.

Cuando detecte una decisiÃ³n arquitectÃ³nica importante deberÃ¡ explicarla antes de implementarla.

---

## 32. DocumentaciÃ³n

El repositorio deberÃ¡ contener:

```text
/docs

PROJECT_SPEC.md
DATABASE_SPEC.md
API_SPEC.md
AI_SPEC.md
LEGAL_ENGINE_SPEC.md
PRICING_SPEC.md
SECURITY_SPEC.md
DEPLOYMENT.md
TESTING.md
```

La documentaciÃ³n deberÃ¡ mantenerse sincronizada con el cÃ³digo.

---

## 33. MVP

### Incluido

- Registro.
- Login.
- Dashboard.
- CreaciÃ³n de casos.
- Carga de documentos.
- OCR.
- ExtracciÃ³n bÃ¡sica.
- DiagnÃ³stico preliminar.
- Motor inicial de precios.
- Pago.
- Expediente.
- Estados.
- Panel administrativo bÃ¡sico.
- GeneraciÃ³n de documentos.
- Notificaciones bÃ¡sicas.

### No prioritario inicialmente

- AplicaciÃ³n mÃ³vil nativa.
- WhatsApp avanzado.
- AutomatizaciÃ³n completa de radicaciÃ³n.
- Integraciones masivas con autoridades.
- Cobertura de todos los tipos de procesos.
- AutomatizaciÃ³n jurÃ­dica sin revisiÃ³n.
- Marketplace de abogados.

---

## 34. Roadmap

### FASE 0 â€” DiseÃ±o

DocumentaciÃ³n y arquitectura.

### FASE 1 â€” Foundation

Repositorio, stack, base de datos, autenticaciÃ³n.

### FASE 2 â€” Cases

CreaciÃ³n y administraciÃ³n de expedientes.

### FASE 3 â€” Documents

Carga, almacenamiento y OCR.

### FASE 4 â€” Pricing

Motor de valoraciÃ³n.

### FASE 5 â€” Payments

IntegraciÃ³n de pagos.

### FASE 6 â€” Legal AI

RAG + motor jurÃ­dico + anÃ¡lisis.

### FASE 7 â€” Professionals

Panel y gestiÃ³n profesional.

### FASE 8 â€” Administration

Dashboard administrativo completo.

### FASE 9 â€” Security

AuditorÃ­a y pruebas de seguridad.

### FASE 10 â€” MVP Production

Deploy y pruebas con usuarios controlados.

---

## 35. Escalabilidad

La plataforma deberÃ¡ evolucionar desde:

```text
Personas
   â†“
Infracciones de trÃ¡nsito
```

hacia:

```text
Personas
   â†“
TrÃ¡nsito
   â†“
Transporte
   â†“
Empresas
   â†“
Flotas
   â†“
Otros procedimientos administrativos
```

Por ello, el modelo `Case` deberÃ¡ mantenerse suficientemente genÃ©rico.

---

## 36. Arquitectura final esperada

```text
                         USERS
                           â”‚
                           â–¼
                      FRONTEND
                       Next.js
                           â”‚
                           â–¼
                         API
                    Node / TypeScript
                           â”‚
        â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¼â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
        â”‚                  â”‚                  â”‚
        â–¼                  â–¼                  â–¼
    PostgreSQL          Storage             AI
        â”‚                                     â”‚
        â”‚                              â”Œâ”€â”€â”€â”€â”€â”€â”´â”€â”€â”€â”€â”€â”€â”
        â”‚                              â”‚             â”‚
        â–¼                              â–¼             â–¼
   Case Engine                    RAG Engine    LLM Layer
        â”‚                              â”‚             â”‚
        â–¼                              â””â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”˜
 Pricing Engine                               â”‚
        â”‚                                     â–¼
        â–¼                              Legal Engine
   Payment Engine                            â”‚
        â”‚                                     â–¼
        â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â–º Professional
                                              Review
                                                â”‚
                                                â–¼
                                           User Case
```

---

## 37. Principio principal

> La inteligencia artificial asiste el proceso; no sustituye automÃ¡ticamente la responsabilidad jurÃ­dica profesional cuando esta sea necesaria.

La plataforma debe ser capaz de identificar cuÃ¡ndo un caso requiere revisiÃ³n humana.

---

## 38. PrÃ³ximo documento

Una vez validado este `PROJECT_SPEC.md`, el siguiente documento serÃ¡:

`DATABASE_SPEC.md`

Ese documento definirÃ¡:

- tablas;
- campos;
- tipos;
- relaciones;
- claves;
- Ã­ndices;
- estados;
- restricciones;
- auditorÃ­a;
- versionamiento;
- seguridad.

No se deberÃ¡ construir la base de datos definitiva hasta completar y revisar ese diseÃ±o.

---

## 39. Decisiones arquitectÃ³nicas aprobadas

Esta secciÃ³n se aÃ±adiÃ³ al aprobar la arquitectura (2026-09-24). El contenido de las secciones 1 a 38 no se modificÃ³. Cuando una decisiÃ³n aprobada se aparta de lo escrito arriba, prevalece la decisiÃ³n registrada aquÃ­ y en los ADR.

**Documentos de referencia:** `ARCHITECTURE_REPORT.md`, `adr/ADR-001-stack-and-monorepo.md`, `adr/ADR-002-authentication.md`, `adr/ADR-003-roles-and-authorization.md`, `DATABASE_SPEC.md`, `SECURITY_SPEC.md`, `API_SPEC.md`.

**Decisiones que aclaran o modifican la spec**

- **s.14, s.21, s.22:** `ai`, `legal-engine` y `pricing-engine` son paquetes independientes del monorepo (`packages/`). Los mÃ³dulos `legal/` y `pricing/` de la API son adaptadores finos (ADR-001).
- **s.14, s.18:** el trabajo asÃ­ncrono (OCR, extracciÃ³n, embeddings, anÃ¡lisis) se ejecuta en un worker separado con cola pg-boss sobre PostgreSQL (ADR-001).
- **s.15:** las tablas `Role` y `Permission` no se crean en el MVP. Los roles son un enum y la matriz de permisos vive en cÃ³digo (ADR-003).
- **s.26, s.27:** autenticaciÃ³n con sesiones opacas en cookie `httpOnly`, Argon2id, CSRF, verificaciÃ³n de email, rate limiting y MFA obligatorio para ADMIN y SUPER_ADMIN antes de producciÃ³n (ADR-002).
- **s.30, s.34, s.38:** `DATABASE_SPEC.md` se desarrolla de forma incremental por rebanadas aprobadas. El Sprint 1 solo define `User`, `Session`, tokens de verificaciÃ³n y recuperaciÃ³n, y `AuditLog`. El Sprint 1 se divide en 1A (base tÃ©cnica) y 1B (autenticaciÃ³n).
- **s.20:** pgvector queda reservado para la fase de Legal AI/RAG; no se instala ni configura antes.
- **ConvenciÃ³n de idioma:** cÃ³digo, base de datos y API en inglÃ©s; interfaz y rutas visibles al usuario en espaÃ±ol.
- **Exclusiones:** no se introducen microservicios, Redis, GraphQL, LangChain, LlamaIndex ni una vector DB separada salvo que un ADR posterior lo justifique.

**Decisiones pendientes de validaciÃ³n jurÃ­dica colombiana (fuera del alcance tÃ©cnico)**

QuiÃ©n presta el servicio jurÃ­dico, autorizaciÃ³n o mandato para actuar ante las autoridades, tÃ©rminos y condiciones, reembolsos, tratamiento jurÃ­dico de los casos, alcance profesional del servicio y polÃ­tica de datos personales (retenciÃ³n, borrado, consentimiento, transferencia internacional).
