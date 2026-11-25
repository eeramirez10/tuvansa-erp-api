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
| Pagos | `/:bankAccountId/actions/payments` | Consulta el abono local y su póliza. Al seleccionar un PP web aparece **Revertir PP** o **Ver reversión** |
| Conciliar | `/:bankAccountId/actions/reconciliation` | `FBANMOV` + `FBENC` + `FPOLIZA` para la consulta histórica. Permite seleccionar movimientos web e históricos elegibles |
| Concilia Automático | `/:bankAccountId/actions/automatic-reconciliation?asOfDate=YYYY-MM-DD` | `FBANMOV` + `FPOLIZA` + `FBENC` e importación CSV o TSV. El botón **Registra** usa el mismo POST de Conciliar. |
| Auxiliar | `/:bankAccountId/actions/auxiliary?fiscalYear=YYYY` | `FBANMOV` + `FBENC` + `FPOLIZA`; reproduce `BAMES=1`, póliza aplicada y año fiscal. La web muestra comentarios, póliza y fecha de conciliación cuando existen. |
| Gastos por prv. | `/:bankAccountId/actions/supplier-expenses` | Consulta **Compras por proveedor** de la cuenta. **Pagar recepción** consulta pendientes en `/capture` y registra un PP por cheque con POST en la ruta del informe. |
| Mayor | `/:bankAccountId/actions/general-ledger` | Meses de `FBENC` más cargos y abonos web del ejercicio. **Iguales** y **Cambiar** guardan los doce meses del primer periodo con PATCH en la misma ruta. |
| Mayor C.C. | `/:bankAccountId/actions/cost-center-ledger?costCenter=1` | Centros de `FALMCAT` (`CATTIPO='CEN'`) y registro `FCCBENC.BCCKEY='01'+C.C.+BCOD`. El PATCH guarda el primer presupuesto del centro seleccionado. |
| Revisar | `/:bankAccountId/actions/authorization-review` | `FBANMOV` + `FBENC` + `FPOLIZA`; reproduce `BAAUTORIZADO<>'*'`. El PATCH guarda `*` para partidas históricas elegibles y partidas web aplicadas. |
| Clasificar | `/:bankAccountId/actions/classifiers` | Nueve niveles de `FAG`, `AGT=1..9` y `AGTIPO=3`, con valores de `FBENC.BPAR1..9`. El PATCH guarda las claves disponibles. |
| Traspasos entre Cuentas | `/:bankAccountId/actions/transfer/capture?direction=outgoing` | `FTIPMV.TICLA='3'` y `FCIA.CIAPOLIZACONT`. El POST en `/:bankAccountId/actions/transfer` registra Cheque o Traspas y la póliza de diario con dos partidas. |
| Aux. no aplicados | `/:bankAccountId/actions/unapplied-auxiliary?fiscalYear=YYYY` | `FBANMOV` + `FBENC` + `FPOLIZA`; `BAMES=1` y `POAPLICADA=0`. Suma las partidas del diario web sin aplicar. Consulta comentarios e impresión de la póliza seleccionada. |

La reversión de un PP desde **Pagos** o Proveedores restablece el saldo del proveedor por el importe del pago elegido. **Pagos** y **Auxiliar** muestran el abono PP y el cargo RP por separado. Si el PP estaba pendiente, las dos partidas quedan fuera de **Conciliar**. Si estaba conciliado, conserva su marca X y su corte y el RP entra en **Conciliar** como cargo independiente. El saldo bancario del estado de cuenta incorpora la corrección cuando se registra el corte del RP. La póliza de reversión carga la misma cuenta bancaria y abona el pasivo.

