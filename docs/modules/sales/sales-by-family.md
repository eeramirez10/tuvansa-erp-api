# Ventas por familia

Reporte solicitado el 2026-11-04. Entrada existente **Reportes → Reportes Financieros
→ Ventas por familia**, ahora habilitada. Conserva la matriz visual del reporte
de inventario por familia y sus equivalencias aproximadas de cantidades; el
cálculo monetario corresponde a **ventas brutas: sólo facturas al precio
registrado AIPRECIO**, sin IVA. Criterio vigente indicado por el usuario el
2026-11-06: **MID(DNUM,1,1)='F' AND DSTATUSCFD=3 AND DESFACT=1**.
Sustituye la selección anterior por catálogo fiscal FTIPMV. No usa AIPREBR
ni revierte descuentos; las partidas elegibles conservan sus signos.

| Vista | Etiqueta visible | Marcador / referencia | Procedencia | Endpoint | Tablas |
| --- | --- | --- | --- | --- | --- |
| Ventas por familia | Abrir / catálogos | No aplica: reporte nuevo | Derivada | GET /api/sales/reports/by-family/options | FALMCAT, FCIA, FINV, FFAM |
| Ventas por familia | Vista previa | Filtros capturados de ventas; condición F/estado CFD 3 indicada por el usuario el 2026-11-06 | Derivada | GET /api/sales/reports/by-family | FAXINV, FDOC, FINV, FCLI, FUNIDAD, FFAM |
| Ventas por familia | Mostrar / Detalle / Excel / PDF | Sin SQL adicional | Presentación | Respuesta vigente | Sin tablas adicionales |

## Evidencia y reglas

**Criterio vigente:** folio que empieza por F, DSTATUSCFD=3, DESFACT=1 y precio
AIPRECIO. Las validaciones históricas al final conservan los criterios anteriores,
que ya no alimentan el reporte.

Las capturas literales anteriores de `product-buttons-capture.md`, marcadores
INV_QUERY_VENTAS_CLIENTE, INV_QUERY_VENTAS_DESGLOSADAS e INV_QUERY_VENTAS_ANUALES,
proyectan **AICANTF y AIPRECIO** y filtran DESFACT=1, AIMES=1, DEST=0,
DOTROSTXT<>'POS' y DCONTROLPOS=0. Ventas por cliente exige cliente existente y
distinto de cero y limita la compañía con DMULTICIA=1. La agregación por familia,
periodo y todas las sucursales es nueva y se etiqueta **derivada**: no se afirma
una nueva captura literal del reporte OMNIS ni se activó general_log.
La selección adicional aplica literalmente la condición indicada por el usuario.
No consulta FTIPMV ni limita a una serie de dos caracteres, DITIPMV o DESCXC.
El primer carácter F junto con DSTATUSCFD=3 determina la selección documental,
además de DESFACT=1. Esta regla es **derivada**, no una nueva captura de OMNIS.

- **FINV.ITIPO=1 es fijo** por solicitud del usuario. No se ofrece un parámetro
  HTTP para omitirlo. La consulta de familias también limita ITIPO=1.
- Familia: FINV.IFAMB → FFAM.FAMTNUM con FAMT='B'. El catálogo de FFAM se agrupa
  antes del join para no multiplicar las partidas. Se conserva Sin familia.
- Importe del reporte: **SUM(AICANTF × AIPRECIO)** en las facturas elegibles.
  No usa AIPREBR, AICOSTO, AICANT físico
  ni ILISTA4. Una venta puede tener AICANT físico negativo y AICANTF positivo.
- Selección documental exacta: `MID(d.DNUM,1,1)='F' AND d.DSTATUSCFD=3 AND d.DESFACT=1`.
  Se elimina la selección anterior por FTIPMV; no se agrega una lista de series.
- Se elimina AICANTF>0: cantidades negativas o cero de documentos elegibles
  se conservan, sin ABS ni asignación de signos por tipo de movimiento.
  Cantidades originales, metros, importes y conteos usan las mismas partidas.
- Se mantienen los filtros POS capturados para evitar la duplicación correspondiente.
  También se conservan AIMES=1, DEST=0 y cliente existente distinto de cero.
  Estos filtros heredados no son sustitutos de la condición documental nueva.
- Sucursal: FDOC.DMULTICIA, traducida al CATALM principal 01..07 con CATMULTICIA.
  Se incluyen ventas despachadas desde resguardos de esa compañía. No se filtra
  exclusivamente AIALMACEN=01 ni se usa AISUCURSAL como compañía del documento.
