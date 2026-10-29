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
- `warehouse`: código real de `FALMCAT.CATALM`, o `all`; inicia en `01` México.
  Se filtra **FAXINV.AIALMACEN**, no el código de compañía. Los almacenes de
  resguardo, tránsito y central se pueden seleccionar por separado; `all` incluye
  todos, también movimientos con almacén vacío. No equivale a consolidar sólo las
  siete sucursales comerciales. No se copia `DMULTICIA=1` del Auxiliar antiguo.
- `family`: valor de `FINV.IFAMB`, o `all`; inicia en todas. La descripción se
  relaciona con `FFAM.FAMTNUM`, `FAMT='B'`, agrupando la llave del catálogo para
  impedir duplicaciones. La familia vacía conserva su propio grupo.
- `AICANT` tiene el signo físico: positivo entrada, negativo salida. No se usa
  `AICANTF`: en una factura observada es positivo pese a ser salida.
- Acumula desde el inicio disponible, sin límite inferior ni saldo inicial
  añadido. `DFECHA < día siguiente` incluye todo el día de corte. `AIMES=1` es un
  filtro del Auxiliar, no el mes seleccionado. Sólo documentos vigentes `DEST=0`.
- No se excluyen productos dados de baja ni familias con existencia neta cero.
  Se conservan todos los productos con movimientos físicos no nulos para que las
  entradas y salidas históricas también concilien con sus familias.
- Traslados y devoluciones conservan sus signos. No se decide el signo por
  prefijos de documento, no se aplica ABS a la existencia y no se toma ISTKACT.
- La clasificación, unidad y estado de cancelación son los disponibles en el
  catálogo/documentos actuales. No se presume un historial de reclasificaciones
  o del instante en que se canceló un documento.
- Cantidades originales con tres decimales y totales por `USEQ` para auditoría.
  El resumen reúne **metros estimados**: M/MT/MTR × 1; TR/PZ × 6.40 según la
  equivalencia aproximada indicada por el usuario; FT × 0.3048.
- Sin valuación monetaria. Las unidades sin equivalencia (kilos, litros,
  servicios, etc.) se conservan aparte y no se mezclan con metros.

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
producto, familia/unidad y total/unidad; **no se suman a la existencia fechada**.
La respuesta queda `provisional=true` y la advertencia aparece en vista, Excel y
PDF. Se señalan también fechas nulas o sentinelas anteriores a 1901. No se les
asigna la fecha del documento vecino, de la captura ni del año del respaldo.
La cantidad sin fecha tiene signo, puede compensarse en el agregado y no es
existencia adicional al corte. Su conteo permanece visible aunque sume cero.

Por eso el resultado no garantiza una existencia histórica completa cuando hay
documentos faltantes. Debe reconciliarse/restaurarse esa historia antes de usarlo
como saldo definitivo. El reporte tampoco puede detectar movimientos que fueron
eliminados junto con su documento y ya no existen en FAXINV.

## SQL derivado

La siguiente consulta muestra el núcleo para México, familia B008 y corte
30/09/2026. Los tres valores se enlazan con `?` en el datasource. `all` elimina el
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
WHERE a.AIMES = 1 AND a.AICANT <> 0
  AND (d.DEST = 0 OR d.DSEQ IS NULL)
  AND (d.DFECHA < '2026-10-01' OR d.DFECHA IS NULL)
  AND a.AIALMACEN = '01'
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

Resumen actual: N.º, Producto / Familia, metros estimados y porcentaje por cada
almacén, total de inventario del año del corte y porcentaje general. Una sola
fila por IFAMB, siguiendo el orden de familias del ejemplo del usuario.
El detalle conserva las columnas originales y agrega m/UM y Metros estimados.
Excel agrega conteo sin fecha, metros sin fecha e ISEQ para conciliar; contiene
Familias, Unidades originales, Totales por unidad, Productos y Criterios.
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