En el respaldo local de German de pruebas, **GA32707** tiene dos PP de signo contrario con pólizas aplicadas `212406-0288` y `312409-0994`. Sus movimientos bancarios, `BASEQ 1704191` y `1784328` de la cuenta `1102100001`, tienen marca X. Los cortes registrados en `BAFECHARECIBO` son del 30 de junio y 30 de septiembre de 2024. **GA31031** conserva el mismo patrón con cortes del 29 de febrero y 30 de noviembre de 2024. La lectura de `FDOC`, `FAX`, `FBANMOV`, `FBENC` y `FPOLIZA` fue adaptada para contrastar los importes, el pasivo y la cuenta. El estado inicial pendiente del RP en PostgreSQL deriva de la regla web de conciliar cada movimiento de forma explícita.

La prueba en PostgreSQL registró dos pagos, de 40 y 20 MXN, contra un gasto de 116 MXN. La reversión del PP de 40 MXN incrementó el saldo pendiente de 56 a 96 MXN. El corte original conservó su vínculo con el PP. Se registró un corte independiente para el RP y se verificaron los signos y las marcas en sus pólizas. Los registros temporales se retiraron al terminar.

Todos los paneles devuelven `button`, `section`, `source`, `available`,
`readOnly`, `items` y, cuando corresponde, `summary`. Los requests
reproducibles están en `http/treasury/bank-accounts.http` y
`http/treasury/bank-catalog-and-actions.http`. Presupuestos, clasificadores y
revisión se guardan en `bank_panel_settings` con revisión por cuenta, operación
y centro cuando corresponde.

## Traspasos y conciliación por archivo

**Traspasos entre Cuentas** usa la cuenta abierta como origen. El usuario
elige una cuenta destino distinta que admita depósitos en pesos. La captura
nativa `bank-inline-traspas-mode-destination.png` confirma ese sentido para
**Traspas**. **Cheque** permite capturar el número y muestra como referencia el
siguiente número de la cuenta de origen. La API valida que el cheque no esté
registrado para esa cuenta.

La prueba local de Omnis del 23/11/2026 creó la póliza de diario
`312512-0002`, con número de cheque 18886 en `FPOLIZA.POCHEQUE`. La póliza
pasó de `POAPLICADA=0` a `1` durante la misma acción. En `FBANMOV`, el origen
tuvo un abono de $12.34 y el destino un cargo de $12.34. `BCHEQNUM` avanzó
en el emisor. Los saldos contables cambiaron al aplicarse y los saldos
conciliados conservaron su valor. La captura `bank-inline-policy-fixture.png`
y las lecturas comparativas están guardadas en `captures/`. La Baja nativa
de esa póliza restituyó los saldos y dejó su registro de auditoría y el
consecutivo avanzado.

La web asigna un folio `BW` y guarda la póliza aplicada y las dos partidas en
una transacción PostgreSQL. El número registrado por **Cheque** se refleja en
la ficha y en la póliza. Cada partida se concilia por separado. La consulta
Auxiliar usa el año fiscal abierto cuando el cliente no especifica un año.
Los clientes que envían `sourceBankAccountId` conservan el contrato anterior
para la modalidad **Traspas**.

**Concilia Automático** compara las partidas pendientes con un archivo CSV o TSV. El archivo debe contener las columnas `Fecha`, `Referencia`, `Ingresos` y `Egresos`, con fecha `AAAA-MM-DD` o `DD/MM/AAAA` y punto decimal. La vista selecciona coincidencias únicas por referencia e importe firmado. **Liga** permite resolver filas ambiguas con una partida pendiente del mismo importe y signo. Se pueden quitar coincidencias antes de registrar. La captura nativa `bank-full-24-auto-open.png` muestra la comparación de los dos auxiliares. El CSV y el TSV son formatos de intercambio de la web.

La instancia mexicana opera con Contabilidad activa. **Movimientos** remite a pólizas y **Depósitos** consulta los registros de Cobranza y los cheques de traspaso recibidos. **Imprimir cheque** depende del formato bancario nativo; las dos cuentas probadas tenían `FBENC.BREPORTE` vacío.

