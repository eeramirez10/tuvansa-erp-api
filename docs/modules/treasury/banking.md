# Tesorería - Bancos

## Origen y alcance

- Acceso OMNIS: botón superior **BANCOS**.
- Maestro de cuentas: `FBENC`; movimientos bancarios: `FBANMOV`; pólizas: `FPOLIZA`.
- Cuenta bancaria contrastada en la base actual: `1102100001` (`FBENC.BSEQ=6610`).
- Prefijo API: `/api/treasury/bank-accounts`.
- Alcance actual: mantenimiento del catálogo, consultas contables y registro en PostgreSQL de operaciones bancarias migradas para México. Las consultas leen el histórico de Omnis desde MySQL.

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

## Alta, Cambio y Baja

| Control | Endpoint | Procedimiento y datos |
| --- | --- | --- |
| Alta, OK, Cancelar | `GET /create`, `POST /` | `MBANCO/24` y `MBANCO/70`. Propone cuenta Otro, naturaleza deudora y moneda base. Los niveles de `FCIA` requieren el código padre cuando corresponde y evitan que una cuenta con movimientos tenga hijos. Guarda en `bank_catalog_accounts` con clave de reintento. |
| Cambio, OK, Cancelar | `GET /:id/edit`, `PATCH /:id` | `MBANCO/22`. Con Contabilidad activa, el código queda fijo. La revisión protege de cambios concurrentes. |
| Baja y confirmación | `GET /:id/edit`, `DELETE /:id` | `MBANCO/23`. Impide la baja con subcuentas, movimientos o saldos. La baja conserva el código y quita la cuenta del buscador y de la navegación. |

Los endpoints de esta sección son relativos a `/api/treasury/bank-accounts`. Las capturas `bank-full-04-alta-key.png` y `bank-full-05-cambio.png` identifican las fichas nativas. El indicador `Movs` representa la existencia de movimientos (`MBANCO/466`).

En **Alta** y **Cambio** se habilita la ficha de Bancos y el panel lateral
**Acciones** muestra **OK** y **Cancelar**. Alta enfoca Código y presenta saldos
vacíos. Cambio conserva el código de la cuenta y enfoca Familia. En
`bank-inline-alta-toggled.png` y `bank-inline-edit-toggled.png` se verificó la
edición de Control, No poder utilizar en pólizas, Presupuestable, Depósitos,
Pagos, los indicadores fiscales y las opciones de ajuste por inflación.
`bank-inline-edit-serials.png` muestra los tres consecutivos editables.
Sub ctas, Movs y los saldos son de consulta.

La propiedad `fields.fiscalReports` agrupa `annualInflationAdjustment`
(`BFISCALINFLA`, de 0 a 2), `deductibleIetu` (`BDEDUCIETU`) y
`nonDeductibleVat` (`BNODEDUCIIVA`). Alta usa sus valores predeterminados
si faltan. Cambio conserva el valor actual cuando un cliente anterior omite
esa propiedad. El catálogo web persiste esos valores y los consecutivos en
`bank_catalog_accounts`.

## Acciones capturadas

