# Tesorería - Bancos

## Origen y alcance

- Acceso OMNIS: botón superior **BANCOS**.
- Maestro de cuentas: `FBENC`; movimientos bancarios: `FBANMOV`; pólizas: `FPOLIZA`.
- Cuenta bancaria contrastada en la base actual: `1102100001` (`FBENC.BSEQ=6610`).
- Prefijo API: `/api/treasury/bank-accounts`.
- Alcance actual: consultas de Bancos y registro de conciliación manual de depósitos y pagos web en México.

El módulo sigue Clean Architecture. Los contratos están en `domain/datasources` y
`domain/repositories`; las consultas legacy viven únicamente en
`infrastructure/datasources`; los repositories de infraestructura sólo delegan.

## Pantalla y barra compartida

| Control OMNIS / vista | Endpoint | Uso en frontend |
| --- | --- | --- |
| Apertura vacía + primer avance | `GET /api/treasury/bank-accounts/first` | Primera cuenta disponible |
| Ficha Bancos | `GET /api/treasury/bank-accounts/:bankAccountId` | Datos, saldos, control, moneda, fiscal y Mayor |
| Carga directa | `GET /api/treasury/bank-accounts/by-code/:code` | Abre un código contable conocido |
| Flecha izquierda | `GET /api/treasury/bank-accounts/:bankAccountId/previous` | Cuenta anterior por `BCOD` |
| Buscar | `GET /api/treasury/bank-accounts?...` | Busca por código, número de cuenta o nombre |
| Flecha derecha | `GET /api/treasury/bank-accounts/:bankAccountId/next` | Cuenta siguiente por `BCOD` |

## Mapeo de la ficha

| Zona OMNIS | Campos API | Columnas legacy |
| --- | --- | --- |
| Datos de la cuenta | `code`, `family`, `accountNumber`, `branch`, `name`, `nature`, `systemType` | `BCOD`, `BFAM`, `BCTA`, `BSUCURSAL`, `BNOMBRE`, `BNATUR`, `BTIPO` |
| Saldos | `balances.*` | `BSALDOR1`, `BSALDOB1`, `BS100`, `BSALDOTR1` |
| Control | `control.*` | `BGERENTE`, `BTELEFONO`, `BNUMCLI`, `BCONTROL`, `BCHEQNUM`, `BDEPNUM`, `BTRANSFNUM`, `BSUBCTAS`, `BNOPOLIZA`, `BREPORTE`, `BMOVS`, `BPRESUP`, `BCIA`, `BDEPOS`, `BPAGOS`, `BMULTICIA` |
| Moneda | `currency`, `currencyBalances.*`, `createdAt` | `BMONEDA`, `BSALDOMONEDA1`, `BSALDOMONEDA1MS12`, `BSALDOANTMONEDA1`, `BALTA` |
| Prorrateo | `prorationPercentages.*` | `BPRORRA1..BPRORRA4` |
| Reportes fiscales | `fiscalReports.*` | `BFISCALINFLA`, `BDEDUCIETU`, `BNODEDUCIIVA` |
| Mayor | `ledger.firstPeriod`, `ledger.secondPeriod` | `BS*`, `BSC*`, `BSA*`, `BSP01..BSP24` |

## Acciones capturadas

| Botón visible | Endpoint GET | SQL/origen |
| --- | --- | --- |
| Movimientos | `/:bankAccountId/actions/movements` | OMNIS no ejecuta SQL: muestra que no puede generar movimientos cuando la contabilidad está activa |
| Depósitos | `/:bankAccountId/actions/deposits` | OMNIS indica que el movimiento se genera mediante póliza. La vista web consulta los depósitos registrados en Cobranza |
| Pagos | `/:bankAccountId/actions/payments` | Para los pagos locales consulta el abono y la póliza en PostgreSQL |
| Conciliar | `/:bankAccountId/actions/reconciliation` | `FBANMOV` + `FBENC` + `FPOLIZA` para la consulta histórica. Los movimientos web pendientes se pueden seleccionar |
| Concilia Automático | `/:bankAccountId/actions/automatic-reconciliation?asOfDate=YYYY-MM-DD` | `FBANMOV` + `FPOLIZA` + `FBENC`; pendientes sin tránsito hasta la fecha indicada |
| Auxiliar | `/:bankAccountId/actions/auxiliary?fiscalYear=YYYY` | `FBANMOV` + `FBENC` + `FPOLIZA`; reproduce `BAMES=1`, póliza aplicada y año fiscal |
| Gastos por prv. | `/:bankAccountId/actions/supplier-expenses` | La apertura sólo cargó configuración de sesión; el alta/pago se conserva deshabilitado |
| Mayor | `/:bankAccountId/actions/general-ledger` | Valores mensuales ya cargados desde `FBENC` |
| Mayor C.C. | `/:bankAccountId/actions/cost-center-ledger?costCenter=1` | Catálogo `FALMCAT` (`CATTIPO='CEN'`) y registro exacto `FCCBENC.BCCKEY='01'+C.C.+BCOD` |
| Revisar | `/:bankAccountId/actions/authorization-review` | `FBANMOV` + `FBENC` + `FPOLIZA`; reproduce `BAAUTORIZADO<>'*'` |
| Clasificar | `/:bankAccountId/actions/classifiers` | Nueve lecturas de `FAG`, `AGT=1..9` y `AGTIPO=3` |
| Traspasos entre Cuentas | `/:bankAccountId/actions/transfer` | Configuración exacta `FTIPMV.TICLA='3'`; la operación permanece deshabilitada |
| Aux. no aplicados | `/:bankAccountId/actions/unapplied-auxiliary?fiscalYear=YYYY` | `FBANMOV` + `FBENC` + `FPOLIZA`; `BAMES=1` y `POAPLICADA=0` |