- Fechas inclusivas: DFECHA>=from y DFECHA<día siguiente de to. Un solo origen
  configurado; no se suman archivos anuales ni se cambia de base según el año.
  Documentos sin fecha verificable no se asignan al periodo. No existe escenario
  de movimientos sin fecha en este reporte de ventas.
- El importe usa AIPRECIO tal como está registrado, sin IVA ni cargos del encabezado.
  No revierte ni reaplica AIDESCTO o descuentos generales, ni prorratea DDESC,
  DFLETE o DIVA. No se aplica una conversión de moneda adicional a AIPRECIO.
  La presentación se titula Ventas brutas, sin
  declarar que es un estado contable de ingresos ni asignarle un ISO de moneda.
- Se preservan ocho decimales como texto SQL; el dominio usa enteros y redondea
  el importe a centavos por producto/sucursal antes de sumar. AIPRECIO nulo queda
  señalado en missingPrices como importe incompleto; conserva su cantidad.
  AIPRECIO=0 es un precio válido y no se reemplaza por AIPREBR.
- Las cantidades permanecen en la UM actual. Resumen alterno de metros estimados:
  TR/PZ × 6.40, M/MT/MTR × 1, FT × 0.3048. No convierte dinero. Unidades distintas
  permanecen en detalle y en Excel, sin mezclar su cantidad con los metros.
- Familia, tipo y unidad proceden del catálogo actual; no se presume un historial
  de reclasificaciones. La fecha/estado del documento son los disponibles al leer.

## HTTP y arquitectura

`GET /api/sales/reports/by-family/options` devuelve compañía, siete sucursales,
familias del tipo 1 y fechas predeterminadas: desde enero del año de México hasta
hoy. La sucursal inicial es 01 si existe; en otro caso todas.

`GET /api/sales/reports/by-family?from=2026-08-01&to=2026-08-31&branch=01&family=all`

- from/to: fechas ISO entre 1901 y 2100; from<=to.
- branch: 01..07 o all; predeterminado 01. El caso de uso obtiene companyId del
  catálogo, no de un identificador SQL enviado por el cliente.
- family: IFAMB disponible o all; predeterminado all. La familia vacía se conserva.
- Filtros repetidos, extra, tipo de producto distinto y nombres de bases se rechazan.
- GET únicamente, Cache-Control no-store. SQL parametrizado en infrastructure/datasources.
  Consultas por lote, sin N+1; tiempo SQL máximo 30 segundos y HTTP frontend 45 segundos.

La respuesta `data` contiene criteria, productType:1, basis:gross, source:derivada, columns,
groups, totals, amount bruto, meters, movements, missingPrices,
unconvertedProducts y notes. Por familia: importes, cantidades en metros, porcentajes,
celdas por sucursal y products. Por producto/sucursal: cantidad original vendida,
gross exacto y amount redondeado, UM, conversión, tipos y fechas extremas.
Se retiran sales/returns/net y saleAmount/returnAmount del contrato inicial neto
para evitar que los consumidores interpreten las ventas brutas como netas.
Las columnas de todas las sucursales conservan las siete aunque alguna no tenga
ventas; una compañía no configurada se identifica sin atribuirla a México.

## Núcleo SQL derivado

```sql
SELECT i.ISEQ,i.ICOD,TRIM(i.IFAMB) familia,d.DMULTICIA,
       CAST(SUM(a.AICANTF) AS CHAR) cantidad,
       CAST(SUM(COALESCE(a.AICANTF*a.AIPRECIO,0)) AS CHAR) importe_bruto
FROM faxinv a
JOIN fdoc d ON d.DSEQ=a.DSEQ
JOIN finv i ON i.ISEQ=a.ISEQ
JOIN fcli c ON c.CLISEQ=a.CLISEQ AND c.CLISEQ<>0
WHERE i.ITIPO=?
  AND d.DFECHA>=? AND d.DFECHA<?
  AND a.AIMES=1 AND d.DEST=0 AND d.DESFACT=1
  AND d.DOTROSTXT<>'POS' AND d.DCONTROLPOS=0
  AND MID(d.DNUM,1,1)='F' AND d.DSTATUSCFD=3
  AND d.DMULTICIA=?
GROUP BY i.ISEQ,i.ICOD,i.IFAMB,d.DMULTICIA;
```

Ejemplo de parámetros: `[1,'2026-08-01','2026-09-01',1]`. all elimina el predicado
de compañía; family agrega TRIM(i.IFAMB)=? enlazado. El datasource agrega las
proyecciones de descripción, UM, precios ausentes, fechas y tipos del movimiento.
`movementTypes` conserva AITIPMV para trazabilidad: puede mostrar FA aunque el
folio fiscal aceptado sea FE. No es el campo utilizado para decidir si es factura.

## Frontend y exportaciones

