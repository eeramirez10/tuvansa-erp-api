# Estado de resultados: siete sucursales y consolidado

Implementación 2026-10-22. Amplía el reporte de [México](income-statement-mexico.md) aprobado por el usuario: siete reportes con la misma estructura, un consolidado final y descarga Excel. Se conservan las modalidades México y PROSCAI.

## Alcance y contrato

| Código | Sucursal del catálogo | Compañía CATMULTICIA verificada |
| --- | --- | ---: |
| 01 | México | 1 |
| 02 | Monterrey | 2 |
| 03 | Veracruz | 3 |
| 04 | Mexicali | 4 |
| 05 | Querétaro | 5 |
| 06 | Cancún | 6 |
| 07 | Cabos | 7 |

| Vista / botón | Endpoint | Procedencia | Marcador / tablas |
| --- | --- | --- | --- |
| Todas las sucursales / parámetros | GET /api/accounting/reports/income-statement/branches/options | derivada | Sin captura nueva; FCIA y FALMCAT |
| Todas las sucursales / OK | GET /api/accounting/reports/income-statement/branches?year=2026&month=8 | derivada: proyección de saldos adaptada, ampliada a siete compañías | Referencia histórica ACCOUNTING_INCOME_STATEMENT_ACCOUNTS8_MONTH22_LEVEL3_SCREEN; FCCBENC LEFT JOIN FBENC |
| Descargar Excel | Sin petición adicional | Presentación y fórmulas derivadas | Exporta la respuesta mostrada; ExcelJS en frontend |
| Imprimir / Guardar PDF | Sin petición adicional | Presentación del mismo resultado | Siete páginas y consolidado final |

Options devuelve companyName, year, branches, months y defaultMonth. Reporte devuelve year, month, generatedAt, branches[{branch,report}], consolidated y empty. Cada report conserva el contrato IncomeStatement con financial. El consolidado usa ese mismo formato. Las ocho secciones comparten fecha y parámetros. Respuestas sin caché (Cache-Control: no-store).

Se admiten mes entero 1..12 y únicamente el año FCIA.CIAPERIODO configurado. Parámetros extra para cambiar compañías o sucursales responden 400. Un catálogo con sucursales faltantes, códigos duplicados o compañías repetidas responde 409 antes de leer saldos; así se evita generar un consolidado parcial o duplicado. Las compañías se resuelven en el servidor mediante CATMULTICIA; no se reciben desde HTTP. Se excluyen almacenes de tránsito y resguardo. Requests reproducibles en http/accounting-income-statement.http.

## SQL y cálculos

El calendario, los signos, la separación de gastos y el tratamiento de provisiones vacías son los ya verificados en México. Las provisiones ISR/PTU/adicionales quedan en cero conforme a la plantilla; no se estiman impuestos. Cada compañía conserva BCCCENCOS=-1. Los detalles de todas las compañías se leen en una sola consulta por lote:

~~~sql
SELECT c.BCCCIA AS companyId, c.BCCSEQ AS id,
       b.BCOD AS code, b.BNOMBRE AS name, b.BNATUR AS nature,
       c.BCCS108 AS balance, c.BCCSC108 AS debit, c.BCCSA108 AS credit
FROM fccbenc c
LEFT JOIN fbenc b ON c.BSEQ=b.BSEQ
WHERE b.BCOD>=? AND b.BCOD<CONCAT(?,?)
  AND CHAR_LENGTH(b.BCOD)<=? AND c.BCCCENCOS=?
  AND c.BCCCIA IN (?,?,?,?,?,?,?)
ORDER BY c.BCCCIA,b.BCOD,c.BCCSEQ;
-- Agosto: ['4',8,'Z',4,-1,1,2,3,4,5,6,7]
~~~

Esta consulta es derivada; no se presenta como SQL literal nuevo de OMNIS. La proyección y la unión proceden de la adaptación histórica. Todos los valores se enlazan como parámetros y las columnas mensuales se eligen de una lista interna fija. El SQL permanece en infrastructure/datasources; repositorio delega y caso de uso compone los reportes. No hay una consulta por cada fila o cuenta.

El consolidado suma los saldos, cargos y abonos del mismo código contable entre las siete compañías, en centavos. Luego aplica las mismas reglas de presentación. No suma padres con descendientes. Rechaza códigos duplicados dentro de una sucursal y naturalezas contables incompatibles entre compañías.

