# Comisiones por cobranza — extracción preliminar

Solicitud del 2026-11-06. Referencias locales proporcionadas: UNO.pdf, DOS.pdf y
TRES.pdf, exportaciones de métodos OMNIS de la clase PROSCAI.MREPESP01. Se leyeron
completos (1/2/1 páginas) y se revisaron sus páginas visualmente. No son logs de
MySQL: el SQL de esta implementación es **derivado de código proporcionado**,
no se afirma una captura real de OMNIS ni se activa general_log.

## Estado y dato imprescindible pendiente

UNO llama al método 211 para desglosado y 212 para totalizado. DOS contiene 211,
que llama a **214_Calcula_Costo_de__Facturas**; TRES contiene 213, la consulta base.
No se proporcionó 214 ni una regla de importe/porcentaje de comisión. Tampoco se
proporcionó 212. El método 214 produce las variables de COSTO, COSTO REAL, LM y
LM_VALOR necesarias para calcular UTILIDAD y %. No se sustituyen por DCOM2,
costos actuales de FINV, AICOSTO multiplicado por una cantidad supuesta ni ceros.

La extracción se publica explícitamente como **PRELIMINAR**, con
`status: preliminary`, `calculationReady: false` y valores null en costo,
costo real, utilidad, margen, LM, LM_VALOR e importe de comisión. Excel los
deja en blanco y explica que faltan reglas; no representa comisiones a pagar.
El resumen por agente suma los importes confirmados, es derivado y no pretende
reproducir el método 212 no disponible.

| Vista | Botón visible | Referencia / marcador | Procedencia | Endpoint | Tablas |
| --- | --- | --- | --- | --- | --- |
| Reportes Contabilidad / Reportes Financieros | Comisiones por cobranza | Métodos 211/213 de PDF; sin marcador MySQL | Derivada | GET /api/sales/reports/collection-commissions/options | FALMCAT, FAG, FCIA |
| Comisiones por cobranza | Vista previa | Métodos 211/213; sin captura nueva | Derivada | GET /api/sales/reports/collection-commissions | FAX, FDOC, FCLI, FAG, FAXINV, FINV |
| Comisiones por cobranza | Resumen por agente / Descargar Excel preliminar | Presentación de respuesta vigente | Derivada/presentación | Sin HTTP adicional | Sin SQL adicional |

## Reglas verificadas y adaptación

- El intervalo inclusivo corresponde a **FAX.AFECHA**, no FDOC.DFECHA. Se usa
  AFECHA>=from y AFECHA<día siguiente de to. Las facturas pueden ser de otro mes,
  tener pagos parciales o varios pagos dentro del mismo intervalo.
- La factura necesita al menos un movimiento **ATIPMV='PA'** dentro del intervalo.
  Los movimientos cuyo ATIPMV empieza por D aportan devoluciones en ese mismo
  intervalo. Una devolución sin PA no genera factura en el reporte: precisión de
  la solicitud respecto a la consulta 213, que no tiene ese HAVING.
- Se conserva DCANCELADA=0 y la exclusión AF del método 213. Se limita a facturas
  de venta con DESFACT=1 y folio F, derivado del alcance solicitado. Esto evita,
  por ejemplo, PA vinculados a documentos GI de proveedor observados en la base.
  No se heredan DSTATUSCFD=3, DEST=0, AMES=1 ni filtros POS de otros reportes: no
  aparecen en el procedimiento proporcionado. En el origen, todos los PA
  inspeccionados tienen AMES=1, pero no se inventa ese requisito adicional.
- Sin IVA, según 213: `ACANT/(1+DPORCIVA/100)`. Se preservan los signos de FAX;
  los abonos suelen ser negativos. División indefinida señala importes desconocidos
  (null), no cero. Se conservan ocho decimales y se redondean centavos por factura.
- Según 211, si abs(pago sin IVA)>DBRUTO, el pago presentado pasa a -DBRUTO.
  Se conserva el pago original sin limitar en `payments` y cada movimiento FAX.
  El límite es del periodo, no un cálculo de cobros históricos acumulados.
- Subtotal=DBRUTO; total=DBRUTO+devoluciones firmadas; flete=DCOSTOFLETE;
  cliente nuevo=marca actual CLITARJETA='Nuevo'. No se reconstruye esa marca histórica.
- Una fila por DSEQ evita colisiones de folios y duplicaciones. 213 agrupa sólo
  por DNUM y proyecta AFECHA sin agregar. Aquí se conservan primera y última
  fecha PA y su cantidad; FECHA PAGO/DÍAS utilizan el último PA. La hoja Movimientos
  FAX conserva todos los pagos con su fecha exacta para evitar pérdida de información.
- El agente usa DPAR1 y FAG.AGTNUM con AGT=1. El catálogo se agrupa antes del join;
  el SQL original no limita AGT y puede multiplicar pagos con otras clasificaciones.
- Cliente del encabezado FDOC.CLISEQ. En los PA de facturas elegibles de agosto se
  confirmó que coincide con FAX.CLISEQ. No se expone información personal innecesaria.
- México usa exactamente DALMACEN IN ('01','15'), como 213. Otras sucursales se
  amplían con FALMCAT.CATMULTICIA y almacenes asociados: extensión derivada, no
  copia de la rama incompleta LVCIA=7 del código original. Todas incluye también
  almacenes no asignados, identificados como `unassigned`.
- Los pagos se agregan antes de leer FAXINV/FINV. Las partidas se consultan aparte,
  sin filtro de ITIPO ni AIMES añadido sin el método 214. Los datos de origen se
  incluyen para trazabilidad, no se reinterpretan como COSTO REAL. No se une FPENC:
  PEPLAZO se pasa al método faltante, pero no participa en los importes confirmados.
