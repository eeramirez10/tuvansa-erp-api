# Estado de resultados: México, formato Excel

Implementación y verificación del 2026-10-22. Alcance autorizado: sucursal 01 México; las demás sucursales quedan pendientes. Referencia local: Estado de resultados agosto 2026.xlsx, hoja Hoja1, columnas B–E. SHA-256 revisado: d6bb8abafc4a70bcb6e7eff6e8e094f190bbf063f22c1f092ec50b74833dc2f7. No se modificó el archivo original.

## Uso y contrato HTTP

En el frontend: Contabilidad → Reportes → Estado de resultados → Formato México (Excel). La ventana Estado de resultados — México muestra Sucursal 01 — México y Ejercicio de sólo lectura; Mes permite enero a diciembre. OK genera la vista previa; Imprimir / Guardar PDF abre la impresión carta. El formato PROSCAI conserva sus parámetros y calendario anteriores.

| Vista / control | Endpoint | Procedencia | Captura / tablas |
| --- | --- | --- | --- |
| México / parámetros | GET /api/accounting/reports/income-statement/mexico/options | derivada | Sin nueva captura; FCIA, FALMCAT |
| México / OK | GET /api/accounting/reports/income-statement/mexico?year=2026&month=8 | adaptada: proyección de saldos; derivada: alcance y calendario del Excel | Referencia histórica ACCOUNTING_INCOME_STATEMENT_ACCOUNTS8_MONTH22_LEVEL3_SCREEN; FCCBENC LEFT JOIN FBENC |
| México / Imprimir / Guardar PDF | Sin SQL adicional | Presentación derivada | Respuesta actual, una página carta verificada |

Options devuelve companyName, year, branch, months y defaultMonth. Reporte conserva la estructura IncomeStatement con financial y agrega branch/accountingYear. GETs responden Cache-Control: no-store. Sólo se admite el ejercicio configurado y mes entero 1..12. Parámetros adicionales como branch, companyId o costCenter responden 400; no existe selector HTTP para otra sucursal. Una configuración incompleta responde 409 antes de leer saldos. Requests: http/accounting-income-statement.http.

## Correspondencia verificada de México

La lectura del catálogo confirmó FALMCAT.CATALM='01', CATKEY='', CATDESCR='SUC. MEXICO' y CATMULTICIA=1. CATMULTICIA define la compañía contable; CATCIA de ese registro es cero y no debe usarse como sustituto. El centro de costos CEN1 también se llama México, pero no equivale al filtro del reporte del archivo.

Los importes del Excel de México coinciden con BCCCIA=1 y BCCCENCOS=-1. Cambiar el segundo filtro a 1 trae saldos históricos de otro alcance y no reproduce el reporte. Se conserva el consolidado de centros dentro de la compañía asociada a México; esto no agrega las compañías de otras sucursales.

La consulta de catálogo es derivada y parametrizada:

~~~sql
SELECT CATALM AS warehouseCode, CATDESCR AS name,
       CATMULTICIA AS companyId
FROM falmcat
WHERE CATALM = ? AND CATKEY = ?
ORDER BY CATSEQ
LIMIT 1;
-- Parámetros: ['01', '']
~~~

La consulta de saldos, adaptada de la evidencia histórica, para agosto es:

~~~sql
SELECT c.BCCSEQ AS id,
       b.BCOD AS code, b.BNOMBRE AS name, b.BNATUR AS nature,
       c.BCCS108 AS balance, c.BCCSC108 AS debit, c.BCCSA108 AS credit
FROM fccbenc c
LEFT JOIN fbenc b ON c.BSEQ = b.BSEQ
WHERE b.BCOD >= ? AND b.BCOD < CONCAT(?, ?)
  AND CHAR_LENGTH(b.BCOD) <= ?
  AND c.BCCCIA = ? AND c.BCCCENCOS = ?
ORDER BY b.BCOD, c.BCCSEQ;
-- Parámetros verificados: ['4', 8, 'Z', 4, 1, -1]
~~~

No se afirma que esta composición sea una nueva sentencia literal capturada de OMNIS. No se activó general_log para esta implementación.

## Calendario y fórmulas

Este reporte obtiene el año de FCIA.CIAPERIODO, que en el origen revisado es 2026. El mes 8 selecciona BCCS108/BCCSC108/BCCSA108 y se presenta como agosto de 2026. Esa combinación reproduce los importes del Excel. Se comprobó que usar periodo 20 no reproduce el archivo. Esta regla derivada es específica del formato México y se mantiene separada del calendario de 24 periodos basado en CIAFI/CIAFF del reporte histórico PROSCAI.