Todos los paneles devuelven `button`, `section`, `source`, `available`,
`readOnly`, `items` y, cuando corresponde, `summary`. Los requests
reproducibles están en `http/treasury/bank-accounts.http`.

## Pagos de recepciones migradas

El origen del pago es **Proveedores → Programar pagos → Paga** (`MPRV/9 → EPRV#25/98 → /120`). Omnis abre `ECIA#11JD` para la cuenta, Cheque o Transferencia y el concepto. En TUVANSA, `/120` aplica el importe programado en un movimiento `PP`, incrementa el consecutivo de la modalidad, crea la póliza de egresos indicada por `CIAPOLIZAEGR` y la aplica mediante `MPASIVOS/99`. Se comprobó el vínculo histórico por `FAX.AREFPAG`, `FAX.APOLIZA` y `FBANMOV`.

La web registra pagos parciales y liquidaciones de una recepción local en pesos. El pago recibe su folio `TW` o `CW` por cuenta y modalidad. **Pagos** y **Auxiliar** presentan el abono de la cuenta y enlazan a la póliza aplicada. Cambia el saldo contable. El registro parte sin conciliación y conserva el saldo bancario conciliado. La captura registra el movimiento contable en PostgreSQL. La transferencia bancaria y la emisión del cheque se realizan fuera de esta captura.

## Depósitos de cobranza

**Clientes → Saldo → Cobrar** registra el depósito en PostgreSQL. **Depósitos** y **Auxiliar** muestran el cargo PC al banco, el folio PAW, la referencia bancaria y el vínculo a la póliza aplicada **COBRANZA**. El cargo aumenta el saldo contable. La consulta de conciliación lo muestra como pendiente.

## Conciliación manual

En la biblioteca de pruebas, **Bancos → Conciliar** de la cuenta `1102100001` muestra **Saldo BANCO**, **Saldo tránsit**, **Suma sel.** y los botones **Conciliar** y **Registrar**. La ventana observada en `recon-21-native-footer.png` conserva separados los importes de Cargos y Abonos. La captura histórica del módulo consulta `FBANMOV.BAOK` para distinguir los pendientes de los conciliados con `X` y `FBENC.BSALDOB1` para el saldo bancario. `MBANCO/112` usa el signo `BAIMPOR − BAIMPORNEG`. El flujo web usa ese signo para sumar los depósitos y restar los pagos elegidos sobre el saldo bancario de origen. La captura del estado de cuenta es una validación web.

| Vista y control | Endpoint | Procedencia y efecto |
| --- | --- | --- |
| Bancos / Conciliar | `GET /api/treasury/bank-accounts/:id/actions/reconciliation` | Captura de consulta histórica y SQL derivado de `supplier_payments`, `customer_collections` y `bank_reconciliation_movements`. Sólo los depósitos y pagos web pendientes son seleccionables |
| Conciliar / Selección | Operación en pantalla | Muestra la suma firmada y el nuevo saldo calculado |
| Conciliar / Registrar | `POST /api/treasury/bank-accounts/:id/actions/reconciliation` | SQL derivado. Registra un corte en `bank_reconciliations` y las partidas en `bank_reconciliation_movements` en la misma transacción |
| Conciliar / Cancelar | Cerrar la ventana | Descarta la selección |

El saldo ingresado del estado de cuenta debe coincidir al centavo con el saldo calculado. La fecha debe ser igual o posterior al último corte web y a los movimientos elegidos. El día actual de México es el límite superior. El servidor valida el saldo previo, la cuenta, la selección y el corte bajo bloqueo. Cada movimiento pertenece a un solo registro de conciliación. Un reintento con la misma clave y datos recupera el registro original.

Al registrar, los movimientos elegidos salen de **Conciliar** y **Concilia Automático**. **Auxiliar**, **Pagos** y **Depósitos** conservan los registros con marca `X` y la fecha del estado de cuenta. En Contabilidad se marca conciliada la partida bancaria de la póliza. El saldo contable, los importes de las pólizas y el saldo en tránsito se conservan.