Ruta `/ventas/reportes/ventas-por-familia`. Ventana ERP compartida, shadcn/Base UI,
campos Desde/Hasta/Sucursal/Familia IFAMB. Mostrar alterna importe/metros sin HTTP.
La casilla de detalle pagina 100 productos/sucursales, conserva scroll X/Y y PDF
imprime todos los registros, no sólo la página visible. Cambiar filtros oculta
la respuesta anterior y bloquea exportar hasta regenerar. Estados carga/error,
reintento y vacío explícitos; Cancelar/Escape cierra la ventana.

Excel usa ExcelJS diferido con hojas Familias, Productos, Unidades originales y
Criterios. Matriz verde/total rojo con fórmulas de porcentajes y sumas, códigos
como texto e importes/cantidades numéricos. Productos conserva bruto SQL exacto
como texto. PDF usa carta horizontal; matrices anchas se dividen en bloques de
tres sucursales y muestran el total general explícito.

## Lectura real inicial (criterio neto anterior, sustituido por ventas brutas)

Agosto 2026, ITIPO=1: México devuelve 204 movimientos, 148 productos/sucursales,
15 familias y **9,504,958.34**. TCC México: 21 movimientos y **1,557,716.52**.
Todas las sucursales: 3,176 movimientos, 1,873 productos/sucursales, 22 familias y
**86,825,438.56**. Suma SQL sin redondear por partida: 86,825,438.49648080; la diferencia
de centavos corresponde a la política explícita de redondeo por producto/sucursal.
No son constantes del reporte. Se contrastaron las 3,176 partidas individuales
con Decimal y con la respuesta de la API real, incluyendo sus signos.

Evidencia privada en `captures/sql/new-version/sales/by-family-20261104/` y
`captures/ui/new-version/sales-by-family/`. Sólo SELECT/SHOW; sin migraciones,
activación de general_log, reinicios ni escrituras productivas.

## Validación inicial (criterio neto anterior)

- Backend: pnpm lint/build/test aprobados, **185 pruebas** (11 nuevas para este
  reporte). Cubren filtros, signos, tipo 1, fechas/compañías/familias, precisión,
  metros, nulos de porcentaje, vacío, SQL parametrizado y repository delegado.
- Frontend: pnpm lint/typecheck/build aprobados. Navegación desde el menú y ruta
  directa, filtros, modos sin HTTP adicional, scroll XY y paginación 100/48,
  errores/reintento, vacío, rango invertido, bloqueo de exportación obsoleta y
  Escape verificados con navegador y API real. Se reutilizan los atajos de la
  ventana compartida con tone=sales.
- Cuatro Excel descargados contrastados contra la API y recalculados en Excel
  nativo, sin errores de fórmula ni modificación de SHA-256. PDF revisados
  visualmente: México resumen 1 página, detalle completo 7 páginas; todas las
  sucursales resumen en 3 páginas, manteniendo encabezados, totales y notas.
- Consulta anual 01/01–04/11/2026, todas las sucursales: 30,506 movimientos y 8,394
  productos/sucursales, completada en aproximadamente 10.2 segundos. Se valida
  el periodo inicial anual además del ejemplo mensual.
- general_log **OFF** y MySQL80 **Running** al terminar. No se ejecutaron escrituras,
  migraciones ni reinicios, y no se cambió configuración de Firebase.

## Validación anterior con AIPREBR (sustituida por la aclaración de sólo facturas)

- Agosto 2026, México: **9,505,873.55**, 203 movimientos, 148 productos/sucursales,
  15 familias. TCC México: **1,557,716.52**, 21 movimientos y 11 productos.
  Todas las sucursales: **87,938,897.67**, 3,137 movimientos, 1,864 productos/sucursales
  y 22 familias. Se conciliaron las partidas individuales de cantidad positiva
  con Decimal, precio AIPREBR y redondeo por producto/sucursal.
- El 06/07/2023, todas las sucursales: 88 movimientos, bruto **4,229,243.66**,
  frente a **4,229,232.61** usando AIPRECIO en las mismas partidas positivas.
  La diferencia de 11.05 confirma el precio anterior al descuento; incluye
  AISEQ=473144 (AIPREBR=157.89299, AIPRECIO=146.84048, descuento 7%). No se
  cambia de base para este ejercicio: son registros históricos del origen configurado.
- Lint/build y las **185 pruebas** del backend aprobados; frontend lint,
  typecheck y build aprobados. Navegador con API real: menú/ruta directa,
  totales brutos, 12 columnas de detalle sin neto/créditos, paginación 100/48,
  metros sin HTTP, filtros, errores/reintento, vacío, Escape y exportación vigente.
