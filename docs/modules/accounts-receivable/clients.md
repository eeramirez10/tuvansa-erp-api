# Catalogo de clientes

Actualización 2026-09-14: [Verifica fiscal](client-fiscal-verification.md) incorpora lectura y edición fiscal con control de concurrencia. La verificación automática permanece pendiente del algoritmo de OMNIS; el clic normal responde 501 sin escribir.

Alcance inicial: reproducir la pantalla principal del Catalogo de clientes
sobre la base MySQL heredada, incluida su barra de navegacion y mantenimiento.

## Origen

- Clase principal Omnis: `ECLI#1`.
- Panel de consultas Omnis: `ECLI#8`.
- Tabla principal MySQL: `fcli`.
- Movimientos de clientes: `fax`.
- Documentos relacionados: `fdoc`.
- Catalogo de tipos de movimiento: `ftipmv`.
- Llave primaria: `CLISEQ`.
- Identificador unico usado por la API: `CLISEQ`.
- Cliente activo: `CLIBAJA = '1900-12-31'`.

## Secciones visibles

- Acciones: Clasificar, Enviar a, Bloquear, Descuentos, Eventos, Sucursales,
  Foto y Contactos.
- Catalogo: identificacion, domicilio, contacto y datos fiscales.
- Condiciones: lista, descuentos, plazo, credito, revision, pagos y cuenta.
- Acumulados: plazo real, fechas, saldos, credito disponible y ventas.
- Consultas: saldo, movimientos, facturas, pedidos y analiticos de productos y
  ventas.

## Endpoints implementados

```text
GET /api/accounts-receivable/clients
POST /api/accounts-receivable/clients
GET /api/accounts-receivable/clients/first
GET /api/accounts-receivable/clients/:clientId
PATCH /api/accounts-receivable/clients/:clientId
DELETE /api/accounts-receivable/clients/:clientId
GET /api/accounts-receivable/clients/:clientId/previous
GET /api/accounts-receivable/clients/:clientId/next
GET /api/accounts-receivable/clients/:clientId/balance
GET /api/accounts-receivable/clients/:clientId/movements
GET /api/accounts-receivable/clients/:clientId/invoices
GET /api/accounts-receivable/clients/:clientId/orders
GET /api/accounts-receivable/clients/:clientId/products/ordered
GET /api/accounts-receivable/clients/:clientId/products/quoted
GET /api/accounts-receivable/clients/:clientId/products/sold
GET /api/accounts-receivable/clients/:clientId/products/sold-detail
GET /api/accounts-receivable/clients/:clientId/sales/annual
GET /api/accounts-receivable/clients/:clientId/sales/annual-summary
GET /api/accounts-receivable/clients/:clientId/sales/by-branch
GET /api/accounts-receivable/clients/:clientId/sales/edi
GET /api/accounts-receivable/clients/:clientId/work-in-progress
GET /api/accounts-receivable/clients/:clientId/ct/products/ordered
GET /api/accounts-receivable/clients/:clientId/ct/products/sold
GET /api/accounts-receivable/clients/:clientId/ct/work-in-progress
GET /api/accounts-receivable/clients/:clientId/actions/classifications?position=1
GET /api/accounts-receivable/clients/:clientId/actions/destinations
GET /api/accounts-receivable/clients/:clientId/actions/block-status
GET /api/accounts-receivable/clients/:clientId/actions/discounts
GET /api/accounts-receivable/clients/:clientId/actions/events
GET /api/accounts-receivable/clients/:clientId/actions/branches
GET /api/accounts-receivable/clients/:clientId/actions/photo
GET /api/accounts-receivable/clients/:clientId/actions/contacts
```

La entrada inicial de la vista usa `/first` para obtener directamente el primer
cliente activo, sin ejecutar la búsqueda paginada ni su `COUNT(*)`.

Parametros del listado:

- `status`: `active`, `inactive` o `all`; por defecto `all`.
- `q`: busqueda por codigo, nombre o RFC.
- `page`: pagina; por defecto `1`.
- `pageSize`: registros por pagina; maximo `100`.

### Barra principal

- La esfera/lupa usa el listado con `q`; busca por codigo, razon social o RFC.
- Las flechas usan `previous` y `next`. En el primero o ultimo registro la
  respuesta es `{ "data": null }`.
