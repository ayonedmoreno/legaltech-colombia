# Evaluación de proveedores de OCR (P4)

**Tipo:** documento de trabajo, **no normativo** (decisión OCR-A9 del 2026-10-01). Las reglas están en `DATABASE_SPEC.md`, `API_SPEC.md` y `SECURITY_SPEC.md`; las decisiones, en `ARCHITECTURE_REPORT.md`. Este documento recoge el protocolo de la evaluación y, cuando existan, sus resultados.
**Fecha:** 2026-10-01
**Estado:** ronda 1 (documentos sintéticos, OCR local) ejecutada el 2026-10-02. **No hay ningún proveedor elegido: P4 sigue abierta** y exige la ronda 2, con documentos reales anonimizados (8a, bloqueada).
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

### Ronda 1: documentos sintéticos con OCR local (2026-10-02)

**Cómo se hizo:**
- **Instrumento:** `tools/ocr-evaluation/` (aislado de la aplicación; `bash tools/ocr-evaluation/run.sh`).
- **Motor:** Tesseract 5.5.0 con español, en local, en una máquina de 16 CPU y un solo proceso por página. Ningún documento salió de la máquina, y no se usó ningún proveedor, cuenta ni credencial externa.
- **Documentos:** 30 archivos sintéticos (semilla 20261002, A4 a 200 ppp):
  - 6 imágenes en 4 variantes: PNG limpio, JPEG limpio, foto de móvil simulada (girada, borrosa, con ruido) y JPEG guardado de lado que solo aparece derecho por la etiqueta EXIF;
  - PDF digitales (con capa de texto) y escaneados (solo imágenes) de 1, 5 y 20 páginas.

  Cada página tiene su texto verdadero, que se usa como referencia.
- **Métrica de calidad:** CER, la proporción de caracteres erróneos frente a ese texto verdadero.
- **Datos guardados aquí:** solo métricas, nunca contenido.

| Grupo (tipo · método) | Páginas | CER medio | CER máx. | Texto medio/página | Texto máx./página | s/página p50 | s/página p95 |
|---|---|---|---|---|---|---|---|
| PNG limpio · original | 6 | 0,0004 | 0,0005 | 2.417 B | 2.778 B | 2,41 | 2,45 |
| JPEG limpio · original | 6 | 0,0004 | 0,0005 | 2.417 B | 2.778 B | 2,88 | 3,00 |
| JPEG limpio · sin metadata | 6 | 0,0004 | 0,0005 | 2.417 B | 2.778 B | 2,80 | 2,97 |
| Foto de móvil · original | 6 | 0,130 | 0,775 | 2.144 B | 2.778 B | 2,85 | 2,96 |
| Foto de móvil · sin metadata | 6 | 0,130 | 0,775 | 2.144 B | 2.778 B | 2,92 | 2,95 |
| JPEG de lado (EXIF) · original, sin detección de orientación | 6 | 0,854 | 0,863 | 2.363 B | 2.731 B | 2,89 | 3,08 |
| JPEG de lado (EXIF) · sin metadata, sin detección de orientación | 6 | 0,854 | 0,863 | 2.363 B | 2.731 B | 2,92 | 2,96 |
| JPEG de lado (EXIF) · original, con detección de orientación | 6 | 0,0004 | 0,0005 | 2.417 B | 2.778 B | 3,31 | 3,48 |
| JPEG de lado (EXIF) · sin metadata, con detección de orientación | 6 | 0,0004 | 0,0005 | 2.417 B | 2.778 B | 3,35 | 3,51 |
| PDF digital · capa de texto | 26 | 0,0000 | 0,0000 | 2.000 B | 2.693 B | 0,06 | 0,06 |
| PDF digital · rasterizado + OCR | 26 | 0,0001 | 0,0005 | 1.999 B | 2.692 B | 2,85 | 3,31 |
| PDF escaneado · rasterizado + OCR | 26 | 0,304 | 0,973 | 1.362 B | 2.692 B | 4,86 | 5,71 |

«Detección de orientación» es el modo de Tesseract que corrige el giro de la página (`--psm 1`); sin ella se usó `--psm 3`. El tamaño del texto se mide en UTF-8 tras la normalización técnica de OCR-A10.4.