Las reglas de agrupación de cuentas se comparten con build-financial-income-statement.ts: ventas 4001, otros ingresos 4003, devoluciones 4002, costos 5, gastos 6 separando depreciación 6004 y amortización 6005, financiamiento 7 separando 7003 y 7004. Los saldos de padres ya incluyen descendientes y no se suman dos veces. Los cálculos conservan centavos.

- Total ventas e ingresos: ventas + otros ingresos − devoluciones.
- Utilidad bruta: ingresos − costos.
- Gastos de operación: grupo 6 sin depreciación/amortización; los gastos centralizados 6001 se incluyen una sola vez.
- Utilidad de operación: utilidad bruta − gastos de operación.
- Utilidad antes de impuestos: resultado anterior − depreciación − amortización − financiamiento − otros gastos − otros productos, respetando el signo contable de productos.
- ISR, PTU y gastos centralizados adicionales: cero, como las celdas vacías B41/D41, B42/D42 y B43/D43 del archivo. No se estiman tasas ni se afirma haber leído provisiones contables.
- Utilidad neta: utilidad antes de impuestos menos esas provisiones adicionales. El ejemplo tiene OTROS=0 y ambas filas de utilidad antes de impuestos coinciden.
- Porcentaje de mes: importe / B14; acumulado: importe / D14. Si no hay ingresos, el porcentaje se muestra vacío.

El archivo actualizado aún contiene porcentajes con referencias a D20 vacío y a G14 de Monterrey. La adaptación usa ingresos de México en cada columna para evitar divisiones inválidas y mezcla de sucursales. No se copian referencias cruzadas. El resultado ERP y la diferencia se calculan de la misma lectura actual; no se utilizan los comparativos manuales B48/D48 del Excel como valores contables confirmados.

En el formato histórico, las provisiones sin asignación siguen apareciendo N/D. El tratamiento cero se habilita únicamente para México conforme a la plantilla proporcionada.

## Validación

Se compararon contra MySQL los 54 importes del Excel, incluyendo ventas, devoluciones, costos, gastos, utilidades intermedias, provisiones vacías y utilidad neta. Las 54 comparaciones coinciden a centavos:

| Concepto | Agosto 2026 | Acumulado |
| --- | ---: | ---: |
| Total ingresos | 9,558,092.13 | 49,864,819.64 |
| Costo de ventas | 7,357,381.84 | 37,101,890.00 |
| Utilidad bruta | 2,200,710.29 | 12,762,929.64 |
| Total gastos de operación | 4,113,344.99 | 45,572,094.19 |
| Utilidad neta, con provisiones vacías en cero | -2,414,700.26 | 32,628,575.03 |

El PDF presenta enteros y porcentajes con dos decimales, como el ejemplo; las pérdidas se muestran en rojo entre paréntesis. Se verificó una página carta de 612 × 792 puntos, sin columnas de Monterrey ni controles de la aplicación.

Pruebas: tests/mexico-income-statement.test.ts verifica alcance, CATMULTICIA, ejercicio/mes, provisiones, rechazo de otras sucursales por HTTP, configuración y columnas del periodo. La suite completa aprobó pnpm lint, pnpm build y pnpm test: 125 pruebas en 17 archivos. Frontend aprobó pnpm lint, pnpm typecheck y pnpm build. Navegador: ruta directa, menú, generación real, cambio de mes, mes sin ingresos, formato PROSCAI, impresión, error/reintento y vacío.

Evidencia excluida de Git: captures/ui/new-version/income-statement-mexico/. Incluye referencia y SHA, inspecciones de alcance/periodos, mexico-response.json, browser-result.json, frontend-mexico.png y estado-resultados-mexico-agosto-2026.pdf. Los datos corresponden a la conexión configurada en la API al verificar; otros respaldos pueden producir importes distintos.

No se requieren migraciones. Las consultas son de lectura; no se modificó MySQL ni se reinició el servicio.

Verificación final: SHOW GLOBAL VARIABLES LIKE general_log devolvió OFF tanto en la conexión configurada como en MySQL local. MySQL80 quedó Running. Resultado registrado en final-service-validation.json; no hubo cambios de configuración ni reinicios.
