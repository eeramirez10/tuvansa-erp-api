# Ventas - Pedidos

## Origen y alcance

- Acceso OMNIS: `F3` o botón **PEDIDOS**.
- Pedido usado para contrastar la pantalla: `P010773` (`PESEQ=72391`).
- Encabezado: `FPENC`; partidas: `FPLIN`; cliente: `FCLI`; productos: `FINV`.
- Comentarios: `FCOMENT.COMSEQFACT = 10000000 + FPENC.PESEQ`.
- Facturas relacionadas: `FDOC.DREFER = FPENC.PENUM`.
- Prefijo API: `/api/sales/orders`.

El módulo conserva la separación de Clean Architecture: los contratos viven en
`domain/datasources` y `domain/repositories`; el SQL legacy está solamente en
`infrastructure/datasources`; los repositories de infraestructura delegan al
datasource. Esto permite sustituir MySQL por PostgreSQL sin cambiar los casos de
uso ni la presentación HTTP.

## Pantalla y barra compartida

| Control OMNIS / vista | Endpoint | Uso en frontend |
| --- | --- | --- |
| Abrir Pedidos vacío | `GET /api/sales/orders?q=P010773` | Localiza el pedido inicial o presenta la ficha vacía |
| Ficha de pedido | `GET /api/sales/orders/:orderId` | Encabezado, cliente, partidas, Totales e Importes |
| Flecha izquierda | `GET /api/sales/orders/:orderId/previous` | Pedido anterior |
| Buscar | `GET /api/sales/orders?q=...` | Ventana Búsqueda por pedido, pedido cliente, cliente o nombre |
| Flecha derecha | `GET /api/sales/orders/:orderId/next` | Pedido siguiente |
| Hoja / Nuevo | `POST /api/sales/orders` | Alta de encabezado, partidas y acumulados |
| Borrar | `DELETE /api/sales/orders/:orderId` | Baja protegida si existe factura o surtido |
| Hoja y lápiz / Editar | `PATCH /api/sales/orders/:orderId` | Cambia encabezado, clasificaciones o partidas |

La búsqueda admite `q`, `status`, `customerCode`, `from`, `to`, `page` y
`pageSize`. `q` compara número de pedido, pedido del cliente, código y nombre del
cliente.

## Mapeo de la ficha

| Zona OMNIS | Etiqueta | Campo API | Columna legacy |
| --- | --- | --- | --- |
| Pedido | Pedido | `number` | `FPENC.PENUM` |
| Pedido | Pedido cliente | `customerOrderNumber` | `FPENC.PENUMELLOS` |
| Pedido | Cliente / Nombre | `customer` | `FPENC.CLISEQ`, `FCLI.CLICOD`, `FCLI.CLINOM` |
| Pedido | Status / Surtido | `status`, `fulfilledAmount` | `PESTATUS`, `PESURT` |
| Pedido | Sucursal / Depto | `branch`, `department` | `PESUCURSAL`, `PEDEPTO` |
| Pedido | Fecha / Desde / Vence | `dates` | `PEFECHA`, `PEDESDE`, `PEVENCE` |
| Pedido | At. / Plazo / O.K. | `attention`, `termsDays`, `authorization` | `PEPAR1`, `PEPLAZO`, `PEUSRAUT` |
| Pedido | Inicial / Almacén | `initial`, `warehouse` | `PEINICIAL`, `PEALMACEN` |
| Partidas | Producto / Descripción | `lines[].productCode`, `description` | `FINV.ICOD`, `FINV.IDESCR` |
| Partidas | Pedido / Surtido / Resta | `ordered`, `fulfilled`, `remaining` | `PLCANT`, `PLSURT`, cálculo |
| Partidas | U.M. / Asignado / Suc | `unit`, `assigned`, `branch` | `PLUNIDAD`, `PLASIGNADO`, `PLSUC` |
| Partidas | Precio / Cls / Moneda | `price`, `classCode`, `currencyId` | `PLPRECI`, `PLCLASE`, `PLMONEDA` |
| Totales | Cant., Pedido, Surtido, Resta | `totals.quantity/ordered/fulfilled/remaining` | `PEPZAS` y partidas |
| Importes | Importe, Descuento, Flete, Seguros, Otros, IVA, Total | `totals.*` | `PEBRUTO`, `PEDESC`, `PEFLETE`, `PESEGURO`, `PEOTRO`, `PEIVA`, `PECANT` |

