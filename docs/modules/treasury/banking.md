# Tesorería - Bancos

## Origen y alcance

- Acceso OMNIS: botón superior **BANCOS**.
- Maestro de cuentas: `FBENC`; movimientos bancarios: `FBANMOV`; pólizas: `FPOLIZA`.
- Cuenta bancaria contrastada en la base actual: `1102100001` (`FBENC.BSEQ=6610`).
- Prefijo API: `/api/treasury/bank-accounts`.
- Alcance actual: exclusivamente `GET`. Conciliar y cualquier cierre permanecen deshabilitados.

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
| Depósitos | `/:bankAccountId/actions/deposits` | OMNIS no ejecuta SQL: indica que el movimiento debe generarse mediante póliza |
| Pagos | `/:bankAccountId/actions/payments` | En la cuenta contrastada no abrió ventana ni ejecutó SQL |
| Conciliar | `/:bankAccountId/actions/reconciliation` | `FBANMOV` + `FBENC` + `FPOLIZA`; movimientos no conciliados y contabilizados |
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
`readOnly`, `items` y, cuando corresponde, `summary`. Las ventanas y sus
botones transaccionales se reproducen en el frontend, pero permanecen
deshabilitados porque el alcance vigente es sólo lectura. Los requests
reproducibles están en `http/treasury/bank-accounts.http`.