- El alta requiere `code` y `name`. Acepta opcionalmente los grupos `address`,
  `contact`, `fiscal` y `terms`; si no se envia cuenta contable usa `1105001`,
  igual que la captura de OMNIS.
- El cambio usa `PATCH` y solo actualiza los campos presentes en el cuerpo.
- La baja responde `204` al eliminar. Responde `409 CLIENT_IN_USE` si encuentra
  relaciones en `fdoc`, `fax`, `faxinv`, `fpenc`, `fplin`, `fvanu2` o `fcenso`.
- Alta y cambio validan codigo duplicado y existencia de la cuenta en `fbenc`.

Los ejemplos completos de cuerpos JSON y el ciclo temporal de prueba estan en
`http/accounts-receivable/clients.http`.

El detalle agrupa la respuesta en `address`, `contact`, `fiscal`, `indicators`,
`terms` y `totals`, evitando filtrar nombres de columnas heredados fuera de
infraestructura.

### Campos visibles de la ficha central

Este mapeo se verifico visualmente en la vista **Catalogo de clientes** y contra
la consulta `OPEN_ACCOUNTS_RECEIVABLE`. Debe actualizarse si cambia el rotulo o
el contrato HTTP.

| Panel | Etiqueta OMNIS | Campo API | Columna MySQL |
| --- | --- | --- | --- |
| Catalogo de clientes | Cliente | `code` | `fcli.CLICOD` |
| Catalogo de clientes | Razon social | `name` | `fcli.CLINOM` |
| Catalogo de clientes | Direccion | `address.street` | `fcli.CLIDIR` |
| Catalogo de clientes | Num Ext. | `address.exteriorNumber` | `fcli.CLINUMEXT` |
| Catalogo de clientes | Num Int. | `address.interiorNumber` | `fcli.CLINUMINT` |
| Catalogo de clientes | Colonia | `address.neighborhood` | `fcli.CLICOLONIA` |
| Catalogo de clientes | Delegacion | `address.borough` | `fcli.CLIDELEGACION` |
| Catalogo de clientes | Ciudad | `address.city` | `fcli.CLICD` |
| Catalogo de clientes | Estado | `address.state` | `fcli.CLIEDO` |
| Catalogo de clientes | C.P. | `address.postalCode` | `fcli.CLICP` |
| Catalogo de clientes | Pais | `address.countryCode` | `fcli.CLIPAIS` |
| Catalogo de clientes | Telefonos | `contact.phones` | `fcli.CLITEL` |
| Catalogo de clientes | Fax | `contact.fax` | `fcli.CLIFAX` |
| Catalogo de clientes | Web | `contact.website` | `fcli.CLITEL4` |
| Catalogo de clientes | Contacto | `contact.name` | `fcli.CLICONT` |
| Catalogo de clientes | e-mail | `contact.email` | `fcli.CLITEL3` |
| Catalogo de clientes | R.F.C. | `fiscal.taxId` | `fcli.CLIRFC` |
| Catalogo de clientes | Sucursal | `fiscal.branch` | `fcli.CLISUCURSAL` |
| Catalogo de clientes | CURP | `fiscal.curp` | `fcli.CLICURP` |
| Condiciones | Lista | `terms.priceList` | `fcli.CLISTA` |
| Condiciones | Descuentos | `terms.discounts[0..2]` | `fcli.CLIDESC10`, `CLIDESC20`, `CLIDESC30` |
| Condiciones | Plazo | `terms.paymentTermDays` | `fcli.CLIPLAZO0` |
| Condiciones | Desde revision | `terms.reviewStartsFromInvoice` | `fcli.CLIPLAZOREV` |
| Condiciones | Credito | `terms.creditLimit` | `fcli.CLICREDIT` |
| Condiciones | Cad | `terms.creditExpiresAt` | `fcli.CLIVIGENCIACRED` |
| Condiciones | Revision, dia | `terms.reviewDay` | `fcli.CLIDIREV` |
| Condiciones | Revision, hora | `terms.reviewTime` | `fcli.CLIHORAREV` |
| Condiciones | Pagos, dia | `terms.paymentDay` | `fcli.CLIDIPAGO` |
| Condiciones | Pagos, hora | `terms.paymentTime` | `fcli.CLIHORAPAG` |
| Condiciones | Aplicar a | `terms.applyToClientCode` | `fcli.CLIAPLICAR` |
| Condiciones | Alta | `createdAt` | `fcli.CLIALTA` |
| Condiciones | Cta. cont. | `fiscal.accountingAccount` | `fcli.CLICTA` |
| Acumulados | Plazo real | `totals.actualPaymentTermDays` | `fcli.CLIPLAZOR` |
| Acumulados | Ultima compra | `totals.lastPurchaseAt` | `fcli.CLIULTCOM` |
| Acumulados | Ultimo pago | `totals.lastPaymentAt` | `fcli.CLIULTPAG` |
| Acumulados | Ultimo pedido | `totals.lastOrderAt` | `fcli.CLIULTPED` |
| Acumulados | Baja | `deactivatedAt` | `fcli.CLIBAJA` |
| Acumulados | Saldo anterior | `totals.previousBalance` | `fcli.CLISANT` |
| Acumulados | Saldo actual | `totals.currentBalance` | `fcli.CLISACT` |
| Acumulados | C. Disponible | `totals.availableCredit` | `CLICREDIT - CLISACT` |
| Acumulados | Acumulado | `totals.accumulatedSales` | `fcli.CLIACUMULADO` |
| Acciones | Indicador `Eventos *` | `indicators.hasEvents` | `fcli.CLIEVENTOS = '*'` |

