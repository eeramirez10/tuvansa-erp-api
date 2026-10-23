# Estado de resultados: siete sucursales y consolidado

Implementación 2026-10-22. Amplía el reporte de [México](income-statement-mexico.md) aprobado por el usuario: siete reportes con la misma estructura, un consolidado final y descarga Excel. Se conservan las modalidades México y PROSCAI.

Actualización 2026-10-23: la entrada gerencial permite elegir una sucursal o Todas en la misma ventana de filtros, vista previa y salida Excel/PDF. El menú Reportes usa Dropdown Menu de shadcn en la parte superior de Contabilidad. Las secciones siguientes conservan la evidencia del reporte completo; el contrato ampliado se describe al final.

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

Se admiten mes entero 1..12 y únicamente el año FCIA.CIAPERIODO configurado. El parámetro branch admite all u 01..07; omitirlo equivale a all. Parámetros extra como companyId o costCenter responden 400. Un catálogo con sucursales faltantes, códigos duplicados o compañías repetidas responde 409 antes de leer saldos; así se evita generar un consolidado parcial o duplicado. Las compañías se resuelven en el servidor mediante CATMULTICIA; no se reciben desde HTTP. Se excluyen almacenes de tránsito y resguardo. Requests reproducibles en http/accounting-income-statement.http.

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


## Filtros y ventana unificada (2026-10-23)

| Vista / botón | Endpoint o evento | Procedencia / tablas |
| --- | --- | --- |
| Contabilidad / Reportes / Estado de resultados | Navega a la ruta existente | Sólo navegación; Dropdown Menu de shadcn |
| Año / Mes / Sucursal | GET /api/accounting/reports/income-statement/branches/options | Derivada: FCIA, FALMCAT |
| Vista previa / Todas | GET /api/accounting/reports/income-statement/branches?year=2026&month=8&branch=all | Derivada: FCCBENC LEFT JOIN FBENC, siete compañías |
| Vista previa / Veracruz | GET /api/accounting/reports/income-statement/branches?year=2026&month=8&branch=03 | Derivada: misma proyección, compañía de CATMULTICIA para 03 |
| Salida Excel / Descargar Excel | Sin HTTP adicional | Respuesta de vista previa; ExcelJS |
| Salida PDF / Imprimir / Guardar PDF | Sin HTTP adicional | Impresión del documento actual mediante navegador |

Options agrega years:number[], defaultYear:number y defaultBranch:'all'; conserva year y los campos anteriores. El origen actual publica únicamente [CIAPERIODO]. En el respaldo verificado, CIAPERIODO=2026. Una inspección adicional encontró pólizas aplicadas de compañía 1 exclusivamente en 2026, pese a que CIAFI/CIAFF abarcan 2025-2026. Eso no demuestra una correspondencia histórica de los saldos: no se habilita 2025 ni se etiquetan columnas actuales con otro año. BCCS2xx tampoco se interpreta como otro ejercicio. Cuando exista un adaptador histórico verificado, deberá declarar sus ejercicios y resolver las columnas/origen correspondientes antes de publicarlos.

El selector Año consume los ejercicios disponibles del servidor y no es un campo fijo ni un rango inventado. En esta base sólo se puede seleccionar 2026; otros ejercicios continúan pendientes de un origen contable verificado. La interfaz informa el único ejercicio disponible. Se conserva la validación del año en servidor.

El reporte agrega branch:'all'|'01'..'07'. Con all u omisión, conserva siete branches y consolidated:IncomeStatement. Con una sucursal, branches contiene exclusivamente ese elemento y consolidated es null. No se devuelve el mismo reporte dos veces. La compañía sigue resolviéndose desde el catálogo del servidor. La consulta acepta sólo una o siete compañías únicas; usa IN (?) o IN (?,?,?,?,?,?,?) con parámetros y centro -1. No se consulta toda la empresa para después filtrar una sucursal en el navegador. Se conserva un solo lote de saldos por solicitud.

Los filtros y la vista previa comparten una ventana ERP movible, redimensionable, minimizable y con scroll. Año, Mes y Sucursal usan Select de shadcn; Salida usa RadioGroup. Vista previa genera el resultado. Cambiar filtros oculta el resultado anterior y bloquea exportación hasta regenerar. Cambiar únicamente la salida no vuelve a consultar MySQL. Durante generación/exportación se bloquean operaciones incompatibles. Error/reintento y vacío son explícitos. Los selectores se dibujan por encima de las ventanas ERP; Escape cierra primero el desplegable activo.

Una sucursal exporta un Excel con una hoja y fórmulas propias, o un PDF de una página. Todas conserva el Excel de nueve hojas y el PDF de ocho páginas. Los nombres incluyen alcance, ejercicio y mes. El PDF utiliza el diálogo de impresión del navegador, donde se elige Guardar como PDF. No se introdujo un motor de PDF adicional.

Verificación: 142 pruebas backend; lint/build/test y lint/typecheck/build frontend. Siete respuestas individuales comparadas contra sus respectivas secciones del reporte completo. Navegador: menú superior único sólo en Contabilidad, entrada desde Pólizas y ruta directa, reapertura del reporte, filtros, descarga Excel, impresión, prevención de exportación obsoleta, error/reintento, vacío, Escape, clic exterior, interfaz ampliada, minimizar/restaurar y ausencia de errores JavaScript. Archivos verificados: PDF carta 1/8 páginas sin controles, XLSX 1/9 hojas y 78/1,616 fórmulas. Ambos libros se recalcularon con Excel de Windows en sólo lectura; totales exactos a centavos, conciliación cero y hash sin cambio al cerrar sin guardar.

Evidencia privada en captures/ui/new-version/income-statement-filters/. No hay captura SQL literal nueva de OMNIS, ni escrituras o migraciones. Las consultas nuevas o ampliadas mantienen procedencia derivada.

La misma prueba de navegador pasó sobre la compilación de producción, incluyendo descarga diferida de ExcelJS, las modalidades anteriores y navegación desde Pólizas. production-result.json registra la verificación; year-availability.json conserva el calendario y los años de pólizas observados. Verificación final: general_log=OFF en la conexión configurada y en MySQL local; servicio MySQL80 Running. No se reinició MySQL ni se modificó su configuración.