## Acciones

| Botón visible | Endpoint GET | Contenido de la ventana |
| --- | --- | --- |
| Asignar todo | `/:orderId/actions/assign-all` | Partidas y cantidad asignable |
| Autorizar | `/:orderId/actions/authorize` | Estado y usuarios de autorización |
| Auxiliar | `/:orderId/actions/auxiliar` | **Facturas de pedido**; documento y fecha |
| Cajas | `/:orderId/actions/boxes` | Configuración de empaque por pedido |
| Clasificar | `/:orderId/actions/classifications` | Valores actuales y catálogos AGT 1 a 7 |
| Comentarios | `/:orderId/actions/comments` | Comentarios, letra, cajas y bitácora |
| Cotiz | `/:orderId/actions/quote-conversion` | Confirmación de conversión pedido/cotización |
| Duplicar | `/:orderId/actions/duplicate` | Pedido origen, porcentaje y sucursales |
| Etiquetas | `/:orderId/actions/labels` | Partidas, etiquetas, color y talla |
| Imprimir | `/:orderId/actions/print` | Rango, copias, formato y destino |
| Monarch | `/:orderId/actions/monarch` | Partidas asignadas para exportación |
| Piezas | `/:orderId/actions/pieces` | Cajas/piezas, almacén, recepción y factura |
| Traspaso | `/:orderId/actions/transfer` | Confirmación de traspaso |

## Acciones secundarias

| Botón visible | Endpoint GET | Contenido de la ventana |
| --- | --- | --- |
| Asignar CT | `/:orderId/secondary-actions/assign-ct` | Proveedores disponibles |
| Consolidar | `/:orderId/secondary-actions/consolidate` | Partidas y referencia CT |
| CT | `/:orderId/secondary-actions/ct` | Partidas relacionadas con CT |
| Divide ct | `/:orderId/secondary-actions/split-ct` | Cantidad pedida y pendiente |
| EXP | `/:orderId/secondary-actions/export` | Fechas de exportación/empaque, status y observaciones |
| Genera O.C. | `/:orderId/secondary-actions/purchase-order` | Proveedores para generar orden de compra |
| Split | `/:orderId/secondary-actions/split` | Partidas, surtido y remanente |
| Sucursal | `/:orderId/secondary-actions/branch` | Sucursales del cliente |
| WIP | `/:orderId/secondary-actions/wip` | Partidas, existencia y asignación |

Cada respuesta de panel incluye `button`, `section`, `source`, `items` y, cuando
aplica, `summary`. El frontend usa esas propiedades en el diálogo ERP compartido
y conserva scroll horizontal y vertical para tablas mayores que la ventana.

## Escrituras preparadas

`POST`, `PATCH` y `DELETE` están conectados, pero dependen de que la conexión
configurada tenga permisos de escritura. El alta crea `FPENC`, `FPLIN` y
`FCOMENT`, incrementa `FINV.IPEDCLI`, actualiza `FCLI.CLIULTPED` y recalcula
importes. La sustitución de partidas revierte primero el compromiso anterior. La
baja rechaza pedidos facturados o surtidos, revierte `IPEDCLI`, elimina
comentarios/partidas/encabezado y recalcula la última fecha de pedido del cliente.

Los requests reproducibles están en `http/sales/orders.http`. La evidencia SQL
y la prueba controlada de alta/edición/baja están en `orders-capture.md`.
