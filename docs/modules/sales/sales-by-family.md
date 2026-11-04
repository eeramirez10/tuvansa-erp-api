# Ventas por familia

Reporte solicitado el 2026-11-04. Entrada existente **Reportes → Reportes Financieros
→ Ventas por familia**, ahora habilitada. Conserva la matriz visual del reporte
de inventario por familia y sus equivalencias aproximadas de cantidades; el
cálculo monetario corresponde a ventas, no a costo de inventario.

| Vista | Etiqueta visible | Marcador / referencia | Procedencia | Endpoint | Tablas |
| --- | --- | --- | --- | --- | --- |
| Ventas por familia | Abrir / catálogos | No aplica: reporte nuevo | Derivada | GET /api/sales/reports/by-family/options | FALMCAT, FCIA, FINV, FFAM |
| Ventas por familia | Vista previa | Reglas de INV_QUERY_VENTAS_CLIENTE / INV_QUERY_VENTAS_DESGLOSADAS | Derivada | GET /api/sales/reports/by-family | FAXINV, FDOC, FINV, FCLI, FUNIDAD, FFAM |
| Ventas por familia | Mostrar / Detalle / Excel / PDF | Sin SQL adicional | Presentación | Respuesta vigente | Sin tablas adicionales |

## Evidencia y reglas

Las capturas literales anteriores de `product-buttons-capture.md`, marcadores
INV_QUERY_VENTAS_CLIENTE, INV_QUERY_VENTAS_DESGLOSADAS e INV_QUERY_VENTAS_ANUALES,
proyectan **AICANTF y AIPRECIO** y filtran DESFACT=1, AIMES=1, DEST=0,
DOTROSTXT<>'POS' y DCONTROLPOS=0. Ventas por cliente exige cliente existente y
distinto de cero y limita la compañía con DMULTICIA=1. La agregación por familia,
periodo y todas las sucursales es nueva y se etiqueta **derivada**: no se afirma
una nueva captura literal del reporte OMNIS ni se activó general_log.

- **FINV.ITIPO=1 es fijo** por solicitud del usuario. No se ofrece un parámetro
  HTTP para omitirlo. La consulta de familias también limita ITIPO=1.
- Familia: FINV.IFAMB → FFAM.FAMTNUM con FAMT='B'. El catálogo de FFAM se agrupa
  antes del join para no multiplicar las partidas. Se conserva Sin familia.
- Importe registrado: **SUM(AICANTF × AIPRECIO)**. No usa AICOSTO, AICANT físico
  ni ILISTA4. Una venta puede tener AICANT físico negativo y AICANTF positivo.
- No se limita AITIPMV a FA. DESFACT=1 selecciona ventas y sus movimientos
  relacionados; los signos de AICANTF conservan devoluciones y créditos.
  En agosto de 2026 se observaron FA/FB/FC/FD/FV/FX/FZ y negativos CA/CB/CE/DB/DD/DH
  después de aplicar todos los filtros. No se codifica esa lista como exhaustiva.
- La separación ventas/cargos y devoluciones/créditos se hace por signo del importe,
  sin convertir a positivo el neto ni asignar signos por el prefijo del folio.
- Se mantienen los filtros POS capturados para evitar la duplicación correspondiente.
  Se excluyen AICANTF=0: no aportan cantidad ni importe al reporte de ventas.
- Sucursal: FDOC.DMULTICIA, traducida al CATALM principal 01..07 con CATMULTICIA.
  Se incluyen ventas despachadas desde resguardos de esa compañía. No se filtra
  exclusivamente AIALMACEN=01 ni se usa AISUCURSAL como compañía del documento.
- Fechas inclusivas: DFECHA>=from y DFECHA<día siguiente de to. Un solo origen
  configurado; no se suman archivos anuales ni se cambia de base según el año.
  Documentos sin fecha verificable no se asignan al periodo. No existe escenario
  de movimientos sin fecha en este reporte de ventas.
- El importe sigue la expresión capturada, sin IVA ni cargos del encabezado.
  No reaplica AIDESCTO ni descuentos generales, ni prorratea DDESC, DFLETE o DIVA.
  No se aplica una conversión de moneda adicional a AIPRECIO; los filtros capturados
  suman ese precio registrado. La presentación se titula Importe registrado, sin
  declarar que es un estado contable de ingresos ni asignarle un ISO de moneda.
- Se preservan ocho decimales como texto SQL; el dominio usa enteros y redondea
  el neto a centavos por producto/sucursal antes de sumar. Las columnas positivas,
  negativas y netas se redondean cada una desde su suma exacta; pueden diferir por
  centavos si se restan las dos primeras ya redondeadas. Precio nulo queda señalado.
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

La respuesta `data` contiene criteria, productType:1, source:derivada, columns,
groups, totals, amount/saleAmount/returnAmount, meters, movements, missingPrices,
unconvertedProducts y notes. Por familia: importes, cantidades en metros, porcentajes,
celdas por sucursal y products. Por producto/sucursal: cantidad original, ventas,
devoluciones, neto exacto y redondeado, UM, conversión, tipos y fechas extremas.
Las columnas de todas las sucursales conservan las siete aunque alguna no tenga
ventas; una compañía no configurada se identifica sin atribuirla a México.

## Núcleo SQL derivado

```sql
SELECT i.ISEQ,i.ICOD,TRIM(i.IFAMB) familia,d.DMULTICIA,
       CAST(SUM(a.AICANTF) AS CHAR) cantidad,
       CAST(SUM(a.AICANTF*a.AIPRECIO) AS CHAR) importe
FROM faxinv a
JOIN fdoc d ON d.DSEQ=a.DSEQ
JOIN finv i ON i.ISEQ=a.ISEQ
JOIN fcli c ON c.CLISEQ=a.CLISEQ AND c.CLISEQ<>0
WHERE i.ITIPO=?
  AND d.DFECHA>=? AND d.DFECHA<?
  AND a.AIMES=1 AND d.DEST=0 AND d.DESFACT=1
  AND d.DOTROSTXT<>'POS' AND d.DCONTROLPOS=0
  AND a.AICANTF<>0
  AND d.DMULTICIA=?
GROUP BY i.ISEQ,i.ICOD,i.IFAMB,d.DMULTICIA;
```

Ejemplo de parámetros: `[1,'2026-08-01','2026-09-01',1]`. all elimina el predicado
de compañía; family agrega TRIM(i.IFAMB)=? enlazado. El datasource agrega las
proyecciones de descripción, UM, positivos/negativos, fechas y tipos del movimiento.

## Frontend y exportaciones

Ruta `/ventas/reportes/ventas-por-familia`. Ventana ERP compartida, shadcn/Base UI,
campos Desde/Hasta/Sucursal/Familia IFAMB. Mostrar alterna importe/metros sin HTTP.
La casilla de detalle pagina 100 productos/sucursales, conserva scroll X/Y y PDF
imprime todos los registros, no sólo la página visible. Cambiar filtros oculta
la respuesta anterior y bloquea exportar hasta regenerar. Estados carga/error,
reintento y vacío explícitos; Cancelar/Escape cierra la ventana.

Excel usa ExcelJS diferido con hojas Familias, Productos, Unidades originales y
Criterios. Matriz verde/total rojo con fórmulas de porcentajes y sumas, códigos
como texto e importes/cantidades numéricos. Productos conserva neto SQL exacto
como texto. PDF usa carta horizontal; matrices anchas se dividen en bloques de
tres sucursales y muestran el total general explícito.

## Lectura real inicial

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

## Validación final

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
