# Ventas por familia

Reporte solicitado el 2026-11-04. Entrada existente **Reportes → Reportes Financieros
→ Ventas por familia**, ahora habilitada. Conserva la matriz visual del reporte
de inventario por familia y sus equivalencias aproximadas de cantidades; el
cálculo monetario corresponde a **ventas brutas**, antes de descuentos, sin
restar devoluciones ni notas de crédito y sin IVA, por precisión del usuario
el mismo día. Sustituye el criterio neto de la implementación inicial.

| Vista | Etiqueta visible | Marcador / referencia | Procedencia | Endpoint | Tablas |
| --- | --- | --- | --- | --- | --- |
| Ventas por familia | Abrir / catálogos | No aplica: reporte nuevo | Derivada | GET /api/sales/reports/by-family/options | FALMCAT, FCIA, FINV, FFAM |
| Ventas por familia | Vista previa | Filtros INV_QUERY_VENTAS_CLIENTE / INV_QUERY_VENTAS_DESGLOSADAS; AIPREBR observado en facturas | Derivada | GET /api/sales/reports/by-family | FAXINV, FDOC, FINV, FCLI, FUNIDAD, FFAM |
| Ventas por familia | Mostrar / Detalle / Excel / PDF | Sin SQL adicional | Presentación | Respuesta vigente | Sin tablas adicionales |

## Evidencia y reglas

Las capturas literales anteriores de `product-buttons-capture.md`, marcadores
INV_QUERY_VENTAS_CLIENTE, INV_QUERY_VENTAS_DESGLOSADAS e INV_QUERY_VENTAS_ANUALES,
proyectan **AICANTF y AIPRECIO** y filtran DESFACT=1, AIMES=1, DEST=0,
DOTROSTXT<>'POS' y DCONTROLPOS=0. Ventas por cliente exige cliente existente y
distinto de cero y limita la compañía con DMULTICIA=1. La agregación por familia,
periodo y todas las sucursales es nueva y se etiqueta **derivada**: no se afirma
una nueva captura literal del reporte OMNIS ni se activó general_log.
`invoices-capture.md` incluye AIPREBR y el datasource de facturas lo expone como
grossPrice. Se verificaron partidas históricas donde AIPREBR difiere de AIPRECIO
por el descuento: por ejemplo AISEQ=473144, cantidad 1, AIPREBR=157.89299,
AIPRECIO=146.84048, AIDESCTO=7. Es evidencia de lectura de datos, no una nueva
captura de OMNIS. La sustitución por AIPREBR y AICANTF>0 es **derivada** para
atender la definición de ventas brutas solicitada.

- **FINV.ITIPO=1 es fijo** por solicitud del usuario. No se ofrece un parámetro
  HTTP para omitirlo. La consulta de familias también limita ITIPO=1.
- Familia: FINV.IFAMB → FFAM.FAMTNUM con FAMT='B'. El catálogo de FFAM se agrupa
  antes del join para no multiplicar las partidas. Se conserva Sin familia.
- Importe bruto: **SUM(AICANTF × AIPREBR)** para **AICANTF>0**. No usa AICOSTO, AICANT físico
  ni ILISTA4. Una venta puede tener AICANT físico negativo y AICANTF positivo.
- No se limita AITIPMV a FA. DESFACT=1 selecciona ventas y sus movimientos
  relacionados; AICANTF>0 conserva las ventas y excluye las devoluciones y créditos
  negativos. No se transforma su importe a positivo con ABS.
  En agosto de 2026 se observaron FA/FB/FC/FD/FV/FX/FZ y negativos CA/CB/CE/DB/DD/DH
  después de aplicar todos los filtros. No se codifica esa lista como exhaustiva.
- Cantidades originales y metros también usan únicamente ventas positivas;
  no se presentan cantidades netas junto al importe bruto.
- Se mantienen los filtros POS capturados para evitar la duplicación correspondiente.
  Se excluyen AICANTF<=0: no aportan al reporte de ventas brutas.
- Sucursal: FDOC.DMULTICIA, traducida al CATALM principal 01..07 con CATMULTICIA.
  Se incluyen ventas despachadas desde resguardos de esa compañía. No se filtra
  exclusivamente AIALMACEN=01 ni se usa AISUCURSAL como compañía del documento.
- Fechas inclusivas: DFECHA>=from y DFECHA<día siguiente de to. Un solo origen
  configurado; no se suman archivos anuales ni se cambia de base según el año.
  Documentos sin fecha verificable no se asignan al periodo. No existe escenario
  de movimientos sin fecha en este reporte de ventas.
- El importe usa precio bruto antes de descuentos, sin IVA ni cargos del encabezado.
  No aplica AIDESCTO ni descuentos generales, ni prorratea DDESC, DFLETE o DIVA.
  No se aplica una conversión de moneda adicional a AIPREBR.
  La presentación se titula Ventas brutas, sin
  declarar que es un estado contable de ingresos ni asignarle un ISO de moneda.
- Se preservan ocho decimales como texto SQL; el dominio usa enteros y redondea
  el bruto a centavos por producto/sucursal antes de sumar. No se sustituye un
  AIPREBR ausente por AIPRECIO ni se aplica descuento inverso. AIPREBR nulo o
  cero con AIPRECIO distinto de cero queda señalado en missingPrices como
  importe incompleto; conserva su cantidad. Un cero bruto y neto se conserva
  como venta de valor cero sin inventar un precio.
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
       CAST(SUM(COALESCE(a.AICANTF*a.AIPREBR,0)) AS CHAR) importe_bruto
FROM faxinv a
JOIN fdoc d ON d.DSEQ=a.DSEQ
JOIN finv i ON i.ISEQ=a.ISEQ
JOIN fcli c ON c.CLISEQ=a.CLISEQ AND c.CLISEQ<>0
WHERE i.ITIPO=?
  AND d.DFECHA>=? AND d.DFECHA<?
  AND a.AIMES=1 AND d.DEST=0 AND d.DESFACT=1
  AND d.DOTROSTXT<>'POS' AND d.DCONTROLPOS=0
  AND a.AICANTF>0
  AND d.DMULTICIA=?
GROUP BY i.ISEQ,i.ICOD,i.IFAMB,d.DMULTICIA;
```

Ejemplo de parámetros: `[1,'2026-08-01','2026-09-01',1]`. all elimina el predicado
de compañía; family agrega TRIM(i.IFAMB)=? enlazado. El datasource agrega las
proyecciones de descripción, UM, precios brutos ausentes, fechas y tipos del movimiento.

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

## Validación del ajuste a ventas brutas (2026-11-04)

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
