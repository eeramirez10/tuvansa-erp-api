# Contabilidad: Estado de resultados

Captura del 2026-10-21, sobre el ERP local de pruebas previamente confirmado por el usuario. Recorrido: Contabilidad → menú Reportes → Estado de resultados → OK. En esa captura no se modificaron API ni frontend; la implementación posterior se describe al final de este documento.

## Parámetros observados

| Campo visible | Valor |
| --- | --- |
| Cuentas | 8; ayuda visible: ('8' Solo result) |
| Mes | 22 |
| Nivel | 3 |
| Imprimir en | Pantalla |

Los valores coinciden con ER.png del escritorio. La vista previa se abrió con título ESTADO DE RESULTADOS, fecha impresa 31/10/2026, rango CUENTAS 4 AL 89999999999999, columnas MES / ACUMULADO y una página. El visor ofrece Page List, Print, Print Page, Zoom Out, Zoom In, Zoom Fit y Search. Se observan agrupaciones INGRESOS, COSTOS, GASTOS, RESULTADO INTEGRAL DE FINANCIAMIENTO y RESULTADO DEL EJERCICIO. No se enviaron páginas a una impresora.

## Trazabilidad

| Vista | Etiqueta visible | Marcador | Procedencia | Endpoint | Tablas |
| --- | --- | --- | --- | --- | --- |
| Contabilidad / Reportes | Estado de resultados | ACCOUNTING_INCOME_STATEMENT_OPEN | Captura auxiliar de apertura | GET /api/accounting/reports/income-statement/options | Contexto del diálogo; ver log local |
| Estado de resultados / Pantalla | OK | ACCOUNTING_INCOME_STATEMENT_ACCOUNTS8_MONTH22_LEVEL3_SCREEN | Capturada | GET /api/accounting/reports/income-statement | FCCBENC, FBENC; auxiliares FYG, FUSERS, FCIA, FTIPMV, FALMCAT |

Sesión válida: OMNIS PID 8528, puerto TCP local 64665, título SES: 14, correlacionado con thread_id=14 del general_log. PROCESSLIST no permitió comprobar conexiones ajenas por falta de PROCESS; no se afirma haberlo identificado mediante ese mecanismo. La atribución se apoya en el título de sesión, los intervalos de clic y las sentencias del reporte en ese mismo thread.

Intervalo válido: 2026-10-21 19:40:29.104762–19:40:55.487218 UTC (13:40:29–13:40:55, America/Mexico_City). Offsets de log: 177396–204853. El intento anterior, sobre una conexión invalidada por el reinicio, está marcado como fallido y excluido de la captura funcional.

## SQL capturado y orden real

OMNIS utilizó Prepare / Execute. El log conserva 24 Prepare y 24 Execute, además de 24 BEGIN / 24 COMMIT y cierres de sentencias. Prepare y Execute tienen el mismo texto para las dos consultas funcionales; no se cuentan como ejecuciones dobles.

Las dos ejecuciones principales proyectan 479 columnas de FCCBENC y FBENC: saldos, cargos, abonos, presupuestos y campos del catálogo. Conservan este fragmento literal:

```sql
FROM fccbenc LEFT JOIN (fbenc) ON fccbenc.BSEQ=fbenc.BSEQ
WHERE (BCOD>='4')
  AND ((BCOD>='4')&&(BCOD<CONCAT(8,'Z'))
       &&(CHAR_LENGTH(BCOD)<=4)&&(BCCCIA=1)&&(BCCCENCOS=-1))
ORDER BY BCOD,FCCBENC.BCCSEQ
LIMIT 500
```

La segunda ejecución conserva la misma proyección y filtros y termina con LIMIT 500,500. La repetición de BCOD>='4', las condiciones de compañía y centro de costos, y el orden son originales de OMNIS. Los saltos de línea del fragmento anterior se añadieron para legibilidad; el archivo literal conserva el texto del log.

No hay filtro SQL del tipo MES=22, ni GROUP BY ni SUM en estas dos lecturas. El SQL trae campos de varios meses; elegir Mes 22 y componer los renglones MES/ACUMULADO ocurre fuera de este SQL. La captura SQL no revela el algoritmo interno de signos, acumulación, jerarquías ni fórmulas. La implementación derivada y contrastada posteriormente con el PDF se describe abajo. La fecha 31/10/2026 es una observación del reporte generado, no una regla general deducida para otros ejercicios.

No se capturó una consulta independiente de totales: el visor los muestra después de leer los saldos. No debe presentarse una consulta nueva con SUM como si fuera SQL observado.

Las otras 22 ejecuciones son contexto: FYG (plantilla y parámetros especiales), FUSERS (configuración/permisos), FCIA, FTIPMV y FALMCAT (catálogos de compañía). Se conservan en el archivo completo y se excluyen del SQL funcional limpio. En el intervalo válido de este thread no se observaron INSERT, UPDATE ni DELETE.