Las columnas adicionales que OMNIS carga en memoria pero no muestra en esta
ficha no se publican como campos ambiguos. Se agregaran cuando aparezcan en una
vista concreta y pueda documentarse su significado.

### Saldo

Parametros opcionales:

- `dueStatus`: `all`, `overdue` o `notDue`; por defecto `all`.
- `q`: busca por documento, referencia, pedido del cliente o talon.
- `page`: pagina; por defecto `1`.
- `pageSize`: registros por pagina; maximo `100`.

La respuesta reproduce la tabla principal del boton Saldo. Conserva los filtros
capturados de OMNIS: `fdoc.DEST = 0`, `fdoc.DMULTICIA = 1` y
`fdoc.DESCXC = 1`. Incluye importes en moneda nacional y moneda del documento,
fecha de vencimiento, dias vencidos, referencias, fecha programada, sucursal,
talon y pedido del cliente. El resumen separa saldo total, vencido y por vencer.

### Movimientos

Parametros opcionales:

- `dateFrom`: fecha inicial inclusiva en formato `YYYY-MM-DD`.
- `dateTo`: fecha final inclusiva en formato `YYYY-MM-DD`.
- `page`: pagina; por defecto `1`.
- `pageSize`: registros por pagina; maximo `100`.

La respuesta incluye los datos basicos del cliente, saldo inicial, cargos,
abonos, movimiento neto, saldo final y cantidad de movimientos del periodo.
Cada movimiento contiene su importe firmado, cargo o abono, saldo acumulado,
tipo de movimiento y el documento de `fdoc` cuando existe. Conserva los filtros
capturados de OMNIS: `fax.AMES = 1`, documento no eliminado y
`fdoc.DMULTICIA = 1`. Los movimientos se ordenan por `fax.ASEQ`, igual que en
la pantalla heredada. El saldo acumulado suma por fecha y `fax.ASEQ` todo el
historial aplicable hasta cada movimiento, incluso si queda fuera de la página
o del periodo. La consulta derivada se verificó en MySQL 5.1.45.

Las remisiones FA web de la empresa 1 se agregan a Saldo y Movimientos desde `tuvansa.sales_remissions`. El cargo aumenta el saldo actual y se incluye en los importes vencidos y por vencer según su fecha de vencimiento. Los movimientos muestran el pedido como referencia y contribuyen al saldo inicial, acumulado y final según su fecha. La ficha del cliente recalcula el crédito disponible y muestra la fecha de la última compra entre ambas fuentes. El cargo y la fecha de compra corresponden a `MFACT/33` y `CLIULTCOM`, respectivamente.

Cada cobro PA registrado en `tuvansa.customer_collections` reduce el pendiente y libera crédito. Las remisiones liquidadas salen de **Saldo**. **Movimientos** conserva el cargo original y cada abono, con su recibo, póliza y referencia bancaria. El saldo de apertura, el acumulado de cada movimiento y el saldo de cierre incluyen los abonos según su fecha. La ficha del cliente muestra la última fecha de pago de ambas fuentes.

