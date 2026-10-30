# Inventario por familia a una fecha

Implementación del 2026-10-29 solicitada por el usuario. Es un reporte nuevo,
**derivado** del modelo del Auxiliar; no es una nueva captura de un reporte OMNIS.
La evidencia anterior de Auxiliar se describe en `product-buttons.md` y
`product-buttons-capture.md`. No se activó general_log ni se modificó MySQL.

| Vista | Etiqueta visible | Marcador | Procedencia | Endpoint | Tablas | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| Reportes → Reportes Financieros | Inventario por familia | No aplica: reporte nuevo | Derivada | `GET /api/inventories/reports/by-family/options` | FINV, FFAM, FALMCAT, FCIA | Catálogos verificados |
| Inventario por familia | Vista previa | No aplica: reporte nuevo | Derivada | `GET /api/inventories/reports/by-family` | FAXINV, FDOC, FINV, FFAM, FUNIDAD | Lectura por lote |
| Inventario por familia | Excel / PDF | Sin SQL adicional | Presentación | Respuesta vigente | Sin tablas adicionales | Frontend |

## Parámetros y reglas

- `asOf`: fecha ISO válida, entre 1901 y 2100. Ejemplo: `2026-09-30`.
- `warehouse`: código de sucursal o almacén, o `all`; inicia en `01` México.
- `scope=branch` (nuevo predeterminado): incluye los resguardos de la sucursal.
  El catálogo relaciona cada CATALM con la compañía CATMULTICIA de los almacenes
  principales 01..07. México incluye actualmente 01, 11, 12, 13 y 15.
  `scope=warehouse` conserva la consulta de un almacén individual. El filtro físico
  continúa siendo FAXINV.AIALMACEN con parámetros; no se copia DMULTICIA=1.
  `all` incluye todos; almacenes sin propietario inequívoco forman una columna
  Sin sucursal asignada, sin adjudicarlos arbitrariamente a México.
- `includeUndated=false` (predeterminado): conserva los pendientes separados.
  `true`: suma sus entradas y salidas como **escenario estimado**, sin afirmar que
  ocurrieron antes del corte. Sólo se aceptan los literales HTTP true/false.
- `family`: valor de `FINV.IFAMB`, o `all`; inicia en todas. La descripción se
  relaciona con `FFAM.FAMTNUM`, `FAMT='B'`, agrupando la llave del catálogo para
  impedir duplicaciones. La familia vacía conserva su propio grupo.
- `AICANT` tiene el signo físico: positivo entrada, negativo salida. No se usa
  `AICANTF`: en una factura observada es positivo pese a ser salida.
- Acumula desde el inicio disponible, sin límite inferior ni saldo inicial
  añadido. `DFECHA < día siguiente` incluye todo el día de corte. `AIMES=1` es un
  filtro del Auxiliar, no el mes seleccionado. Sólo documentos vigentes `DEST=0`.
- No se excluyen productos dados de baja ni familias con existencia neta cero.
  Se conservan productos con movimientos físicos o revaluaciones no nulos,
  incluidas las revaluaciones cuya cantidad sea cero.
- Traslados y devoluciones conservan sus signos. No se decide el signo por
  prefijos de documento, no se aplica ABS a la existencia y no se toma ISTKACT.
- La clasificación, unidad y estado de cancelación son los disponibles en el
  catálogo/documentos actuales. No se presume un historial de reclasificaciones
  o del instante en que se canceló un documento.
- Cantidades originales con tres decimales y totales por `USEQ` para auditoría.
  El resumen reúne **metros estimados**: M/MT/MTR × 1; TR/PZ × 6.40 según la
  equivalencia aproximada indicada por el usuario; FT × 0.3048.
- Valuación con **costo promedio actual FINV.ILISTA4**, usando la cantidad en UM
  original. No se presenta como costo histórico confirmado del corte. Las unidades
  sin equivalencia a metros sí pueden aportar valor si tienen un costo válido;
  permanecen fuera del total de metros.