## Procedencia y adaptación

- Capturada: texto literal de general_log, con comando y timestamp. El archivo limpio contiene solamente las dos ejecuciones principales en su orden.
- Adaptada: archivo separado con proyección reducida y el filtro duplicado consolidado, para inspeccionar campos incluidos en la consulta original. Conserva join, rango, compañía, centro de costos y orden; no equivale por sí solo a todas las fórmulas del reporte.
- Derivada: propuesta de endpoint y cualquier futura fórmula SQL de presentación/totales, hasta verificarla frente al reporte.

## Evidencia local, excluida de Git

Directorio: captures/sql/new-version/accounting/income-statement-20261021-133057/

- estado-resultados-capturado.sql: dos sentencias funcionales completas, sin modificar la proyección.
- estado-resultados-adaptado.sql: proyección reducida, explícitamente adaptada.
- functional-ordered.json: secuencia y timestamps funcionales.
- omnis-ordered.json / omnis-ordered.sql: Query, Prepare y Execute del thread 14 dentro del intervalo.
- report-interval-raw.log: intervalo crudo completo, con otras conexiones separadas en el análisis.
- general-raw.log: log crudo, incluye arranque y autenticación; no publicar ni agregar a Git.
- markers.jsonl, interval-summary.json, capture-result.json: atribución y límites de captura.
- ui/: menú, parámetros y visor. 12-report-fit.png muestra la página completa; se utilizó captura nativa PrintWindow para evitar oclusiones de otras ventanas.
- proscai_my.ini.original / my.ini.original, logging-start.json, restoration.json, general-log-final.json: respaldo y verificación.

## Restauración y límites

Se respaldaron ambos archivos, se verificó SHA-256 y se validó la configuración temporal antes de reiniciar MySQL80. La cuenta administrativa local no tenía SYSTEM_VARIABLES_ADMIN/SUPER, por lo que se empleó la modificación temporal de configuración y dos reinicios previamente autorizados.

Al terminar se restauró proscai_my.ini byte por byte; su SHA-256 coincide con el original. my.ini no cambió. MySQL80 quedó Running. SHOW GLOBAL VARIABLES LIKE 'general_log'; devolvió OFF, registrado en general-log-final.json. La restauración tuvo además un watchdog de 12 minutos como respaldo y se disparó manualmente al finalizar el intervalo.

El visor generado permanece abierto; la conexión usada antes del último reinicio deberá reconectarse para otra consulta al servidor.

No se compararon importes con el frontend o con otro respaldo: la estructura y el comportamiento son la evidencia pertinente. El módulo documentado hasta ahora sólo exponía Pólizas y Clasificar; Estado de resultados era un reporte adicional pendiente de implementar al finalizar aquella captura.

## Validación

Se comprobaron los marcadores, offsets, thread, las dos parejas Prepare/Execute funcionales y el estado final de restauración. pnpm lint, pnpm build y pnpm test terminaron correctamente: 15 archivos de pruebas y 101 pruebas aprobadas. La evidencia permanece bajo captures/ y no forma parte del commit.


## Implementación API y PDF (2026-10-22)

La API implementa el reporte de lectura bajo src/modules/accounting/reports, respetando domain, application, infrastructure y presentation. El frontend incorpora Contabilidad → Reportes → Estado de resultados, parámetros Mes/Nivel y vista previa con Imprimir / Guardar PDF. No requiere migraciones ni escrituras en MySQL o PostgreSQL.

### Contrato y procedencia

| Vista / control | Endpoint | Procedencia | Marcador / tablas |
| --- | --- | --- | --- |
| Estado de resultados / parámetros | GET /api/accounting/reports/income-statement/options | derivada: calendario, niveles y nombres; no se afirma que sea el SQL literal de apertura | ACCOUNTING_INCOME_STATEMENT_OPEN; FCIA, FALMCAT |
| Estado de resultados / OK | GET /api/accounting/reports/income-statement?accounts=8&month=22&level=3 | adaptada: lectura de saldos; derivada: composición del reporte | ACCOUNTING_INCOME_STATEMENT_ACCOUNTS8_MONTH22_LEVEL3_SCREEN; FCCBENC LEFT JOIN FBENC |
| Vista previa / Imprimir / Guardar PDF | Sin nueva petición | Presentación del mismo resultado | Impresión del navegador, papel carta |

Las respuestas contienen data. Options devuelve ejercicio, meses, niveles y valores predeterminados. El reporte devuelve companyName, companyLegalName, generatedAt, asOf, criteria, rows, totals y empty. Cada fila incluye code, label, depth, kind, month y accumulated. Los tipos de fila distinguen sección, grupo, cuenta, subtotal, total de sección y resultado final.