**Lectura por medición** (solo lo que los sintéticos permiten):
- **B8 (tamaño del texto):**
  - entre 1,4 y 2,8 KB por página; documentos de 20 páginas, entre 25 y 40 KB;
  - el peor caso de un PDF escaneado de 10 MiB (unas 37 páginas como estas) es de unos 100 KB;
  - un PDF digital de 10 MiB puede tener miles de páginas, así que el tope real de texto por documento lo pone el límite de páginas (B7): unas 2,8 KB por el número de páginas permitido;
  - limitación: las páginas reales pueden ser más densas que las sintéticas; la ronda 2 lo verificará.
- **B3 (original o copia sin metadata):**
  - mismo resultado en todos los casos, porque la copia del worker no recodifica los píxeles;
  - perder la etiqueta EXIF `Orientation` no cambia nada con este motor, que la ignora: lee los píxeles tal como están guardados, tanto en el original como en la copia;
  - lo que corrige una página de lado es la detección de orientación del propio motor;
  - con un proveedor que sí respete EXIF, la copia sin metadata podría comportarse distinto: hay que medirlo en cada candidato.
- **B4 (PDF):**
  - en un PDF digital, la capa de texto es exacta y unas 50 veces más rápida (0,06 s frente a 2,9 s por página), pero puede no coincidir con lo que se ve;
  - un PDF escaneado no tiene capa de texto y obliga a rasterizar;
  - rasterizar requiere un renderizador de PDF propio (más superficie de ataque, a aislar);
  - la decisión sigue abierta (B4, y P7 si el PDF fuera a un tercero).
- **B5 (tiempos, este motor):**
  - unos 2,4 a 3,5 s por página limpia y unos 5 s por página escaneada, con un solo núcleo; un documento de 37 páginas escaneadas tarda unos 3 minutos en serie;
  - consecuencia: el plazo de reclamo (`OCR_LEASE_SECONDS`) y la caducidad del job (900 s) limitan el tamaño de documento procesable en serie, o exigen paralelizar por páginas. Son valores a decidir, no decididos.
- **B7 (límites):**
  - un PDF escaneado como estos ocupa unos 270 KB por página: caben unas 37 páginas en 10 MiB;
  - un PDF digital ocupa unos 1,4 KB por página adicional, así que caben miles;
  - el límite de páginas por documento (`OCR_MAX_PAGES`) es necesario para acotar tiempo, coste y texto. Su valor no está decidido.
- **B2 (calidad): PROVISIONAL.**
  - con páginas limpias el error es casi nulo;
  - con fotos y escaneos simulados empeora mucho y de forma irregular (CER medio de 0,13 y 0,30, con páginas que llegan a 0,78 y 0,97);
  - los sintéticos no reflejan la calidad real: no justifican P4.
- **Idempotencia del proveedor:** no aplica a un motor local. Queda pendiente para cada candidato externo, si alguno llega a admitirse (OCR-C1).

### Insumo para OCR-A10.5

Con los tamaños de B8 (unos pocos KB por página, acotados por el límite de páginas), el responsable del producto decidió el 2026-10-03 guardar el texto en PostgreSQL y no contarlo para la cuota (`ARCHITECTURE_REPORT.md` §5). El límite de páginas por documento sigue **PENDIENTE DE DECISIÓN B7**: esta ronda lo midió, pero no lo decide.

## 5. Decisión

Sin decisión. Cuando se tome, P4 se registrará en `ARCHITECTURE_REPORT.md` con referencia a esta evaluación.

## Fuentes

- [AWS Textract: endpoints y cuotas](https://docs.aws.amazon.com/general/latest/gr/textract.html) · [precios de Textract](https://aws.amazon.com/textract/pricing/)
- [Google Document AI: regiones](https://docs.cloud.google.com/document-ai/docs/regions)
- [Azure Document Intelligence: límites](https://learn.microsoft.com/en-us/azure/ai-services/document-intelligence/service-limits) · [precios de Azure DI](https://azure.microsoft.com/en-us/pricing/details/ai-document-intelligence/)
- [Circular Externa SIC 005 de 2017](https://www.cancilleria.gov.co/sites/default/files/Normograma/docs/circular_superindustria_0005_2017.htm)
- [Decreto 1377 de 2013](https://www.funcionpublica.gov.co/eva/gestornormativo/norma.php?i=53646)
- [OCI: región de Bogotá](https://docs.oracle.com/en-us/iaas/releasenotes/changes/d332ad8f-ad0b-48f8-8577-33da7766ee36/index.htm)