- La presentación predeterminada ahora es **Costo histórico de movimientos**:
  suma AICANT × AICOSTO por movimiento, sin sustituirlo por la lista actual.
  Revaluaciones AIREVAL separadas, pendientes sin fecha según escenario y costos
  cero/ausentes señalados. El modo ILISTA4 se conserva como comparación explícita.

## Historia y documentos faltantes

La base configurada conserva historia del producto `01300938` desde 2018-01-22.
También hay movimientos de 2026 en la copia `tuvansa2025`; sumar esas dos bases
duplicaría historia. Este reporte utiliza exclusivamente la base configurada y
recorta por fecha; no cambia de origen automáticamente según el año del corte.
El origen anual de Estado de resultados permanece independiente.

Se encontraron movimientos con `DSEQ` que ya no está en FDOC. FAXINV no contiene
una fecha propia que permita fecharlos. Por ejemplo, el movimiento `AISEQ=438474`
de `01300938` tiene cantidad -1314.010, almacén 01 y documento ausente. La misma
ausencia se comprobó en `tuvansa2025`; no se puede recuperar su fecha de ahí.

Estos movimientos se conservan como `undatedMovements` y `undatedQuantity` por
producto, familia/unidad y total/unidad; **no se suman al corte predeterminado**.
El escenario explícito includeUndated=true los incorpora sin inventar su fecha.
La respuesta queda `provisional=true` y la advertencia aparece en vista, Excel y
PDF. Se señalan también fechas nulas o sentinelas anteriores a 1901. No se les
asigna la fecha del documento vecino, de la captura ni del año del respaldo.
La cantidad sin fecha tiene signo y puede compensarse en el agregado. Se conservan
también undatedIncoming/undatedOutgoing: una entrada y salida iguales no desaparecen
del conteo ni del detalle. Su pertenencia temporal al corte sigue sin confirmarse.

Por eso el resultado no garantiza una existencia histórica completa cuando hay
documentos faltantes. Debe reconciliarse/restaurarse esa historia antes de usarlo
como saldo definitivo. El reporte tampoco puede detectar movimientos que fueron
eliminados junto con su documento y ya no existen en FAXINV.

## SQL derivado

La siguiente consulta muestra el núcleo para México y sus resguardos, familia
B008 y corte 30/09/2026. Los valores se enlazan con `?` en el datasource. `all` elimina el
predicado correspondiente; nunca se interpolan valores del cliente.