Sólo está habilitado Cuentas=8 (resultados), compañía 1 y centro de costos -1, como en la evidencia. Month admite los periodos configurados, hasta 24; level debe existir en los niveles de FCIA. Los parámetros extra o inválidos responden 400, configuración contable inválida 409. Ambas lecturas se sirven con Cache-Control: no-store.

### SQL adaptado

Se conserva la unión FCCBENC.BSEQ = FBENC.BSEQ, rango BCOD >= '4' y BCOD < CONCAT(8,'Z'), compañía 1, centro de costos -1, longitud máxima y ORDER BY BCOD, BCCSEQ. Se elimina el filtro duplicado y el límite de páginas para entregar el reporte completo. La proyección selecciona únicamente código, nombre, naturaleza y tres campos del periodo. Los filtros están parametrizados; las columnas se eligen de una lista interna fija de 24 periodos, nunca de identificadores SQL enviados por HTTP.

Para mes 22, los campos son BCCS122, BCCSC122 y BCCSA122. No se introduce una consulta SUM ni GROUP BY como si procediera de OMNIS.

### Reglas derivadas y verificación

Estas reglas son una implementación nueva contrastada con esquema, saldos locales y PDF proporcionado; no se presenta el código interno de OMNIS como conocido:

1. El periodo se cuenta desde CIAFI y su fecha impresa es el último día del mes; CIAFF limita el ejercicio. CIAFI=2025-01-01 y CIAFF=2026-12-31 hacen que mes 22 sea octubre de 2026 y la fecha 31/10/2026. El mes predeterminado utiliza America/Mexico_City.
2. CIACONNIV1..8 determina la longitud de los códigos por nivel. La configuración observada [1,2,4,7,10,13,16,0] hace que nivel 3 seleccione hasta cuatro caracteres. Los códigos se ordenan y se agrupan por prefijos.
3. Acumulado toma BCCS1mm. Mes toma BCCSC1mm menos BCCSA1mm. Para mostrar cada cuenta se invierte el signo cuando BNATUR=1; las cuentas de naturaleza 0 conservan el signo. No se transforma todo ingreso/gasto indiscriminadamente en valor absoluto.
4. Los saldos de padres ya contienen sus descendientes. Los subtotales usan el saldo propio del padre; no suman padre e hijos. Resultado del ejercicio es el negativo de la suma de saldos originales de las raíces, tanto mensual como acumulado.
5. Los cálculos de composición se hacen en centavos. Se omiten cuentas sin importes ni hijos visibles; los importes cero se imprimen en blanco. Códigos duplicados provocan error para evitar duplicar totales.
6. El nombre principal y ejercicio proceden de FCIA (CIAKEY=0); el segundo nombre de compañía procede de FALMCAT (CATKEY='CIA1' completado a 18 posiciones).

Con los datos locales que corresponden al PDF, se verificaron 33 renglones, mes 22/nivel 3 y estos acumulados:

| Concepto | Importe |
| --- | ---: |
| Ingresos | 230,677,633.44 |
| Costos | 197,321,522.20 |
| Gastos | 85,795,644.98 |
| Resultado integral de financiamiento | 3,584,244.10 |
| Resultado del ejercicio | -56,023,777.84 |

La columna MES del ejemplo es cero y se imprime vacía. Esto valida el ejemplo, sin equivaler a una confirmación del algoritmo interno para todas las configuraciones de PROSCAI.

La conexión actual configurada en la API apunta a otro servidor MySQL, con el mismo nombre de base pero un respaldo distinto. No se cambió el .env para forzar coincidencias. La comprobación contra el PDF usó una conexión local temporal de sólo lectura; el endpoint normal utiliza la conexión heredada configurada y, por ello, sus importes pueden diferir. No se versionan hosts, credenciales ni datos del PDF.

### Uso y validación

Requests reproducibles: http/accounting-income-statement.http. Pruebas de dominio, calendario, HTTP y SQL: tests/income-statement.test.ts. La validación completa aprobó pnpm lint, pnpm build y pnpm test (112 pruebas en 16 archivos).

El navegador se comprobó con el servicio real local: entrada directa y menú, generación, cambio de mes y nivel, impresión, error con reintento y estado vacío. Las pruebas de error y vacío fueron simuladas; el reporte principal y sus importes utilizaron la consulta real de sólo lectura.

Evidencia local excluida de Git: captures/ui/new-version/income-statement-implementation/. Incluye referencia renderizada, respuesta local, captura frontend, browser-result.json y estado-de-resultados-generado.pdf. El PDF generado se verificó como una sola página de 612 × 792 puntos (carta), sin menús de la aplicación.

La impresión usa el diálogo del navegador: seleccionar Guardar como PDF, tamaño Carta, escala 100% y desactivar encabezados y pies del navegador. El documento incluye su propia numeración de página. Niveles con más detalle pueden ocupar varias páginas.