**Aux. no aplicados → Aplicar** (`EBANCO#4A/21`) usa la póliza seleccionada,
ejecuta `MPASIVOS/99` y recarga el auxiliar. La web consulta
`GET /api/accounting/policies/:id/actions/manual` y confirma mediante
`POST /api/accounting/policies/:id/actions/apply`. Admite el diario
web y el diario histórico elegible, con su folio y partidas originales.
La partida sale del auxiliar pendiente, aparece en **Auxiliar** y queda
disponible en **Conciliar** si cumple sus reglas. La aplicación cambia
el saldo contable. El saldo bancario incorpora el movimiento al
registrar su propio corte.

La ruta histórica usa `FPOLIZA`, `FBANMOV` y `FAX` como lectura
adaptada. `MPASIVOS/99` verifica el periodo y aplica a las cuentas, sus
agrupadoras y centros mediante `/103` y `/106`. PostgreSQL registra
la operación derivada en las tablas `manual_accounting_policy_*` con
los `POSEQ` y `BASEQ` originales. El respaldo MySQL se usa en lectura.
La aplicación histórica se limita a un diario ordinario de México,
cuadrado en pesos, sin partidas conciliadas ni documentos vinculados.
Capturas `closure-bank-unapplied-ready.png` y `closure-bank-aux-apply-proc21.png`.
El periodo activo del respaldo sólo contiene una póliza pendiente con
las partidas bancarias en cero.

Para verificar un importe, el servidor de pruebas aisló el periodo 2022
y usó el folio `312202-0092` del respaldo. Chromium aplicó 3,127.50 MXN
desde **Aux. no aplicados**. El cargo apareció una sola vez en **Auxiliar**
y conservó el cheque y la póliza. **Conciliar** admitió el mismo
`BASEQ 971276` en un corte posterior. Se comprobaron el reintento, una
revisión vencida, los filtros de Pólizas y la limpieza de PostgreSQL.
La sesión nativa perdió la conexión al iniciar la ronda. La comparación
usa los procedimientos exportados y la lectura del respaldo antes y
después de las pruebas web.

**Revisar** abre **Autorizar** (`EBANCO#11`). Los procedimientos `/1`,
`/2` y `/99` consultan la partida por `FBANMOV.BASEQ` y modifican
`BAAUTORIZADO` mediante `MBASE/74`. La vista histórica de la cuenta
`1102100001` mostró partidas con pólizas sin aplicar y permitió cambiar la
marca en pantalla. La consulta adaptada conserva `POEST=0`, `POCIA=1` y
`BAAUTORIZADO<>'*'`. La revisión web guarda la marca local y protege el
conjunto por revisión. La cuenta, el corte y la póliza de origen conservan
sus importes. Capturas `closure-bank-review-first-draft-ready.png` y
`closure-bank-review-proc99.png`.

La prueba web de `BASEQ=418562` registró `*`, abrió la póliza vinculada y
volvió a mostrar la partida con **Filtra \***. El mismo PATCH fue
idempotente. Una selección distinta con la revisión anterior recibió
conflicto. Los saldos y la póliza conservaron los valores previos.

**Traspasa +** (`EBANCO#11/24`) toma las partidas con `BAAUTORIZADO='+'`
de **Autorizar**. German pide la cuenta destino y la fecha, crea una sola
póliza de diario **TRASPASO CUENTAS** con origen `TRASPCTAS` y marca las
partidas de origen con `*`. Para un cargo, abona origen y carga destino.
Para un abono, carga origen y abona destino. Conserva tipo y centro de
costo en cada par de líneas. Aplica la póliza con `MPASIVOS/99`. La
procedencia es el procedimiento observado en
`closure-bank-transfers-plus-proc24.png` y
`closure-bank-transfer-plus-proc24-tail.png`.

| Vista y control | Endpoint | Procedencia y efecto |
| --- | --- | --- |
| Revisar / A | `PATCH /api/treasury/bank-accounts/:id/actions/authorization-review` | Marca `+` o la quita en `bank_panel_settings`. Guarda la revisión para confirmar el conjunto. |
| Revisar / Traspasa + | `POST /api/treasury/bank-accounts/:id/actions/authorization-review/transfer` | Derivada. Consume las marcas y registra la póliza aplicada en `manual_accounting_policies` y `manual_accounting_policy_lines` dentro de la misma transacción. |