La cancelación de una remisión histórica descuenta su cargo del saldo actual y retira de **Saldo** el documento por `fdoc.DSEQ`. **Movimientos** conserva el cargo de `fax` y agrega un abono tipo `K` fechado el día de la cancelación. El abono se incluye en los saldos inicial, acumulado y final según las fechas consultadas. La generación de una nueva remisión toma en cuenta el crédito liberado al validar el saldo del cliente.

| Vista / acción | Endpoint | Evidencia y tablas |
| --- | --- | --- |
| Clientes / Saldo | `GET /api/accounts-receivable/clients/:clientId/balance` | Consulta derivada. El registro de `tuvansa.sales_remission_cancellations` excluye el `fdoc.DSEQ` cancelado de la página, el total filtrado y el resumen. |
| Clientes / Movimientos | `GET /api/accounts-receivable/clients/:clientId/movements` | Consulta derivada. `fax` aporta el cargo y `tuvansa.sales_remission_cancellations` aporta el abono. `MFACT/28` y `MFACT/108` son las referencias del flujo de cancelación en el código exportado de Omnis. |

### Cobrar una remisión web

**Clientes → Saldo → Cobrar** registra un depósito parcial o total para una remisión web `FAW` activa en pesos de México. La ventana pide cuenta bancaria, importe, fecha, referencia bancaria y concepto. La fecha debe ser igual o posterior a la remisión y pertenecer al período fiscal de la compañía.

| Vista y botón | Endpoint | Procedencia y tablas |
| --- | --- | --- |
| Saldo / Cobrar | `GET /api/accounts-receivable/clients/:clientId/collections/:remissionId` | SQL derivado. Saldo y revisión de `sales_remissions` y `customer_collections`. Cuentas y tipo PA de `FCIA`, `FCLI`, `FTIPMV` y `FBENC` |
| Cobrar / OK | `POST /api/accounts-receivable/clients/:clientId/collections/:remissionId` | SQL derivado. Inserta en `customer_collections` y devuelve folio `PAW`, recibo, saldo restante y póliza `1CW` |
| Cobrar / Cancelar | Cerrar | Descarta la captura |

La revisión impide aplicar un cobro sobre un saldo que cambió. Reusar la misma clave de solicitud con los mismos datos devuelve el cobro original. El abono en Clientes, el aumento en Bancos y la póliza aplicada se proyectan de una sola fila guardada en PostgreSQL. La cuenta del depósito proviene de `FBENC` y admite movimientos y depósitos en pesos. Contabilidad carga al banco y abona a `CLICTA` o a `CIACTACXC` cuando el cliente utiliza la cuenta predeterminada.

Omnis mostró la lista de **Saldo** y la ventana **Captura de movimientos** en **Clientes → Movimientos CxC**. En el historial de México, dos abonos PA en `FAX` liquidaron `FE0064651`. El segundo se liga por `APOLIZA` a `112611-0026` de familia **COBRANZA**, con cargo PC al banco y abono a la cuenta de clientes en `FBANMOV`. La muestra incluye complemento fiscal. El botón web **Cobrar** aplica esa secuencia contable a FAW, el alcance local convenido para esta fase. En las remisiones FA sin timbrar consultadas, el historial mostraba el cargo de venta. El complemento fiscal queda para la integración posterior.

### Revertir un cobro PA web

`GET /api/accounts-receivable/clients/:clientId/collections/:collectionId/reversal` consulta el cobro, su remisión, la póliza, el periodo activo y el corte original si existe. El `POST` requiere fecha, motivo, confirmación y una clave de solicitud. Para un PA conciliado, `expectedReconciliationId` confirma el corte presentado en la consulta. La fecha de la corrección debe pertenecer al periodo activo y respetar la fecha mínima calculada a partir del cobro, los cortes aplicables y la última reversión PA de la remisión.

PostgreSQL conserva el cobro y registra la reversión en `tuvansa.customer_collection_reversals`. **Movimientos** y **Auxiliar** conservan el PA original y muestran el cargo compensatorio. **Saldo** vuelve a incluir el importe pendiente. En **Bancos**, la póliza carga la cuenta del cliente y abona la misma cuenta bancaria que recibió el depósito. El Mayor registra ambos movimientos según sus fechas. Si el cobro estaba pendiente, el par sale de las partidas candidatas a conciliación. Si el cobro estaba conciliado, su corte queda registrado y el egreso compensatorio entra a **Conciliar** como movimiento independiente. El saldo bancario conciliado incorpora el egreso al registrar su propio corte. Una nueva cobranza o una cancelación FAW puede registrarse a partir de la fecha de la última reversión PA de la remisión.

