# Contabilidad - Polizas

Consulta de pólizas históricas y captura web de pólizas de diario. Ruta base:

`/api/accounting/policies`

## Pantalla principal y barra

| Vista o boton OMNIS | Endpoint | Fuente real |
|---|---|---|
| Poliza y movimientos | `GET /:policyId` | `FPOLIZA`; movimientos `FBANMOV + FBENC` |
| Buscar | `GET /` | `FPOLIZA` |
| Abrir por numero | `GET /by-number/:number` | `FPOLIZA` |
| Flecha anterior | `GET /:id/previous` | `PONUM < numero`, orden descendente |
| Flecha siguiente | `GET /:id/next` | `PONUM > numero`, orden ascendente |

El criterio real capturado para la vista es:

```sql
POEST = 0 AND POCIA = 1
```

El buscador reproduce **Poliza, Fecha, Aplic., Familia de Poliza y Cheque**. OMNIS usa busqueda por prefijo de `PONUM` y ordena por `PONUM, POSEQ`.

## Movimiento contable

| Columna de la pantalla | Campo real |
|---|---|
| Codigo | `FBENC.BCOD` |
| Cuenta | `FBENC.BNOMBRE` |
| Cargos | `FBANMOV.BAIMPOR` |
| Abonos | `FBANMOV.BAIMPORNEG` |
| C.C. | `FBANMOV.BACENCOS` |
| Refer. | `FBANMOV.BABENEF` |
| T.C. | `FBANMOV.BATIPOC` |

Los totales se calculan sumando cargos y abonos. `difference` permite comprobar que la poliza este balanceada.

## Clasificar

| Vista | Botón | Evidencia German | Procedencia | Endpoint | Tablas |
| --- | --- | --- | --- | --- | --- |
| Pólizas | Clasificar | `20261125-policy-class-unapplied`, `EPASIV#13/1 → EPASIV#19/239–240` | Lectura existente de MySQL y orden por código según el procedimiento | `GET /:id/actions/classifications` | `FPOLIZA`, `FAG` |
| Clasificadores | Guardar | `20261125-epasiv19-save`, `EPASIV#19/2` | Derivada del procedimiento de guardado | `PATCH /:id/actions/classifications` | `tuvansa.accounting_policy_classifications` |

German carga sólo la lista `LPAR4`, de `FAG.AGT='4'` y `AGTIPO=3`. Preselecciona el `AGTNUM` de `POPAR1`. Guardar comprueba el acceso `EPASIV#19/2` y escribe ese clasificador. El procedimiento admite pólizas vigentes con cualquiera de los dos estados de aplicación. `POPAR2` se conserva en consulta.

La API devuelve el catálogo, los valores vigentes y `summary.revision`. El PATCH exige un `compositeCode` presente en el catálogo, la revisión y un `requestKey` UUID. La escritura serializa ambos guardados sobre la misma póliza, registra el cambio con el ID y folio originales y devuelve el mismo resultado al reenviar la solicitud. Se proyecta `POPAR1` en la ficha, búsqueda y navegación. Una baja del diario web impide un nuevo guardado. La prueba de German se realizó con un catálogo vacío. La prueba HTTP usó un catálogo temporal y PostgreSQL embebido. Cubrió dos solicitudes simultáneas, revisión vencida, reintento y un fallo antes de confirmar. En Chromium, Guardar cerró el diálogo y al reabrir se mostró el valor registrado. Evidencia `ev_a0e8f532669f866ae629ec4ed3a25c98953a1dddd7d7f76870a43683bb4c2554`.

## Acciones conservadas sin escritura

La consulta histórica conserva Duplicar pasivo e Imprimir. La sección de
diario web detalla el alcance de Comentarios, Duplicar, Aplicar y Desaplicar.

La poliza `312608-0438` (`POSEQ=598128`) se utilizo para comprobar encabezado, dos movimientos y balance de cargos/abonos.

**Duplicar pasivo.** `EPASIV#13/4` requiere una familia que empieza por
`PASIVO`, pide permiso `EPASIV#13/19` y abre `ECIA#11H`. El procedimiento
usa el plazo y la moneda del proveedor, toma el tipo de cambio de `FCIA` y
calcula el IVA en proporción a los cargos de cuentas cuyo nombre contiene IVA.
Escala las partidas por el cociente del importe capturado y el abono de la
última partida. German mostró «La póliza no es un pasivo» al probar una
póliza de otra familia. El respaldo México consultado tiene cero pólizas
vigentes de esta familia. Quedan pendientes el redondeo con un folio elegible
y el cotejo de la póliza y su cargo en Saldo y Movimientos.

## Pólizas de recepciones web

| Consulta | Origen de la póliza web |
| --- | --- |
| Detalle y apertura por número | `purchase_receptions.accounting` en PostgreSQL |
| Búsqueda y navegación | Pólizas de recepción junto con el historial `FPOLIZA` |
| Clasificar | Catálogo de consulta `FAG` |

