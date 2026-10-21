# Contabilidad: Estado de resultados

Captura del 2026-10-21, sobre el ERP local de pruebas previamente confirmado por el usuario. Recorrido: Contabilidad → menú Reportes → Estado de resultados → OK. No se modificaron API ni frontend.

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
| Contabilidad / Reportes | Estado de resultados | ACCOUNTING_INCOME_STATEMENT_OPEN | Captura auxiliar de apertura | No implementado | Contexto del diálogo; ver log local |
| Estado de resultados / Pantalla | OK | ACCOUNTING_INCOME_STATEMENT_ACCOUNTS8_MONTH22_LEVEL3_SCREEN | Capturada | No implementado; propuesta: GET /api/accounting/reports/income-statement | FCCBENC, FBENC; auxiliares FYG, FUSERS, FCIA, FTIPMV, FALMCAT |

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

No hay filtro SQL del tipo MES=22, ni GROUP BY ni SUM en estas dos lecturas. El SQL trae campos de varios meses; elegir Mes 22 y componer los renglones MES/ACUMULADO ocurre fuera de este SQL. No se ha confirmado el algoritmo interno de signos, acumulación, jerarquías ni fórmulas. La fecha 31/10/2026 es una observación del reporte generado, no una regla general deducida para otros ejercicios.

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

No se compararon importes con el frontend o con otro respaldo: la estructura y el comportamiento son la evidencia pertinente. El módulo documentado hasta ahora sólo exponía Pólizas y Clasificar; Estado de resultados constituye un reporte adicional pendiente de implementar.

## Validación

Se comprobaron los marcadores, offsets, thread, las dos parejas Prepare/Execute funcionales y el estado final de restauración. pnpm lint, pnpm build y pnpm test terminaron correctamente: 15 archivos de pruebas y 101 pruebas aprobadas. La evidencia permanece bajo captures/ y no forma parte del commit.