La fuente nativa verificada es una consulta de solo lectura en México. El 17 de enero de 2025, las pólizas aplicadas `112501-0075` y `112501-0102` de familia **COBRANZA** registraron, respectivamente, el cargo y el abono de 1,500,000 MXN en el banco `1102100001` (`BTIPO=0`). En `FAX`, 43 partidas PA pasan de −1,475,061.70 a +1,475,061.71 y las partidas de reversión referencian `REV 112501-0075`. Las pólizas contienen también una diferencia cambiaria. El par `112502-0098` y `112502-0101` muestra la misma referencia y los signos opuestos en CxC, con cuentas de compensación. El registro web es una adaptación de esas contrapartidas al PA individual en pesos y refleja exactamente el importe del depósito original.

En el banco `1102100004`, la póliza aplicada `112408-0179` conserva `BAOK='X'` y el cargo de 130,588.42 del 1 de agosto de 2024. La póliza aplicada `112412-0147` registra −130,588.42 con `BAOK=''` el 1 de diciembre. El PA de reversión de `FE0060707` referencia `REV 112408-0179`. El par `112404-0054` y `112404-0063` conserva dos marcas `X` y signos opuestos. El historial consultado contiene las marcas y fechas de las pólizas. La fecha de cada corte en la web proviene de su registro de conciliación en PostgreSQL.

La captura literal completa por boton y accion esta documentada en
`legacy-mysql-capture.md`; el archivo crudo permanece local dentro de
`captures/` porque puede contener datos de prueba.

La navegacion y las escrituras de la barra principal (anterior, buscar,
siguiente, alta, baja y cambio) estan documentadas por separado en
`client-toolbar-sql.md`. El ciclo de alta, cambio y baja se verifico con un
cliente temporal eliminado al terminar la captura y esta implementado en la
API.

### Correspondencia entre vistas, botones y endpoints

La vista base es **Cuentas por cobrar > Catalogo de clientes** (`ECLI#1`). El
panel lateral de botones de consulta corresponde a `ECLI#8`. Esta tabla debe
actualizarse cada vez que se agregue un endpoint del modulo.

