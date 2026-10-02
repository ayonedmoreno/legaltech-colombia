# Evaluación de proveedores de OCR (P4)

**Tipo:** documento de trabajo, **no normativo** (decisión OCR-A9 del 2026-10-01). Las reglas están en `DATABASE_SPEC.md`, `API_SPEC.md` y `SECURITY_SPEC.md`; las decisiones, en `ARCHITECTURE_REPORT.md`. Este documento recoge el protocolo de la evaluación y, cuando existan, sus resultados.
**Fecha:** 2026-10-01
**Estado:** protocolo en borrador. **La evaluación no ha empezado y no hay ningún proveedor elegido.**
**Referencias:** `ARCHITECTURE_REPORT.md` §5 («Fase 3: diseño del OCR») y §7 (P3, P4, P7); `DATABASE_SPEC.md`, «OCR del documento».

## 1. Qué debe decidir esta evaluación

Es el insumo de estas decisiones, que se registrarán en `ARCHITECTURE_REPORT.md`, no aquí:

| ID | Pregunta | Qué se mide |
|---|---|---|
| B1 / P4 | Proveedor de OCR | Comparación de los candidatos admitidos sobre el mismo conjunto de documentos |
| B2 | Calidad por tipo de documento | Exactitud del texto por tipo: comparendo, fotodetección, foto de móvil, escaneo, PDF digital |
| B3 | Original o copia sin metadata | Mismo resultado con ambas representaciones. Riesgo a comprobar: la copia pierde la etiqueta EXIF `Orientation`, y una foto de móvil puede llegar girada |
| B4 | PDF: rasterizado o capa de texto | Fidelidad, coste y superficie de ataque del renderizador (que debe aislarse) |
| B5 | Tiempos | Latencia p95 y p99, errores 429 y 5xx, modo síncrono o asíncrono; de aquí salen los timeouts, la espera, los intentos máximos y el plazo de reclamo |
| B6 | Coste | Coste por página y por documento, medio y máximo, con los precios verificados en la fecha de la prueba |
| B7 | Límites | Páginas por documento, tamaño del texto, concurrencia y TPS del proveedor; de aquí sale el límite de páginas por documento |
| B8 | Tamaño del texto | Tamaño típico y máximo por página y por documento, también con el historial de ejecuciones que se conserva (OCR-A10.3); decide **OCR-A10.5** (PostgreSQL u objeto privado, y si cuenta para la cuota) |
| OCR-A11, punto 8 | Idempotencia del proveedor | Si ofrece identificador de solicitud o idempotencia para trabajos asíncronos. Si no, el riesgo residual de pagar dos veces, su impacto económico y los límites de reintento quedan documentados aquí |

## 2. Documentos de prueba

| Ronda | Documentos | Estado |
|---|---|---|
| 1 | Sintéticos: creados para la prueba, sin datos personales reales, sin logos ni membretes de autoridades reales, con plantillas genéricas y generación reproducible | **Permitido (pregunta 8b, opción A, 2026-10-01).** Concluyente para B8 (con densidad de texto representativa), B5, B7, B4, B3 e idempotencia. B2 solo provisional. Dónde vive el generador se decide al preparar la prueba |
| 2 | Reales anonimizados, como exige `ARCHITECTURE_REPORT.md` §7 para P4 | **Bloqueado: pregunta 8a y OCR-C8.** Hay que decidir quién los aporta y quién los anonimiza, y obtener la validación jurídica, porque anonimizar documentos reales ya es tratamiento de datos personales |

Una ronda con documentos sintéticos **no basta** para decidir P4, y su resultado de calidad (B2) nunca justifica por sí solo la elección del proveedor. La decisión 8b **no autoriza** usar un proveedor externo, crear cuentas ni subir documentos: eso requerirá su propia autorización.

**Reglas durante la evaluación:**
- ningún documento real se envía a un proveedor externo sin la validación correspondiente (OCR-C1, P3);
- los resultados guardados aquí no contienen datos personales ni texto de documentos reales: solo métricas.

## 3. Candidatos

Los candidatos admitidos dependen de OCR-C1 (si se permite un OCR externo, bloqueada) y de P3 (región). Los datos son públicos, consultados el 2026-10-01, y **deben verificarse** en la fecha de la prueba.

| Candidato | Regiones relevantes | Notas |
|---|---|---|
| AWS Textract | EE. UU., Canadá, UE (incluida España), Asia. Ni São Paulo ni Colombia | `DetectDocumentText` publicado a 1,50 USD por cada 1.000 páginas. Menos TPS en regiones secundarias |
| Google Document AI | Multirregión `us` y `eu`, más regiones sueltas en Norteamérica, Europa, Asia y Oceanía. Ninguna en Sudamérica | Precio no verificado |
| Azure Document Intelligence (modelo Read) | Muchas regiones; Microsoft indica Brazil South (por confirmar para Read) | Ofrece contenedores autoalojados, con los que el documento no sale de nuestra infraestructura. S0: hasta 500 MB y 2.000 páginas |
| OCR autoalojado de código abierto (p. ej. Tesseract con español, PaddleOCR, docTR) | Nuestra propia infraestructura | Sin coste por página; calidad, cómputo y mantenimiento por medir |
| OCI Document Understanding | Disponibilidad en la región de Bogotá no verificada | Solo relevante si P3 elige Colombia |

**Marco jurídico de referencia** (a validar por un abogado; no es una decisión):
- Ley 1581 de 2012;
- Circular Externa SIC 005 de 2017: lista de países con nivel adecuado de protección, que incluye a EE. UU. y no a Brasil;
- Decreto 1377 de 2013, arts. 24 y 25: transmisión a un encargado mediante contrato.

## 4. Resultados

Sin resultados: la evaluación no ha empezado.

## 5. Decisión

Sin decisión. Cuando se tome, P4 se registrará en `ARCHITECTURE_REPORT.md` con referencia a esta evaluación.

## Fuentes

- [AWS Textract: endpoints y cuotas](https://docs.aws.amazon.com/general/latest/gr/textract.html) · [precios de Textract](https://aws.amazon.com/textract/pricing/)
- [Google Document AI: regiones](https://docs.cloud.google.com/document-ai/docs/regions)
- [Azure Document Intelligence: límites](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/service-limits) · [precios de Azure DI](https://azure.microsoft.com/en-us/pricing/details/ai-document-intelligence/)
- [Circular Externa SIC 005 de 2017](https://www.cancilleria.gov.co/sites/default/files/Normograma/docs/circular_superindustria_0005_2017.htm)
- [Decreto 1377 de 2013](https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=53646)
- [OCI: región de Bogotá](https://docs.oracle.com/en-us/iaas/releasenotes/changes/d332ad8f-ad0b-48f8-8577-33da7766ee36/index.htm)