| Botón visible | Endpoint GET | SQL/origen |
| --- | --- | --- |
| Movimientos | `/:bankAccountId/actions/movements` | OMNIS no ejecuta SQL: muestra que no puede generar movimientos cuando la contabilidad está activa |
| Depósitos | `/:bankAccountId/actions/deposits` | OMNIS indica que el movimiento se genera mediante póliza. La vista web consulta los depósitos registrados en Cobranza |
| Pagos | `/:bankAccountId/actions/payments` | Para los pagos locales consulta el abono y la póliza en PostgreSQL |
| Conciliar | `/:bankAccountId/actions/reconciliation` | `FBANMOV` + `FBENC` + `FPOLIZA` para la consulta histórica. Los movimientos web pendientes se pueden seleccionar |
| Concilia Automático | `/:bankAccountId/actions/automatic-reconciliation?asOfDate=YYYY-MM-DD` | `FBANMOV` + `FPOLIZA` + `FBENC` e importación CSV o TSV. El botón **Registra** usa el mismo POST de Conciliar. |
| Auxiliar | `/:bankAccountId/actions/auxiliary?fiscalYear=YYYY` | `FBANMOV` + `FBENC` + `FPOLIZA`; reproduce `BAMES=1`, póliza aplicada y año fiscal. La web muestra comentarios, póliza y fecha de conciliación cuando existen. |
| Gastos por prv. | `/:bankAccountId/actions/supplier-expenses/capture` | Consulta recepciones web pendientes. El POST en `/:bankAccountId/actions/supplier-expenses` registra un pago `PP` por cheque para la cuenta abierta. |
| Mayor | `/:bankAccountId/actions/general-ledger` | Meses de `FBENC` más cargos y abonos web del ejercicio. **Iguales** y **Cambiar** guardan los doce meses del primer periodo con PATCH en la misma ruta. |
| Mayor C.C. | `/:bankAccountId/actions/cost-center-ledger?costCenter=1` | Centros de `FALMCAT` (`CATTIPO='CEN'`) y registro `FCCBENC.BCCKEY='01'+C.C.+BCOD`. El PATCH guarda el primer presupuesto del centro seleccionado. |
| Revisar | `/:bankAccountId/actions/authorization-review` | `FBANMOV` + `FBENC` + `FPOLIZA`; reproduce `BAAUTORIZADO<>'*'`. El PATCH marca la revisión de partidas web aplicadas con `*`. |
| Clasificar | `/:bankAccountId/actions/classifiers` | Nueve niveles de `FAG`, `AGT=1..9` y `AGTIPO=3`, con valores de `FBENC.BPAR1..9`. El PATCH guarda las claves disponibles. |
| Traspasos entre Cuentas | `/:bankAccountId/actions/transfer/capture` | `FTIPMV.TICLA='3'` y `FCIA.CIAPOLIZACONT`. El POST en `/:bankAccountId/actions/transfer` registra una póliza de diario con dos partidas. |
| Aux. no aplicados | `/:bankAccountId/actions/unapplied-auxiliary?fiscalYear=YYYY` | `FBANMOV` + `FBENC` + `FPOLIZA`; `BAMES=1` y `POAPLICADA=0`. Consulta, comentarios e impresión si hay una póliza seleccionada. |

Todos los paneles devuelven `button`, `section`, `source`, `available`,
`readOnly`, `items` y, cuando corresponde, `summary`. Los requests
reproducibles están en `http/treasury/bank-accounts.http` y
`http/treasury/bank-catalog-and-actions.http`. Presupuestos, clasificadores y
revisión se guardan en `bank_panel_settings` con revisión por cuenta, operación
y centro cuando corresponde.

## Traspasos y conciliación por archivo

**Traspasos entre Cuentas** abre la cuenta destino y permite elegir otra cuenta en pesos con permiso de pagos. La cuenta destino debe admitir depósitos. La captura nativa `bank-full-08-transfer.png` muestra el tipo 3 y el modo **Traspas**. La web asigna un folio `BW`, crea el cargo, el abono y una póliza de diario aplicada en la misma transacción. Cada partida se concilia en su propia cuenta. La operación registra el asiento en PostgreSQL.

**Concilia Automático** compara las partidas pendientes con un archivo CSV o TSV. El archivo debe contener las columnas `Fecha`, `Referencia`, `Ingresos` y `Egresos`, con fecha `AAAA-MM-DD` o `DD/MM/AAAA` y punto decimal. La vista selecciona coincidencias únicas por referencia e importe firmado. **Liga** permite resolver filas ambiguas con una partida pendiente del mismo importe y signo. Se pueden quitar coincidencias antes de registrar. La captura nativa `bank-full-24-auto-open.png` muestra la comparación de los dos auxiliares. El CSV y el TSV son formatos de intercambio de la web.

La instancia mexicana opera con Contabilidad activa. **Movimientos** remite a pólizas y **Depósitos** consulta los registros de Cobranza. **Gastos por prv.** permite pagar recepciones locales y el gasto fiscal GA conserva su flujo pendiente. La modalidad **Cheque** de traspaso y **Imprimir cheque** dependen del flujo y formato bancario nativo. **Aplicar** en **Aux. no aplicados** depende de la migración de pólizas pendientes. En **Revisar** la marca web aplica a partidas web registradas. El cambio de estado de partidas históricas a tránsito y la operación nativa **Traspasa +** quedan pendientes.