```sql
SELECT
  i.ISEQ, i.ICOD, i.IDESCR, TRIM(i.IFAMB) AS familia,
  COALESCE(NULLIF(f.nombre,''),'Sin familia') AS descripcion_familia,
  a.AIALMACEN, i.USEQ, u.UCOD,
  SUM(CASE WHEN d.DFECHA > '1900-12-31' AND a.AICANT > 0
      THEN a.AICANT ELSE 0 END) AS entradas,
  SUM(CASE WHEN d.DFECHA > '1900-12-31' AND a.AICANT < 0
      THEN -a.AICANT ELSE 0 END) AS salidas,
  SUM(CASE WHEN d.DFECHA > '1900-12-31'
      THEN a.AICANT ELSE 0 END) AS existencia_fechada,
  CAST(SUM(CASE WHEN d.DFECHA > '1900-12-31' AND a.AICANT > 0
      THEN a.AICANT * COALESCE(a.AICOSTO,0) ELSE 0 END) AS CHAR) AS entradas_costo,
  CAST(SUM(CASE WHEN d.DFECHA > '1900-12-31' AND a.AICANT < 0
      THEN -a.AICANT * COALESCE(a.AICOSTO,0) ELSE 0 END) AS CHAR) AS salidas_costo,
  CAST(SUM(CASE WHEN d.DFECHA > '1900-12-31'
      THEN a.AICANT * COALESCE(a.AICOSTO,0) ELSE 0 END) AS CHAR) AS valor_historico_fechado,
  CAST(SUM(CASE WHEN d.DFECHA IS NULL OR d.DFECHA <= '1900-12-31'
      THEN a.AICANT * COALESCE(a.AICOSTO,0) ELSE 0 END) AS CHAR) AS valor_historico_sin_fecha,
  CAST(SUM(CASE WHEN d.DFECHA > '1900-12-31'
      THEN COALESCE(a.AIREVAL,0) ELSE 0 END) AS CHAR) AS revaluacion_fechada_aparte,
  MIN(CASE WHEN d.DFECHA > '1900-12-31' THEN d.DFECHA END) AS primer_movimiento,
  MAX(CASE WHEN d.DFECHA > '1900-12-31' THEN d.DFECHA END) AS ultimo_movimiento,
  SUM(CASE WHEN d.DFECHA > '1900-12-31' THEN 1 ELSE 0 END) AS movimientos,
  SUM(CASE WHEN d.DFECHA IS NULL OR d.DFECHA <= '1900-12-31'
      THEN 1 ELSE 0 END) AS movimientos_sin_fecha,
  SUM(CASE WHEN d.DFECHA IS NULL OR d.DFECHA <= '1900-12-31'
      THEN a.AICANT ELSE 0 END) AS cantidad_sin_fecha
FROM faxinv a
JOIN finv i ON i.ISEQ = a.ISEQ
LEFT JOIN fdoc d ON d.DSEQ = a.DSEQ
LEFT JOIN funidad u ON u.USEQ = i.USEQ
LEFT JOIN (
  SELECT FAMTNUM, MAX(TRIM(FAMDESCR)) AS nombre
  FROM ffam WHERE FAMT = 'B' GROUP BY FAMTNUM
) f ON f.FAMTNUM = i.IFAMB
WHERE a.AIMES = 1 AND (a.AICANT <> 0 OR a.AIREVAL <> 0)
  AND (d.DEST = 0 OR d.DSEQ IS NULL)
  AND (d.DFECHA < '2026-10-01' OR d.DFECHA IS NULL)
  AND a.AIALMACEN IN ('01','11','12','13','15')
  AND TRIM(i.IFAMB) = 'B008'
GROUP BY i.ISEQ, i.ICOD, i.IDESCR, i.IFAMB, f.nombre,
  a.AIALMACEN, i.USEQ, u.UCOD
ORDER BY familia, i.ICOD, a.AIALMACEN, i.ISEQ;
```

La consulta agregada reemplaza recorrer cada Auxiliar con miles de llamadas.
No hay paginación en el cálculo: se agrupa toda la historia antes de responder.
El detalle de pantalla pagina 100 productos/almacenes; Excel y PDF contienen
el conjunto completo elegido. La consulta limita su ejecución a 30 segundos;
el cliente permite 45 segundos para la lectura completa.

## Respuesta y presentación

`{data:{title,company,criteria,warehouseName,generatedAt,groups,totals,empty,
provisional,undatedMovements,notes,source:'derivada'}}`.
Cada grupo contiene `code`, `name`, `products`, `totals` por unidad. Cada producto
incluye ISEQ/código/descripción/almacén/UM, entradas/salidas/existencia fechada,
primer/último movimiento y conteo/cantidad sin fecha.

Resumen actual: N.º, Producto / Familia, importe histórico o actual o metros y porcentaje por cada
almacén, total de inventario del año del corte y porcentaje general. Una sola
fila por IFAMB, siguiendo el orden de familias del ejemplo del usuario.
El detalle conserva las cantidades originales, costo promedio actual y valoración;
en modo metros conserva también m/UM y Metros estimados.
Excel agrega conteo sin fecha, metros sin fecha e ISEQ para conciliar; contiene
Familias, Unidades originales, Totales por unidad, Productos, Pendientes de conciliar,
Costos históricos y Criterios.
PDF imprime el resumen o el detalle completo según la casilla; las matrices
anchas se dividen en bloques de tres almacenes con total general explícito.

La UI usa shadcn/Base UI y ventanas ERP compartidas, filtros RHF/Zod y TanStack
Query. No exporta resultados anteriores después de modificar filtros, ni durante
carga/error/vacío. ExcelJS se carga sólo al exportar. No requiere migración SQL.