La póliza se guarda en la misma transacción que la recepción, el movimiento de inventario y el cargo al proveedor. La ficha muestra el folio de recepción en **Cheque**, la familia **COMPRAS** y los cargos y abonos guardados. La aplicación automática corresponde a `MRECEP/127 → MPASIVOS/99`. Los nombres de cuenta se consultan en `FBENC`.

Las pólizas **PAGOS PR.** de `supplier_payments` se consultan por las mismas rutas. El abono va a la cuenta bancaria y el cargo va a la cuenta del proveedor con el folio de la recepción. **Cheque** muestra el folio local de cheque o transferencia. La familia, el sentido de los movimientos y el estado aplicado corresponden a `EPRV#25/120`.

**REVERSIÓN PP** registra el cargo a Bancos y el abono al pasivo del proveedor. **CANCELACIÓN GA** intercambia los cargos y abonos de cada renglón de la póliza de Gastos múltiples, incluidos IVA y retenciones. El concepto de la contrapartida incluye el folio de la póliza original y el motivo.

Las pólizas **COBRANZA** con folio `1CW` provienen de `customer_collections`. El cargo va a la cuenta bancaria y el abono a la cuenta de Cuentas por cobrar con el folio de la remisión. **Cheque** muestra la referencia bancaria capturada o el folio PAW. Se consultan por ID, folio, búsqueda y navegación, junto con las pólizas de la base histórica.

## Pólizas de diario web

La biblioteca de pruebas abre **Póliza alta** en `MPASIVOS/37` con el tipo
definido en `CIAPOLIZACONT`. El tipo vigente de TUVANSA es `3`. `/36` exige
cargos y abonos balanceados, cuentas de detalle autorizadas para pólizas y
compatibles con la compañía. `/37` guarda las partidas y llama a `/99` para
aplicar. `/42` permite cambiar una póliza desaplicada. `/25` verifica el
periodo, pide confirmación y llama a `/98` para retirarla de los saldos.

| Operación | Endpoint |
| --- | --- |
| Periodo, fecha propuesta y centros de costo | `GET /api/accounting/policies/capture` |
| Buscar cuentas de detalle | `GET /api/accounting/policies/capture/accounts?q=…` |
| Alta y aplicación | `POST /api/accounting/policies` |
| Duplicar / Consultar fecha y revisión de la póliza de origen | `GET /api/accounting/policies/:id/actions/duplicate` |
| Duplicar / Crear y aplicar la copia | `POST /api/accounting/policies/:id/actions/duplicate` |
| Comentarios / Abrir | `GET /api/accounting/policies/:id/actions/comments` |
| Comentarios / OK | `PATCH /api/accounting/policies/:id/actions/comments` |
| Consultar acciones del diario | `GET /api/accounting/policies/:id/actions/manual` |
| Cambiar una póliza desaplicada | `PATCH /api/accounting/policies/:id` |
| Aplicar y desaplicar | `POST /api/accounting/policies/:id/actions/apply` y `…/unapply` |
| Baja | `DELETE /api/accounting/policies/:id` |

El alta crea un folio `3JW…` en pesos. La fecha debe pertenecer al rango
`CIAFI`–`CIAFF` y a `CIAPERIODO` o su año siguiente. Las partidas usan cuentas
de detalle habilitadas, centros del catálogo, importes de dos decimales y un
solo lado por renglón. El centro `0` indica que la partida carece de centro.
El diario aplicado sólo se puede cambiar después de desaplicarlo. Una póliza
con una partida conciliada queda protegida de cambio, desaplicación y baja.
Los cambios y cada acción confirman la revisión del documento. Los reintentos
con la misma clave recuperan el resultado registrado. La baja conserva las
partidas y el historial de revisiones para auditoría. Las acciones de diario
operan sobre folios `3JW…`.

**Duplicar** conserva el concepto, beneficiario, familia, cuentas, importes,
referencias y centros de costo. `EPASIV#13/3 → ECIA#11D` captura una nueva fecha,
genera el encabezado con `MPOLIZAS/24`, copia los renglones con `MPOLIZAS/25` y
aplica con `MPASIVOS/99`. El guardado web es derivado de esos procedimientos y
registra la copia en el diario `3JW…` de PostgreSQL. La copia ordinaria opera
con pólizas tipo 3, partidas en pesos y las mismas cuentas válidas del diario.
El auxiliar de CxP, los cheques y las marcas de conciliación pertenecen al
documento original. El modo de inversión por Ctrl y **Duplicar pasivo**
requieren sus propias reglas. La vista en Omnis se verificó con `312502-0010`
y se cerró desde Cancelar (`bank-inline-policy-audit-33`). Las pruebas de
escritura web se ejecutaron en una base aislada.

