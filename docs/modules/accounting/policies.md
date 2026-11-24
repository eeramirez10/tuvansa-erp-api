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

## Accion de lectura verificada

| Boton OMNIS | Endpoint | Fuente real |
|---|---|---|
| Clasificar | `GET /:id/actions/classifications` | Valores `POPAR1/POPAR2`; catalogo `FAG`, `AGT=4`, `AGTIPO=3` |

## Acciones conservadas sin escritura

La consulta histórica incluye Comentarios, Duplicar, Duplicar pasivo e Imprimir según las reglas documentadas de la ventana. La sección de diario web detalla el alcance de Aplicar y Desaplicar.

La poliza `312608-0438` (`POSEQ=598128`) se utilizo para comprobar encabezado, dos movimientos y balance de cargos/abonos.

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

## Reportes de la versión nueva

La captura de Contabilidad → Reportes → Estado de resultados se documenta en [income-statement.md](income-statement.md). La lectura usa FCCBENC + FBENC y está disponible en GET /api/accounting/reports/income-statement, con parámetros en GET /api/accounting/reports/income-statement/options y vista imprimible en el frontend.