## Pagos de recepciones migradas

El origen del pago es **Proveedores → Programar pagos → Paga** (`MPRV/9 → EPRV#25/98 → /120`). Omnis abre `ECIA#11JD` para la cuenta, Cheque o Transferencia y el concepto. En TUVANSA, `/120` aplica el importe programado en un movimiento `PP`, incrementa el consecutivo de la modalidad, crea la póliza de egresos indicada por `CIAPOLIZAEGR` y la aplica mediante `MPASIVOS/99`. Se comprobó el vínculo histórico por `FAX.AREFPAG`, `FAX.APOLIZA` y `FBANMOV`.

La web registra pagos parciales y liquidaciones de una recepción local en pesos. El pago recibe su folio `TW` o `CW` por cuenta y modalidad. **Pagos** y **Auxiliar** presentan el abono de la cuenta y enlazan a la póliza aplicada. Cambia el saldo contable. El registro parte sin conciliación y conserva el saldo bancario conciliado. La captura registra el movimiento contable en PostgreSQL. La transferencia bancaria y la emisión del cheque se realizan fuera de esta captura.

## Depósitos de cobranza

**Clientes → Saldo → Cobrar** registra el depósito en PostgreSQL. **Depósitos** y **Auxiliar** muestran el cargo PC al banco, el folio PAW, la referencia bancaria y el vínculo a la póliza aplicada **COBRANZA**. El cargo aumenta el saldo contable. La consulta de conciliación lo muestra como pendiente.

## Conciliación manual

En la biblioteca de pruebas, **Bancos → Conciliar** de la cuenta `1102100001` muestra **Saldo BANCO**, **Saldo tránsit**, **Suma sel.** y los botones **Conciliar** y **Registrar**. La ventana observada en `recon-21-native-footer.png` conserva separados los importes de Cargos y Abonos. La captura histórica del módulo consulta `FBANMOV.BAOK` para distinguir los pendientes de los conciliados con `X` y `FBENC.BSALDOB1` para el saldo bancario. `MBANCO/112` usa el signo `BAIMPOR − BAIMPORNEG`. El flujo web usa ese signo para sumar los depósitos y restar los pagos elegidos sobre el saldo bancario de origen. La captura del estado de cuenta es una validación web.

| Vista y control | Endpoint | Procedencia y efecto |
| --- | --- | --- |
| Bancos / Conciliar | `GET /api/treasury/bank-accounts/:id/actions/reconciliation` | Captura histórica y SQL derivado de `supplier_payments`, `customer_collections`, `bank_transfer_movements` y `bank_reconciliation_movements`. Los pagos, depósitos y traspasos web pendientes son seleccionables |
| Conciliar / Selección | Operación en pantalla | Muestra la suma firmada y el nuevo saldo calculado |
| Conciliar / Registrar | `POST /api/treasury/bank-accounts/:id/actions/reconciliation` | SQL derivado. Registra un corte en `bank_reconciliations` y las partidas en `bank_reconciliation_movements` en la misma transacción |
| Conciliar / Cancelar | Cerrar la ventana | Descarta la selección |

El saldo ingresado del estado de cuenta debe coincidir al centavo con el saldo calculado. La fecha debe ser igual o posterior al último corte web y a los movimientos elegidos. El día actual de México es el límite superior. El servidor valida el saldo previo, la cuenta, la selección y el corte bajo bloqueo. Cada movimiento pertenece a un solo registro de conciliación. Un reintento con la misma clave y datos recupera el registro original.

Al registrar, los movimientos elegidos salen de **Conciliar** y **Concilia Automático**. **Auxiliar**, **Pagos** y **Depósitos** conservan los registros con marca `X` y la fecha del estado de cuenta. En Contabilidad se marca conciliada la partida bancaria de la póliza. El saldo contable, los importes de las pólizas y el saldo en tránsito se conservan.