- MES consolidado: suma del movimiento del mes de las siete sucursales.
- ACUMULADO consolidado: suma de sus acumulados hasta el mes elegido.
- Porcentaje consolidado: importe consolidado dividido entre ingresos consolidados de su propia columna; no se suman porcentajes de sucursales.
- Cuentas o ajustes residuales se conservan, por ejemplo el ajuste acumulado de costos -22,652.00 observado en Monterrey.

México conserva los importes previamente aprobados. Para agosto 2026, el resultado consolidado de la conexión verificada fue 8,718,024.89 del mes y 76,258,261.87 acumulado, que coinciden con la suma de los siete resultados individuales. Son datos de verificación de ese respaldo, no constantes del sistema.

## Excel y PDF

La librería elegida es ExcelJS 4.4.0, instalada con pnpm en el frontend. Documentación primaria: https://github.com/exceljs/exceljs#readme. Se carga de forma diferida al exportar. El backend no genera archivos ni requiere nuevas dependencias o migraciones.

El archivo estado-resultados-sucursales-AAAA-MM.xlsx contiene nueve hojas:

1. Reporte completo: siete bloques lado a lado y consolidado al final, con conceptos y encabezados congelados.
2. Siete hojas individuales, una por sucursal, con formato de impresión carta.
3. Consolidado: hoja individual final con MES y ACUMULADO generales.

La hoja Reporte completo contiene los importes base, fórmulas de subtotales/utilidades y porcentajes IFERROR; el consolidado suma los bloques de sucursales. Las hojas individuales se enlazan a esa hoja principal. Esto permite que los cambios locales en un importe base del Excel actualicen las hojas y el consolidado. No modifica el ERP ni llama endpoints de escritura.

Las fórmulas monetarias usan ROUND(...,2), con valores calculados por la API guardados como resultado inicial. Se pide recálculo al abrir el libro. Los porcentajes se recalculan contra ingresos y quedan vacíos si el denominador es cero. Se preservan negritas, separadores, encabezados, formatos numéricos y negativos en rojo. Los importes se presentan sin decimales y se calculan con centavos. Los renglones opcionales se alinean por clave de concepto para que un ajuste de una sucursal no desplace los importes de otra.

El PDF imprime ocho páginas carta: siete sucursales en orden y el consolidado al final, sin los controles de la aplicación. El Excel permite comparar en su hoja principal y usar las hojas individuales para imprimir cada reporte.

## Validación y evidencia

Backend: pnpm lint, pnpm build, pnpm test aprobados; 132 pruebas en 18 archivos. Las pruebas nuevas cubren catálogo incompleto/duplicado, consulta por lote, suma en centavos sin doble conteo, porcentajes ponderados por ingresos, pérdidas, vacío y parámetros HTTP.

Frontend: pnpm lint, pnpm typecheck y pnpm build. ExcelJS se emite como un chunk separado, cargado al descargar. Navegador con datos reales: ocho reportes, importes consolidados, México preservado, descarga sin otra petición, cambio de mes, modalidades anteriores, error/reintento, vacío y navegación.

El libro descargado contiene nueve hojas y 1,616 fórmulas. Se abrió y recalculó mediante Excel de Windows en sólo lectura, se comprobaron los resultados de las ocho hojas individuales y la propagación de un ajuste temporal en memoria hacia el consolidado. Se cerró sin guardar y se verificó el SHA-256 del archivo. La estructura XLSX no contiene errores de fórmula. El PDF se verificó como ocho páginas de 612 × 792 puntos.

Evidencia privada, excluida de Git: captures/ui/new-version/income-statement-all-branches/. Incluye catálogo, report.json, browser-result.json, native-excel-validation.json, XLSX descargado, PDF y renderizados. No se activó general_log ni se modificó la base heredada.

La descarga tambi?n se prob? desde la compilaci?n de producci?n, cargando el m?dulo ExcelJS diferido sin errores. La comprobaci?n final de Excel exigi? igualdad exacta a centavos y conciliaci?n cero en las ocho hojas. Verificaci?n final de servicio: general_log=OFF tanto en la conexi?n configurada como en MySQL local; MySQL80 Running. No hubo reinicios. Evidencia adicional: production-validation.json y final-service-validation.json.