- No hay conversión adicional de moneda ni aplicación/inversión de descuentos.
  Se preserva DMONEDA por factura. La moneda consolidada no se afirma verificada.
- Las tres consultas de datos comparten una transacción **READ ONLY con snapshot**,
  de manera que facturas, movimientos y partidas correspondan a la misma lectura.
  No ejecuta INSERT/UPDATE/DELETE ni modifica configuración.

## Contrato y arquitectura

Módulo separado en `src/modules/sales/commissions`, con dominio, casos de uso,
contratos de datasource/repository y rutas. Sólo infrastructure/datasources
contiene SQL; el repository delega. Todos los valores de filtros se enlazan.

GET /api/sales/reports/collection-commissions/options devuelve compañía, siete
sucursales, almacenes, 143 agentes en el origen inspeccionado y periodo inicial
del primer día del mes actual a hoy en México.

GET /api/sales/reports/collection-commissions acepta from/to ISO, branch=01..07|all
y agent=código|all. Predeterminados 01/all. Fechas 1901..2100, máximo 366 días.
Agentes/sucursales desconocidos, filtros duplicados o extra y rangos inválidos se
rechazan. Cache-Control no-store. Se limita a 10,000 facturas y 100,000 filas de
movimientos/partidas; si se excede devuelve 413 y requiere acotar, sin truncar
datos silenciosamente. Cada consulta tiene límite de tiempo de 30 segundos.

La respuesta contiene criterios, estado preliminar, notas, facturas, movimientos,
partidas de origen, resumen por agente y totales. Cada factura conserva DSEQ,
folio, fechas, cliente, agente, almacén/sucursal, moneda, importes exactos y
redondeados, cantidad de pagos y marcador de límite aplicado.

## Frontend y Excel

Ruta `/contabilidad/reportes/comisiones-por-cobranza`, accesible únicamente en
**Reportes Contabilidad → Reportes Financieros → Comisiones por cobranza**.
Ventana ERP compartida y controles shadcn/Base UI. Pagos desde/hasta, sucursal,
agente, Vista previa, Resumen por agente, paginación 100, scroll X/Y y Cancelar/Escape.
Cambiar filtros bloquea exportación obsoleta hasta generar de nuevo. Carga,
error/reintento, vacío y fechas inválidas son explícitos.

ExcelJS diferido genera Comisiones, Resumen agentes, Movimientos FAX, Partidas
origen y Criterios. Las primeras 18 columnas conservan el orden del método 211:
AGENTE, CLIENTE, FECHA DOCTO, FECHA PAGO, FACTURA, DÍAS, SUBTOTAL, DEVOLUCIONES,
TOTAL, PAGO, COSTO, COSTO REAL, UTILIDAD, %, FLETES, CLIENTE NUEVO, LM, LM_VALOR.
Costos/utilidad/LM pendientes se dejan en blanco, nunca con fórmula/valor cero.
Comisiones tiene fórmulas de totales con valores guardados; fechas/cantidades
numéricas, códigos/folios de texto y cobranza original con precisión como texto.
El nombre del archivo y cada hoja declaran PRELIMINAR.

## Verificación inicial de lectura

Agosto de 2026: México (01/15), 78 facturas y 86 PA; subtotal 9,156,737.17 y pago
presentado sin IVA **-8,339,491.31**. Incluye 58 facturas anteriores a agosto,
41 pagos parciales, seis facturas con múltiples PA y 23 pagos limitados a DBRUTO.
Todas: 995 facturas, 1,068 PA, subtotal 78,859,177.79 y pago **-57,903,236.15**;
517 facturas anteriores al mes, 251 parciales, 54 con múltiples pagos y 195
limitadas. No son constantes. Se conciliaron individualmente usando Decimal
desde una lectura independiente de FAX/FDOC, sin join a productos o agentes.

Evidencia privada: `captures/commission-reference-20261106/` y
`captures/sql/new-version/sales/collection-commissions-20261106/`. general_log
verificado **OFF** después de las lecturas. No se activó captura ni se reinició MySQL.

## Validación y alcance pendiente

- Backend `pnpm lint`, `pnpm build`, `pnpm test`: **196 pruebas aprobadas**,
  diez para este reporte. Cubren límite al subtotal, pagos parciales y signos,
  ausencia explícita de costos, IVA indefinido, fechas de México, filtros estrictos,
  snapshot de lectura, separación de pagos/partidas y liberación ante fallo.
- Frontend `pnpm lint`, `pnpm typecheck`, `pnpm build` aprobados. Navegador y API
  reales: menú/ruta directa, filtros de agente/sucursal/fecha de pago, Excel,
  18 columnas y costos pendientes, resumen sin HTTP adicional, paginación 100/95,
  scroll XY, exportación vigente, error/reintento, vacío, rango inválido y Escape.
- Se descargaron Excel de México, todas las sucursales y agente 1501. Cinco hojas,
  fechas, importes, filas completas de movimientos/partidas y costos vacíos
  contrastados con la API. Fórmulas y resultados guardados se verificaron también
  en el XML interno, incluyendo resultados cero. No se afirma recálculo nativo.
- Capturas y libros privados en `captures/ui/new-version/collection-commissions-20261106/`.
  MySQL80 **Running**; sólo SELECT y transacciones READ ONLY, sin migraciones ni
  reinicios. La implementación continúa **preliminar**, pendiente de método 214
  y definición de comisión. No se declara equivalente al reporte completo de OMNIS.