Validación y evidencia privada: `captures/ui/new-version/inventory-by-family/`;
requests reproducibles en `http/inventories/reports.http`; reglas y contrato en
`tests/inventory-by-family.test.ts`. Sólo se ejecutaron SELECT/SHOW. Se confirmó
general_log=OFF y no se reinició MySQL80.

Validación del 2026-10-29: `pnpm lint`, `pnpm build`, `pnpm test` aprobados
(157 pruebas en 20 archivos). Frontend: lint/typecheck/build aprobados.
Se conciliaron independientemente entradas, salidas y existencia fechada de
01300938 y 01300958 contra sus movimientos individuales. México al 30/09/2026
devolvió 23 familias y 10,255 productos/almacenes con movimiento, incluyendo
saldos cero, y 195 movimientos sin fecha. Todos los almacenes devolvió 38,668
productos/almacenes y 440 movimientos sin fecha en aproximadamente 16.5 segundos.
Son resultados de la base disponible al validar, no cifras constantes del reporte.

El navegador validó menú global/submenú sobre ventanas ERP, teclado, ruta directa,
filtros reales, paginación, bloqueo de exportación anterior, error/reintento y
vacío. El Excel descargado conserva las cantidades de los 10,255 productos y
sus códigos como texto; se abrió además en Excel de Windows, de sólo lectura,
sin alterar su SHA-256. PDF de resumen México: 3 páginas; detalle TSC de todos
los almacenes: 45 páginas. Se revisaron glifos, columnas finales y notas después
de la tabla. MySQL80 permaneció Running.

## Actualización: ejemplo y metros estimados

Referencia privada del 2026-10-29: `Inventarios por familia.xlsx` del escritorio
del usuario, leído sin modificarlo. Contiene familias en filas, columnas por
sucursal/año, porcentajes y total final. Sus rótulos de ventas y cifras no son
una fuente de existencias: se reutiliza la estructura visual, no sus importes.
La matriz implementada conserva **una fecha de corte seleccionada**; el comparativo
simultáneo 2025/2024 del archivo quedó pendiente de definir con el usuario.

TR y PZ = 6.40 m es la equivalencia aproximada solicitada para ambas unidades,
sin inferir la longitud medida de cada artículo. FT = 0.3048 m (pie internacional).
No se adivinan equivalencias para otras unidades. El resultado se etiqueta como
estimado en pantalla, Excel y PDF, y los saldos no convertibles permanecen aparte.

Se acumulan enteros con escala 10^7: cantidades originales en milésimas por el
factor, evitando redondear cada producto antes de sumarlo. API con siete decimales,
presentación con tres. Entradas, salidas y cantidad sin fecha usan el mismo factor;
la cantidad sin fecha conserva su signo y nunca se añade al saldo al corte.

Campos aditivos: `meters`, `meterColumns`, `meterTotals`, `unconverted`; por familia
`meters`, `byWarehouse`, `percentage`, `unconverted`; por producto `metersPerUnit`
y `meters` (null sin equivalencia). Se conservan cantidades y totales originales.
No cambia el SQL ni los parámetros: conversión y agrupación **derivadas** en dominio.

Porcentaje = metros de familia / metros de su columna × 100. Divisor cero produce
null y se muestra vacío. Se conservan negativos. El total general reúne todos los
almacenes elegidos, incluyendo resguardos y tránsito, sin reasignarlos a sucursales.
Excel conserva fórmulas de porcentajes y sumas con resultados iniciales y recálculo,
encabezados verdes y total en rojo. Códigos, unidades y factores quedan en detalle.

Actualización validada con 162 pruebas backend y lint/build/test; frontend con
lint/typecheck/build. Conversiones contrastadas con Decimal y fórmulas recalculadas
en Excel nativo para México y todos los almacenes. PDF revisado visualmente con
columnas finales completas. Datos de validación reutilizados de las lecturas reales
anteriores, sin capturar nuevo SQL OMNIS ni modificar MySQL. Evidencia privada:
`captures/ui/new-version/inventory-family-meters/`.