La ficha refleja el traslado en saldo contable. Ambas partidas bancarias
quedan disponibles para conciliación por separado. La póliza permite
rastrear cada renglón a la partida de origen. Un cambio del conjunto de
marcas devuelve conflicto. Un reintento con la clave original recupera
la póliza.

La prueba en Chromium y Neon trasladó un cargo y un abono de la cuenta
`1102100001` a `1102100002` en una póliza aplicada de cuatro renglones.
Verificó los tipos, centros, marcas, saldos contables y partidas pendientes
para conciliar. Una selección incompleta y una fecha de otro periodo no
generaron póliza. Se retiraron la póliza y las marcas de prueba.

**Bancos → Gastos por prv.** abre el informe **Compras por proveedor**
(`EBANCO#1/8 → EBANCO#9`). `EBANCO#9/240` carga `FBANMOV` por la cuenta
seleccionada, con `PRVSEQ<>0`, `BAMES=1`, `FDOC.DEST=CIAKYT` y
`FDOC.DMULTICIA=LVCIA`. `MSQL/276` relaciona por secuencia; la consulta web
adaptada usa `FBANMOV.DSEQ = FDOC.DSEQ` y totaliza `BAIMPOR` y
`BAIMPORNEG`. La copia local actual carece de `FBANMOV.DSEQ`, por lo que el
informe presenta los totales en cero y el motivo. Las capturas
`bank-inline-gastos-ebanco9-proc240.png` y
`bank-inline-gastos-creditor-report.png` documentan el procedimiento y
su resultado local.

La captura fiscal GA está en **Recepciones → Gastos múltiples**
(`MRECEP/5 → ERECEP#12`). **Pagar recepción** registra un PP por cheque
para recepciones y gastos web con saldo pendiente. Los detalles de captura y
póliza están en [Recepciones](../purchasing/purchase-receptions.md).

En la captura manual GA, `ERECEP#12/401` crea la póliza de diario y la aplica.
`/402` genera documentos por proveedor y referencia, y partidas por producto
y centro de costo. `/403` contabiliza gastos, IVA, retenciones y el saldo por
pagar. `/411` verifica las cuentas contables de proveedor y producto, y
`/412` valida que la referencia del proveedor esté disponible.
La compañía local tiene vacías `CIACTAIVAPAGOACRDE`, `CIACTARETIVADE` y
`CIACTARETISRDE`, las cuentas que consulta `/403` para los importes de IVA
y retenciones.

## Pagos de recepciones migradas

El origen del pago es **Proveedores → Programar pagos → Paga** (`MPRV/9 → EPRV#25/98 → /120`). Omnis abre `ECIA#11JD` para la cuenta, Cheque o Transferencia y el concepto. En TUVANSA, `/120` aplica el importe programado en un movimiento `PP`, incrementa el consecutivo de la modalidad, crea la póliza de egresos indicada por `CIAPOLIZAEGR` y la aplica mediante `MPASIVOS/99`. Se comprobó el vínculo histórico por `FAX.AREFPAG`, `FAX.APOLIZA` y `FBANMOV`.

La web registra pagos parciales y liquidaciones de una recepción local en pesos. El pago recibe su folio `TW` o `CW` por cuenta y modalidad. **Pagos** y **Auxiliar** presentan el abono de la cuenta y enlazan a la póliza aplicada. Cambia el saldo contable. El registro parte sin conciliación y conserva el saldo bancario conciliado. La captura registra el movimiento contable en PostgreSQL. La transferencia bancaria y la emisión del cheque se realizan fuera de esta captura.

## Depósitos de cobranza

**Clientes → Saldo → Cobrar** registra el depósito en PostgreSQL. **Depósitos** y **Auxiliar** muestran el cargo PC al banco, el folio PAW, la referencia bancaria y el vínculo a la póliza aplicada **COBRANZA**. El cargo aumenta el saldo contable. La consulta de conciliación lo muestra como pendiente.