| Vista o panel | Boton OMNIS | Endpoint GET | Captura SQL | Tablas principales |
| --- | --- | --- | --- | --- |
| Catalogo de clientes | Lista principal | `/api/accounts-receivable/clients` | `OPEN_ACCOUNTS_RECEIVABLE` | `fcli` |
| Catalogo de clientes | Ficha del cliente | `/api/accounts-receivable/clients/:clientId` | `OPEN_ACCOUNTS_RECEIVABLE` | `fcli` |
| Barra principal | Flecha izquierda - Anterior | `GET /api/accounts-receivable/clients/:clientId/previous` | `TOOLBAR_PREVIOUS_CLIENT` | `fcli` |
| Barra principal | Esfera/lupa - Buscar | `GET /api/accounts-receivable/clients?q=...` | `TOOLBAR_SEARCH_CLIENT_000001` | `fcli` |
| Barra principal | Flecha derecha - Siguiente | `GET /api/accounts-receivable/clients/:clientId/next` | `TOOLBAR_NEXT_CLIENT` | `fcli` |
| Barra principal | Papel - Alta | `POST /api/accounts-receivable/clients` | `TOOLBAR_NEW_CLIENT_INSERT_ZZT826` | `fcli`, `fbenc` |
| Barra principal | Papel con marca - Baja | `DELETE /api/accounts-receivable/clients/:clientId` | `TOOLBAR_DELETE_CLIENT_CONFIRM_ZZT826` | `fcli` y tablas relacionadas |
| Barra principal | Papel con lapiz - Cambio | `PATCH /api/accounts-receivable/clients/:clientId` | `TOOLBAR_EDIT_CLIENT_UPDATE_ZZT826` | `fcli`, `fbenc` |
| Consultas | Saldo | `/api/accounts-receivable/clients/:clientId/balance` | `CLIENT_000001_SALDO` | `fdoc`, `fcli` |
| Consultas | Movimientos | `/api/accounts-receivable/clients/:clientId/movements` | `CLIENT_000001_MOVIMIENTOS` | `fax`, `fdoc`, `fcli` |
| Consultas | Facturas | `/api/accounts-receivable/clients/:clientId/invoices` | `CLIENT_000001_FACTURAS` | `fdoc`, `fcli` |
| Consultas | Pedidos - Relacion | `/api/accounts-receivable/clients/:clientId/orders` | `CLIENT_000001_PEDIDOS_RELACION` | `fpenc`, `fcli` |
| Consultas | Productos pedidos | `/api/accounts-receivable/clients/:clientId/products/ordered` | `CLIENT_000001_PRODUCTOS_PEDIDOS` | `fplin`, `fpenc`, `finv` |
| Consultas | Productos cotizados | `/api/accounts-receivable/clients/:clientId/products/quoted` | `CLIENT_000001_PRODUCTOS_COTIZADOS` | `fplin`, `fpenc`, `finv` |
| Consultas | Productos vendidos | `/api/accounts-receivable/clients/:clientId/products/sold` | `CLIENT_000001_PRODUCTOS_VENDIDOS` | `faxinv`, `fdoc`, `finv` |
| Consultas | Productos vendidos - Desglose | `/api/accounts-receivable/clients/:clientId/products/sold-detail` | `CLIENT_000001_PRODUCTOS_VENDIDOS_DESGLOSE` | `faxinv`, `fdoc`, `finv` |
| Consultas | Ventas anuales | `/api/accounts-receivable/clients/:clientId/sales/annual` | `CLIENT_000001_VENTAS_ANUALES` | `faxinv`, `fdoc`, `finv` |
| Consultas | Ventas anuales - Resumen | `/api/accounts-receivable/clients/:clientId/sales/annual-summary` | `CLIENT_000001_VENTAS_ANUALES_RESUMEN_RETRY` | `fdoc`, `fcli` |
| Consultas | Ventas por sucursal | `/api/accounts-receivable/clients/:clientId/sales/by-branch` | `CLIENT_000001_VENTAS_POR_SUCURSAL_RETRY` | `faxinv`, `fdoc`, `finv` |
| Consultas | Ventas EDI | `/api/accounts-receivable/clients/:clientId/sales/edi` | `CLIENT_000001_VENTAS_EDI` | `fvsucursal`, `fedi`, `finv` |
| Consultas | WIP | `/api/accounts-receivable/clients/:clientId/work-in-progress` | `CLIENT_000001_CT_WIP` | `ftikets` |
| Consultas | Analisis de clientes | `/api/accounts-receivable/clients/reports/analytics` | Consulta analitica derivada (no existe como boton en OMNIS) | `fcli`, `fdoc`, `fpenc` |
| Consultas CT | Productos pedidos | `/api/accounts-receivable/clients/:clientId/ct/products/ordered` | `CLIENT_000001_CT_PRODUCTOS_PEDIDOS` | `fplin`, `fpenc`, `finv` |
| Consultas CT | Productos vendidos | `/api/accounts-receivable/clients/:clientId/ct/products/sold` | `CLIENT_000001_CT_PRODUCTOS_VENDIDOS` | `faxinv`, `fdoc`, `finv` |
| Consultas CT | WIP | `/api/accounts-receivable/clients/:clientId/ct/work-in-progress` | `CLIENT_000001_CT_WIP` | `ftikets` |
| Acciones | Clasificar | `/api/accounts-receivable/clients/:clientId/actions/classifications?position=1..9` | `CLIENT_000001_ACTION_CLASIFICAR_RETRY` y recaptura `client-classifications-sql.md` | `fcli`, `fag` |
| Acciones | Enviar a | `/api/accounts-receivable/clients/:clientId/actions/destinations` | `CLIENT_000001_ACTION_ENVIAR_A` | Sin origen funcional capturado |
| Acciones | Bloquear | `/api/accounts-receivable/clients/:clientId/actions/block-status` | `CLIENT_000001_ACTION_BLOQUEAR_OPEN`, `CLIENT_000001_ACTION_BLOQUEAR_CONFIRM` | `fcli`, `feventos` |
| Acciones | Descuentos | `/api/accounts-receivable/clients/:clientId/actions/discounts` | `CLIENT_000001_ACTION_DESCUENTOS` | `fdesctos` |
| Acciones | Eventos | `/api/accounts-receivable/clients/:clientId/actions/events` | `CLIENT_000001_ACTION_EVENTOS` | `feventos`, `fcli` |
| Acciones | Sucursales | `/api/accounts-receivable/clients/:clientId/actions/branches` | `CLIENT_000001_ACTION_SUCURSALES` | `fsucursales`, `fcli` |
| Acciones | Foto | `/api/accounts-receivable/clients/:clientId/actions/photo` | `CLIENT_000001_ACTION_FOTO` | Sin origen funcional capturado |
| Acciones | Contactos | `/api/accounts-receivable/clients/:clientId/actions/contacts` | `CLIENT_000001_ACTION_CONTACTOS` | `fcontactos` |