## Corrección: resguardos, valuación y pendientes (2026-10-30)

El usuario confirmó incluir resguardos y conservar las entradas/salidas sin
documento. El alcance de sucursal reemplaza el antiguo filtro exclusivo por 01.
El modo almacén sigue disponible para inspección individual. includedWarehouses
publica los códigos realmente incluidos; el producto conserva su almacén original.
Al agrupar por sucursal los traslados internos de un mismo producto se compensan
sin eliminar las dos filas físicas. La pertenencia procede del catálogo actual.

FINV.ILISTA4 se lee por producto junto con las cantidades. Se verificó IMONEDA4=0
en el catálogo disponible; el reporte se rotula moneda base y no aplica tipos de
cambio inferidos de IMONEDA de compras. No se calcula dinero sobre metros
convertidos: dos TR a 100 por TR valen 200, aunque equivalgan a 12.8 m estimados.
Se redondea a centavos por producto/almacén y luego se suma. Cantidades con costo
ausente, cero o negativo se marcan como partidas sin costo y no reciben un valor
inventado. Cantidades y costos se multiplican en enteros, no mediante acumulación
monetaria de punto flotante.

La respuesta agrega valuation:{dated,unlinked,reported,unpricedProducts},
valuationTotals y valueByWarehouse/valuationPercentage por familia. El producto
conserva datedQuantity/datedIncoming/datedOutgoing, su saldo reportado según escenario,
averageCost y valuation. Los metros continúan disponibles como presentación alterna.
La valuación de cada escenario se calcula sobre su cantidad original resultante;
redondear componentes separados puede generar diferencias de un centavo frente
a valorar su suma. No se mezclan métodos para forzar una referencia externa.

Para TCC, B007, al 31/08/2026: México con 01/11/12/13/15 devuelve 324 productos/
almacenes y nueve salidas sin documento. Con los costos actuales de la lectura:
14,963,893.55 en escenario fechado y 14,833,411.84 incluyendo pendientes. Son
valores provisionales, no se certifica el importe de referencia 12,281,029.00.
La revisión anterior sin redondear por partida daba 14,963,893.52301; la diferencia
de centavos obedece a la política explícita de redondeo, no a otros movimientos.

Se buscaron los nueve documentos faltantes de TCC en las copias 2024 y 2025:
ambas conservan esos movimientos, pero no sus documentos/fechas. No se reconstruye
DFECHA desde AISEQ, documentos vecinos ni la fecha actual. Para conciliarlos se
necesita una fuente verificable (otro respaldo, XML/PDF/documento y correspondencia
de movimiento) o una fecha validada por el responsable. Cualquier corrección debe
conservar trazabilidad y hacerse en un flujo específico; este reporte no restaura,
elimina ni modifica registros del MySQL productivo.

La UI ofrece Sucursal y resguardos / Almacén individual, Importe a costo promedio
actual / Metros estimados, y una casilla explícita Incluir movimientos sin fecha
(escenario estimado). Ver pendientes de fecha filtra productos/almacenes con esos
movimientos sin efectuar nuevas lecturas. No es una lista de un renglón por documento:
el conteo indica cuántos movimientos pendientes tiene cada partida. Excel contiene
la hoja Pendientes de conciliar con cantidades con signo, entradas/salidas, costo,
valor y estado Sin fecha verificable. PDF conserva modo y advertencias del escenario.

No hay migración ni escritura de datos. El SQL sigue siendo derivado; cambia la
proyección de ILISTA4 y los dos signos pendientes, y enlaza con IN todos los códigos
de resguardo que resolvió FALMCAT. Se mantiene la historia de una sola base, sin
duplicar movimientos de las copias anuales. Caché de catálogo: 60 segundos.
Evidencia privada: `captures/ui/new-version/inventory-branch-reconciliation/`.