## Conciliación manual

En la biblioteca de pruebas, **Bancos → Conciliar** de la cuenta `1102100001` muestra **Saldo BANCO**, **Saldo tránsit**, **Suma sel.** y los botones **Conciliar** y **Registrar**. La ventana observada en `recon-21-native-footer.png` conserva separados los importes de Cargos y Abonos. La captura histórica del módulo consulta `FBANMOV.BAOK` para distinguir los pendientes de los conciliados con `X` y `FBENC.BSALDOB1` para el saldo bancario. `MBANCO/112` usa el signo `BAIMPOR − BAIMPORNEG`. El flujo web usa ese signo para sumar los depósitos y restar los pagos elegidos sobre el saldo bancario de origen. La captura del estado de cuenta es una validación web.

| Vista y control | Endpoint | Procedencia y efecto |
| --- | --- | --- |
| Bancos / Conciliar | `GET /api/treasury/bank-accounts/:id/actions/reconciliation` | Captura histórica y SQL derivado de `supplier_payments`, `customer_collections`, `bank_transfer_movements` y `bank_reconciliation_movements`. Incluye las partidas históricas elegibles por `BASEQ` |
| Conciliar / Selección | Operación en pantalla | Muestra la suma firmada y el nuevo saldo calculado |
| Conciliar / Tránsito | `PATCH /api/treasury/bank-accounts/:id/actions/reconciliation/transit` | Lectura adaptada de `FBANMOV`, `FBENC` y `FPOLIZA`. Escritura derivada en `bank_reconciliation_transit` con el mismo bloqueo por cuenta que **Registrar** |
| Conciliar / FP | `PATCH /api/treasury/bank-accounts/:id/actions/reconciliation/postdate` | Fecha de posfechado de una póliza histórica enfocada. Escritura derivada en `bank_policy_postdates`, bajo los bloqueos por cuenta y con revisión y clave de reintento |
| Conciliar / Detalle | `GET /api/treasury/bank-accounts/:id/actions/reconciliation/detail?movementId=...` | Auxiliar de documentos enlazados por `FAX.BASEQ` a una partida histórica pendiente de esa cuenta |
| Conciliar / Filtra tránsito | Operación en pantalla sobre el mismo GET | Muestra sólo las partidas con `T = *` |
| Conciliar / Imprimir Póliza | `GET /api/accounting/policies/:id` | `EBANCO#4/1 → MPASIVOS/21`. Carga la póliza vinculada a la partida enfocada y abre su impresión |
| Conciliar / Registrar | `POST /api/treasury/bank-accounts/:id/actions/reconciliation` | SQL derivado. Registra un corte en `bank_reconciliations` y las partidas en `bank_reconciliation_movements` en la misma transacción |
| Conciliar / Cancelar | Cerrar la ventana | Descarta la selección |

El saldo ingresado del estado de cuenta debe coincidir al centavo con el saldo calculado. La fecha debe ser igual o posterior al último corte web y a los movimientos elegidos. El día actual de México es el límite superior. El servidor valida el saldo previo, la cuenta, la selección y el corte bajo bloqueo. Cada movimiento pertenece a un solo registro de conciliación. Un reintento con la misma clave y datos recupera el registro original.

Al registrar, los movimientos elegidos salen de **Conciliar** y **Concilia Automático**. **Auxiliar**, **Pagos** y **Depósitos** conservan los registros con marca `X` y la fecha del estado de cuenta. En Contabilidad se marca conciliada la partida bancaria de la póliza. El saldo contable, los importes de las pólizas y el saldo en tránsito se conservan.

### Tránsito