**Comentarios** abre **Comentarios de recepción** (`EPASIV#13/2 →
MPASIVOS/85 → EPASIV#6`). La biblioteca German abrió la ventana en la póliza
desaplicada `312512-0002`. `MPASIVOS/80` carga `#40` con `FPOLIZA.POSEQ`.
El GET usa las cabeceras de `FPOLIZA` y la lectura derivada de
`FCOMENT.COMSEQFACT` para las seis líneas `COML1–5` y `COMLETRA`.
La lectura requiere que el identificador no coincida con un `FDOC.DSEQ`.
`MPASIVOS/85` comprueba que la póliza esté desaplicada, conserva el mes
de la póliza y prepara los cambios de `FCOMENT` y `FPOLIZA`. En TUVANSA,
el Número, Usr, Captura y Cambio se muestran en consulta.

El PATCH guarda la fecha, cheque, reporte, fecha post, origen, beneficiario,
familia, concepto, importe con letra y seis líneas en una póliza web
`3JW…` desaplicada. La escritura derivada usa el diario y su bitácora
de PostgreSQL. Verifica la revisión, el mes, el periodo activo y el estado
de conciliación. La operación de Comentarios conserva los identificadores
y valores de las partidas. La búsqueda usa el cheque y los datos de
cabecera guardados. Los folios históricos se consultan en el mismo diálogo.
Evidencia `20261124-EPASIV6-COMMENTS.png`,
`20261124-EPASIV6-COMMENTS-FIELDS.png`, `20261124-MPASIVOS80-POSEQ.png` y
`20261124-MPASIVOS85-SAVE.png`.
La prueba de navegador en PostgreSQL abrió, descartó un borrador con
**Cancelar**, volvió a abrir y guardó una nota y el cheque con **OK**.
El folio apareció en la búsqueda por cheque y conservó las partidas.
Se retiró la póliza temporal al terminar.
Evidencia `ev_156e17ba7c98a88aad92de813a7ee46b4e66e4555dae549822eef4c9629b363b`.

Las partidas aplicadas alimentan los saldos de la cuenta y sus agrupadoras,
**Mayor**, **Mayor C.C.** y el **Auxiliar** del detalle. Cada partida bancaria
del diario puede entrar a **Conciliar** de forma independiente. `MPASIVOS/99`
aplica las agrupadoras por las longitudes `CIACONNIV` y `/103` y `/106`
registran el efecto firmado por cuenta y centro. El historial nativo incluye
la póliza aplicada `312502-0341`, con una partida `BATIP='3'`, `BATIPOC=1`
en el banco `1102100001`. El alcance web cubre el diario ordinario y su
movimiento de libro. Los reportes históricos por ejercicio consultan sus
fuentes archivadas.

Al registrar la conciliación de un depósito o pago web, la partida bancaria de su póliza aparece como conciliada. El estado se consulta en `bank_reconciliation_movements`. La póliza conserva sus cuentas, importes y aplicación.

### Aplicar un diario histórico desde Bancos

**Aux. no aplicados → Aplicar** reutiliza la consulta y la confirmación
de diario. El origen puede ser un folio tipo 3 de México en el periodo
autorizado si sus partidas son de detalle, cuadran en pesos y el asiento
carece de vínculos en `FAX`. La vista histórica conserva el folio, la
fecha, los identificadores y las referencias. El diario PostgreSQL
registra los cargos, abonos, centros y agrupadoras del asiento.

La revisión detecta cambios en el origen. La transacción vuelve a
validar los datos y el catálogo con el bloqueo de las cuentas. La misma
clave devuelve el resultado original. Una segunda aplicación es un
conflicto. Las consultas y los filtros **Aplicadas** y **No aplicadas**
reflejan el estado registrado en PostgreSQL. El corte puede conciliar
cada partida bancaria por separado con el `BASEQ` original.

## Reportes de la versión nueva

La captura de Contabilidad → Reportes → Estado de resultados se documenta en [income-statement.md](income-statement.md). La lectura usa FCCBENC + FBENC y está disponible en GET /api/accounting/reports/income-statement, con parámetros en GET /api/accounting/reports/income-statement/options y vista imprimible en el frontend.
### Pólizas de Traspasa +

**Bancos → Revisar → Traspasa +** registra una póliza aplicada de diario
`TRASPCTAS` con un par de renglones por movimiento marcado. Cada renglón
conserva el centro de costo y el movimiento de origen. El alta de la póliza
y el cambio de los movimientos a revisados se guardan en la misma
transacción. Véase [Bancos](../treasury/banking.md#traspasos-y-conciliación-por-archivo).

**Bancos → Aux. no aplicados → Aplicar** usa el mismo endpoint y la misma
revisión que **Contabilidad → Aplicar** para pólizas de diario web. La
confirmación valida el periodo y las cuentas antes de aplicar.