Validación: 169 pruebas backend y lint/build/test aprobados; frontend con
lint/typecheck/build aprobados. Se contrastaron los importes con Decimal y se
recalcularon los tres libros de México en Excel nativo, sin errores de fórmula.
Se revisaron PDF de resumen y detalle de pendientes, preservando columnas finales,
escenarios y advertencias. La consulta real sólo hizo lecturas. general_log=OFF
y MySQL80 Running verificados al terminar; sin reinicios ni cambios de configuración.

## Costo de cada movimiento del Auxiliar (2026-10-30)

Corrección solicitada por el usuario: entradas por su costo y salidas por su
costo registrado, no existencia neta multiplicada por el costo actual. Se confirmó
que la consulta literal de Auxiliar proyecta AICOSTO y AIREVAL: marcador capturado
INV_QUERY_AUXILIAR en product-buttons-capture.md. La nueva agregación sigue siendo
**derivada**, no se declara una nueva captura OMNIS. No se activó general_log.

La respuesta agrega historical, historicalTotals e historicalByWarehouse por
familia, con historicalPercentage. Cada producto conserva historicalCosts con
sumas decimales exactas y historical con importes de presentación. historical:
incoming/outgoing son entradas/salidas fechadas a su costo propio; dated es su
neto exacto, unlinked el neto sin fecha y reported el escenario elegido.
revaluation/undatedRevaluation conservan AIREVAL **aparte**, sin modificar reported.
zeroCostMovements/undatedZeroCostMovements cuentan movimientos físicos con costo
cero o ausente. No se reemplazan esos costos por ILISTA4, AIPRECIO ni otro producto.
Un costo negativo registrado conserva su signo; no se aplica ABS al costo.

AICANT es DECIMAL(18,3), AICOSTO DECIMAL(18,5) y AIREVAL DECIMAL(18,2). SUM de
cantidad × costo conserva ocho decimales y se transporta como texto decimal para
evitar conversión binaria. Dominio suma con enteros y redondea a centavos por
producto/almacén, después agrega familias y sucursales. Se redondea el neto, no
se resta el total de dos columnas ya redondeadas; puede existir diferencia de
centavos entre entradas menos salidas visibles y el neto de precisión completa.
El escenario con pendientes también se redondea después de sumar sus netos exactos.

Validación TCC/B007, México 01/11/12/13/15 al 31/08/2026: 11,823 movimientos con
cantidad o revaluación no nula, en 325 productos/almacenes. Importe de movimientos
fechados: 34,420,029.46; pendientes sin fecha: −171,083.45; escenario que los incluye:
34,248,946.02. Se identificaron 62 movimientos fechados con costo cero; las
revaluaciones fechadas suman 55,412,589.72 y NO se añadieron al neto. La diferencia
de un producto respecto de la lectura anterior se debe a incluir revaluaciones
sin cantidad. Las cifras se contrastaron con cada movimiento usando Decimal.

Estos valores reflejan el costo registrado del auxiliar; aún no certifican un
inventario contable conciliado ni la referencia 12,281,029.00. Falta confirmar el
tratamiento de AIREVAL en PROSCAI y conciliar los costos cero. No se elige un signo
de revaluación para forzar aquella cifra. No se suman respaldos ni saldos actuales.

Vista previa, Excel y PDF inician en Costo histórico de movimientos. El usuario
puede alternar a costo actual o metros sin HTTP adicional. Excel agrega Costos
históricos con entradas/salidas, ambos escenarios, revaluaciones y conteos de
costos cero por producto/almacén; Pendientes de conciliar incluye también el valor
histórico pendiente. Evidencia privada: captures/ui/new-version/inventory-historical-costs/.

Validación final: backend lint/build/test con 174 pruebas aprobadas; frontend
lint/typecheck/build aprobados. Navegador con API real: México/todas las familias,
TCC/todas las sucursales, tres medidas sin HTTP adicional, pendientes, exportación
obsoleta bloqueada y escenarios. Cuatro libros contrastados con la API y
recalculados en Excel nativo sin errores ni cambios de SHA-256. PDF de resumen,
pendientes y bloques por sucursal revisados visualmente. general_log=OFF verificado;
MySQL80 Running, sin reinicios ni escrituras.