En German de pruebas, el 24/11/2026 se marcó el abono `BASEQ=728980` y el
cargo `BASEQ=729058` en la cuenta `1102100001`. **Tránsito** guardó
`FBANMOV.BAOKTRANSITO='*'` de inmediato y cambió `FBENC.BSALDOTR1` por
−14,400.00 y +600,000.00 respectivamente. Los saldos contable y bancario y
`BAOK` conservaron sus valores. **Filtra tránsito** dejó visible sólo el
abono marcado. Al intentar seleccionar el cargo marcado para conciliar,
German mostró «El documento esta en transito.». Se quitaron ambas marcas y
se comprobó la restauración del saldo en tránsito. Evidencia visual local
`closure-bank-transit-credit-marked-ready.png`,
`closure-bank-transit-filter-positive.png` y
`closure-bank-transit-charge-draft-ok.png`. La comparación de campos fue
por lectura de MySQL.

En la web, **Tránsito** guarda el estado deseado y ajusta el saldo en la
ficha y en **Conciliar**. Las partidas marcadas quedan disponibles para
consulta manual y salen de **Concilia Automático**. Al quitar la marca,
una partida elegible vuelve a estar disponible para el corte. La API rechaza un
corte con partidas marcadas y un cambio de marca sobre una partida ya
conciliada. Una reversión pendiente o una desaplicación retira en la
misma transacción la marca de la partida que deja de estar disponible.

La prueba en Chromium y Neon registró un traspaso temporal de 12.34 MXN.
Contrastó cargos y abonos web e históricos, el filtro, el saldo de la
cuenta y la partida de póliza conciliada. Dos solicitudes concurrentes de
marca y corte sobre el mismo cargo se serializaron. La marca ganó y el
corte devolvió conflicto sin modificar el saldo bancario. Al quitar la
marca, el corte se registró y un nuevo intento de marcar devolvió
conflicto. Se retiraron los registros temporales.

### Partidas históricas en un corte

**Registrar** usa la partida histórica por `BASEQ` cuando tiene póliza
activa y aplicada en México, tipo de cambio 1, importe distinto de cero
y `BAOK` vacío. Se combina con partidas web de la misma cuenta. Se
comprueba la fecha de las partidas, el último corte web y, si hay
partidas históricas seleccionadas, la última fecha `BAFECHARECIBO` de
partidas nativas con marca `X`. Los cortes de 2024 de GA32707 son
evidencia de esa asociación entre marca y fecha.

La escritura derivada se registra en `bank_reconciliation_movements` y
`bank_reconciliations`. **Conciliar** y **Concilia Automático** retiran
las partidas registradas. **Auxiliar** proyecta la marca y la fecha de
corte y **Pólizas** muestra la partida conciliada. Se modifica el saldo
bancario. El saldo contable y el de tránsito conservan sus importes al
registrar. Una marca nativa retirada en PostgreSQL conserva su ajuste
respecto al saldo de apertura cuando la partida entra en un corte.

La prueba desde **Conciliar** en Chromium y PostgreSQL seleccionó
`BASEQ 1895812` y `1895547`, un abono y un cargo. Confirmó que marcar
tránsito bloquea el corte y que quitar la marca rehabilita la partida.
El corte del 1 de marzo de 2025 sumó 52,190.02 MXN al saldo bancario.
El Auxiliar mostró la marca y la fecha, y Contabilidad mostró las
partidas conciliadas. La lectura antes y después confirmó los mismos
registros en German. Se retiraron los registros temporales.

### Acciones al pie de Conciliar

**Imprimir Póliza** toma el `POSEQ` de la partida enfocada. Chromium abrió
la impresión de una póliza histórica de la cuenta `1102100001` y mostró
folio, cuentas e importes. La prueba interceptó el diálogo de impresión.
German de pruebas mostró el envío de la póliza a `MPASIVOS/21` en
`closure-conciliar-print-policy-proc1.png`.

**FP** abre **Cierre de período** y carga la fecha de posfechado de la
póliza enfocada. En la descarga de procedimientos de German
`20261125-EBANCO6-PROCEDURES.txt`, `EBANCO#6/30` comprueba el acceso
`MBANCO61`, busca `FPOLIZA` por `POSEQ` y guarda `MEMFAL` en
`POPOSTFECHA`. La sesión de pruebas abrió el diálogo y se canceló.
`/240` lista las partidas de la empresa y período activos con
`BAOK<>'X'` y `BATIPOC<>0`. `/411` usa `POFECHA` para registrar
anteriores, y `/412` modifica el saldo bancario y la marca `BAOK`.

