# Catalogo de clientes

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
la pantalla heredada.

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

Bloquear expone exclusivamente el estado actual y el evento cuyo `EVKEY` es el
codigo del cliente seguido de `BLOQUE`. Los `UPDATE` sobre `fcli` y el
`INSERT`/`UPDATE` sobre `feventos` estan en la captura SQL, pero no se publica
todavia un endpoint de escritura.

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