- Cuatro Excel conciliados con la API y recalculados en Excel nativo sin errores
  de fórmula ni cambios de SHA-256. PDF revisados visualmente: México resumen
  una página, detalle completo cinco, siete sucursales en tres páginas.
- Evidencia nueva privada en `captures/sql/new-version/sales/gross-by-family-20261104/`
  y `captures/ui/new-version/sales-by-family-gross/`; no sustituye los artefactos
  anteriores. Lecturas SELECT/SHOW únicamente. general_log **OFF** y MySQL80
  **Running**, sin reinicios ni cambios de configuración.

## Validación anterior por catálogo fiscal (2026-11-04; sustituida)

- Agosto 2026, México: **9,493,745.19**, 178 partidas, 146 productos/sucursales,
  15 familias. Todas las sucursales: **87,926,769.31**, 3,112 partidas, 1,862
  productos/sucursales, 22 familias. TCC México conserva **1,557,716.52**.
  Se excluyen 25 partidas de remisiones FA por 12,128.34833840 sin redondear.
  No se cambia el precio ni se revierte un descuento: sólo AICANTF × AIPRECIO.
- Conciliación independiente con Decimal sobre partidas individuales, separando
  folios fiscales del conjunto completo de ventas positivas. También se comparan
  los productos esperados para detectar tanto omisiones como inclusiones indebidas.
- Regresión del 06/07/2023: **4,229,232.61**, 88 partidas de facturas. AISEQ=473144
  pertenece a FE0057528: utiliza AIPRECIO=146.84048, no AIPREBR=157.89299.
  El cálculo anterior con AIPREBR daría 4,229,243.66 y ya no se utiliza.
- Backend lint/build/test aprobados, 185 pruebas. Frontend lint/typecheck/build
  aprobados. Navegador y API reales verifican menú/ruta directa, cifras, tipos,
  paginación 100/46, scroll, filtros, metros, error/reintento, vacío, Escape y
  bloqueo de exportaciones obsoletas. Cuatro Excel conciliados y recalculados
  en Excel nativo sin errores de fórmula ni cambios de SHA-256. PDF revisado:
  resumen México una página, detalle cinco; siete sucursales tres páginas.
- Evidencia privada en `captures/sql/new-version/sales/invoice-only-by-family-20261104/`
  y `captures/ui/new-version/sales-by-family-invoices/`. Procedencia derivada,
  sólo SELECT/SHOW; general_log **OFF**, MySQL80 **Running**. Sin escrituras ni reinicios.

## Validación vigente: folio F, DSTATUSCFD=3 y DESFACT=1 (2026-11-06)

- Se aplica exactamente la condición documental indicada por el usuario,
  conservando ITIPO=1, fechas/sucursal/familia y los filtros heredados documentados.
  Se retiran tanto EXISTS/FTIPMV como AICANTF>0. El importe sigue siendo
  AICANTF × AIPRECIO, con signos y ceros; no AIPREBR ni ABS.
- Agosto 2026: México **9,493,745.19**, 194 partidas, 147 productos/sucursales,
  15 familias. Todas las sucursales **87,884,874.27**, 3,166 partidas, 1,872
  productos/sucursales, 22 familias. TCC México **1,557,716.52**, 21 partidas.
  El conjunto incluye 56 partidas con cantidad cero y ninguna negativa en ese
  mes; no se presupone que otros periodos carezcan de ajustes negativos.
- Se conciliaron partidas, cantidades, importes exactos, redondeo, productos
  esperados y totales con Decimal. La selección independiente comprueba el primer
  carácter F, DSTATUSCFD=3 y DESFACT=1; no reutiliza el catálogo fiscal anterior.
- Backend lint/build/test aprobados, **186 pruebas**. Frontend lint/typecheck/build
  aprobados. Navegador y API reales: menú/ruta directa, condición visible, totales,
  paginación 100/47, scroll, filtros, metros sin HTTP, errores/reintento, vacío,
  Escape y bloqueo de exportaciones obsoletas.
- Cuatro Excel contrastados con la API (matrices, resultados de fórmulas guardados,
  productos e importes exactos); PDF revisados, México una página de resumen y
  cinco de detalle, todas las sucursales tres de resumen. El recálculo adicional
  en Excel nativo no se completó: COM HRESULT 0x800AC472 en este entorno. No se
  presenta como validado el recálculo nativo de esta revisión.
- Evidencia privada en `captures/sql/new-version/sales/f-status3-by-family-20261106/`
  y `captures/ui/new-version/sales-by-family-status3-20261106/`. Procedencia derivada
  a partir del criterio indicado, sin nueva captura de OMNIS. Sólo SELECT/SHOW;
  general_log **OFF**, MySQL80 **Running**; sin escrituras ni reinicios.