El botón web FP se habilita para partidas históricas de la lista en las
cuentas de México en pesos habilitadas para conciliar. Valida la relación
`BSEQ`/`BASEQ`/`POSEQ` y la revisión, adquiere el bloqueo de conciliación
de cada cuenta vinculada en orden de ID, y registra el cambio por
`POSEQ` junto con su comprobante de reintento. Conciliar, Auxiliar y
Pólizas muestran la nueva fecha. El efecto se limita a `POPOSTFECHA`.
Las fechas contables, importes, marcas y cortes conservan su valor. Los
asientos creados exclusivamente en PostgreSQL quedan fuera de este
flujo de partidas históricas. En Chromium, FP cambió la fecha de
posfechado de `112502-0126` (`POSEQ 487185`, `BASEQ 1895547`) del
24 al 26 de febrero de 2025. Se comprobó la proyección en Conciliar,
Auxiliar y Pólizas y se eliminó el PostgreSQL temporal al cerrar la
prueba. La prueba de almacenamiento cubre dos
solicitudes concurrentes, revisión vencida, reintento y reversión
completa si falla el registro de la solicitud.

**Imprimir Cheque** sigue pendiente. `EBANCO#6/26` llama a
`MBANCO/39 → /35`, que para TUVANSA usa el formato `BREPORTE`. Las
siete cuentas con formato en el histórico tienen movimientos de otras
empresas. Se requiere una partida elegible de México con formato para
verificar la vista previa.

La búsqueda adicional enlazó `FBENC.BSEQ`, `FBANMOV.POSEQ` y
`FPOLIZA.POCIA` en los respaldos accesibles. Los de 2018 y 2019 tienen la
misma partida mexicana `BASEQ=111504` con `QSANMLIL`. La póliza carece de
número de cheque y la partida tiene cargo y abono de cero. La cuenta
correspondiente no está en el respaldo actual. En 2020, 2021 y `pruebas2`
no hubo coincidencias de México. El respaldo actual tiene 9,353 partidas
de Monterrey en cinco cuentas con formato. Para usar una como referencia se
requiere confirmar que México tenga configurado el mismo formato y que la
partida represente un cheque imprimible.

El procedimiento `MBANCO/39` comprueba el permiso `MBANCO39` y pasa el
`BASEQ` enfocado a `/35`. La rama de TUVANSA carga la configuración de
página de `BREPORTE`. El cálculo del importe convertido usa
`rnd((BAIMPOR+BAIMPORNEG)/(BATIPOC+(BATIPOC=0)),2)`. Las bibliotecas
locales incluyen la definición `QSANMLIL`, cuyo rótulo la identifica como
**Santander Mexicali pesos leyenda**. Para validar **Imprimir Cheque** en
México falta una cuenta de prueba con su formato efectivo y una partida
con importe y número de cheque para comparar el PDF de German.

**Detalle** ejecuta `EBANCO#6/27` y abre **Auxiliar del documento**
(`EBANCO#15`). En `20261125-EBANCO15-PROCEDURES.txt`, `/240` carga
los renglones `FAX` que comparten el `BASEQ` de la partida enfocada.
Cierra la ventana si la búsqueda está vacía. El botón web se habilita
si existen esos renglones y consulta el auxiliar de la misma cuenta
en México. Muestra fecha, documento, tipo, referencia, importe con
signo y diferencia cambiaria. Abrir el auxiliar es una consulta.
En Chromium, la partida `BASEQ 1896293` de `1102100001` mostró
17 documentos en el orden de `ASEQ`. Los saldos y el corte siguieron
iguales. Las consultas por otra cuenta y por una partida sin vínculos
devolvieron el auxiliar como no disponible.
La cancelación anidada de `EBANCO#15/3` tiene otro control de acceso y
requiere validar un caso dentro del período activo antes de habilitar
la reversión desde el auxiliar web.