Los endpoints de tablas aceptan `page` y `pageSize`; `pageSize` tiene un maximo
de 100 registros. Las consultas adicionales conservan una forma comun con
`data.client`, `data.items` y `pagination`.

### Reporte analitico de clientes

`GET /api/accounts-receivable/clients/reports/analytics` es una consulta nueva
para la migracion; no pretende reproducir SQL emitido por un boton de OMNIS.
El alcance se fija en el servidor a la sucursal **01 - Mexico**, cuyo valor real
en `fcli.CLISUCURSAL` es `MEXICO`. No se acepta una sucursal por parametro para
evitar mezclar datos de otras plazas.

Parametros opcionales: `q` (codigo o nombre), `status` (`active`, `inactive` o
`all`), `risk` (`healthy`, `watch`, `overdue`, `critical` o `all`), `page` y
`pageSize`. El resumen incluye cartera, credito, documentos vencidos, pedidos
abiertos y cinco bandas de antiguedad. El detalle calcula credito disponible,
porcentaje utilizado y nivel de riesgo por cliente.

La cartera conserva los filtros contables usados por Saldo:
`fdoc.DEST = 0`, `fdoc.DMULTICIA = 1` y `fdoc.DESCXC = 1`. Un pedido se considera
abierto cuando pertenece a multicompania 1, su numero inicia con `P`,
`fpenc.PESTATUS` esta vacio y no tiene fecha de cancelacion. En los datos reales
capturados, `PESTATUS = SURT` identifica pedidos surtidos.

OMNIS hizo consultas adicionales `SELECT * FROM finv` al construir Ventas
anuales. La API evita ese patron N+1 y obtiene la descripcion mediante el mismo
`JOIN finv` de la consulta principal.

El boton WIP normal no emitio una consulta funcional durante la captura. Su
endpoint usa la consulta confirmada del boton CT WIP, que filtra `ftikets` por
el codigo del cliente. No se inventaron filtros adicionales.

### Acciones en modo lectura

Clasificar devuelve los nueve valores `CLIPAR` con los nombres configurados en
OMNIS. `position` acepta valores de 1 a 9 y carga las opciones de la familia
seleccionada con el filtro real `fag.AGT = position` y `AGTIPO IN (0, 1)`.
La captura de cambio entre las nueve familias esta documentada en
`client-classifications-sql.md`.

Enviar a y Foto devuelven `available: false` y la razon. En ambos casos OMNIS
solo consulto configuracion de ventana y no se encontro un origen funcional en
MySQL o en archivos locales.

Bloquear consulta el estado y el evento cuyo `EVKEY` usa los seis espacios
del código del cliente seguidos de `BLOQUE`. `PATCH /:clientId/actions/block-status`
recibe `blocked`, `confirmed: true` y `reason`. Las acciones **Bloquear** y
**Desbloquear** guardan el estado y agregan una entrada al evento `BLOQUEO`
en la misma transacción. La ficha y Eventos reflejan el resultado.
Pedidos y Remisión México consultan el estado antes de generar nuevos cargos.
Los documentos previos conservan sus operaciones de cobro.

Los endpoints Descuentos, Eventos, Sucursales y Contactos aceptan `page` y
`pageSize`. Contactos excluye deliberadamente `CONTPASSWORD` de la respuesta.

## Arquitectura de acceso a datos

Los contratos de acceso a datos estan en `domain/datasources` y los contratos
consumidos por los casos de uso en `domain/repositories`. Las consultas MySQL
estan solamente en `infrastructure/datasources`; cada clase de
`infrastructure/repositories` se limita a delegar en su datasource. Asi se puede
agregar posteriormente una implementacion PostgreSQL sin modificar aplicacion
ni presentacion.

## Pendiente

- Confirmar campos personalizados de la instalacion de Tuvansa.
- Identificar el origen funcional de Enviar a y Foto en una captura posterior.
