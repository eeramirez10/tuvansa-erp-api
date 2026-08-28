# Ventas - Facturación

## Origen y alcance

- Acceso OMNIS: botón superior **FACTURA**.
- Documento contrastado: `0007069` (`FDOC.DSEQ=244045`), relacionado con el pedido `P015471`.
- Encabezado: `FDOC`; partidas: `FAXINV`; cliente: `FCLI`; producto: `FINV`.
- Movimientos del auxiliar: `FAX`; comentarios: `FCOMENT`; piezas/cajas: `FCAJAS`.
- Prefijo API: `/api/sales/invoices`.
- Alcance actual: exclusivamente `GET`. No se sella, imprime, convierte, traspasa ni liquida desde la API.

El módulo aplica la misma Clean Architecture del resto del backend. Los contratos
están en `domain/datasources` y `domain/repositories`; todo el SQL legacy está en
`infrastructure/datasources`; los repositories de infraestructura sólo delegan.

## Pantalla y barra compartida

| Control OMNIS / vista | Endpoint | Uso en frontend |
| --- | --- | --- |
| Apertura vacía + primer avance | `GET /api/sales/invoices/first` | Primer documento elegible sin ejecutar búsqueda paginada |
| Ficha Facturación | `GET /api/sales/invoices/:invoiceId` | Encabezado, cliente, partidas y Totales |
| Carga directa | `GET /api/sales/invoices/by-number/:invoiceNumber` | Abre un documento conocido |
| Flecha izquierda | `GET /api/sales/invoices/:invoiceId/previous` | Documento anterior por `DNUM` |
| Buscar | `GET /api/sales/invoices?...` | Ventana Búsqueda de Facturación |
| Flecha derecha | `GET /api/sales/invoices/:invoiceId/next` | Documento siguiente por `DNUM` |

El buscador reproduce los campos visibles de OMNIS: `issuedAt` (Fecha),
`invoiceNumber` (Documento), `orderNumber` (Pedido), `customerOrderNumber`
(Ped. Cliente), `deliveryNote` (Talón), `folio`, `customerCode`,
`warehouseSeal` (Sello Alm.) y `amount` (Importe). `q` busca conjuntamente por
documento, pedido, pedido del cliente, código y nombre del cliente.

## Mapeo de la ficha

| Zona OMNIS | Etiqueta | Campo API | Columna legacy |
| --- | --- | --- | --- |
| Factura | Docto | `number` | `FDOC.DNUM` |
| Factura | Pedido | `orderNumber` | `FDOC.DREFER` |
| Factura | Pedido cliente | `customerOrderNumber` | `FDOC.DREFERELLOS` |
| Factura | Cliente / Nombre | `customer` | `FDOC.CLISEQ`, `FCLI.CLICOD`, `FCLI.CLINOM` |
| Factura | Fecha / Vence / Retraso | `dates.issuedAt`, `dates.dueAt`, `delayDays` | `DFECHA`, `DVENCE`, `DATEDIFF` |
| Factura | Agt | `attention`, `attentionCode` | `DPAR1`, `FAG.AGDESCR` |
| Factura | Sucursal / Depto. / Ruta | `branch`, `department`, `route` | `DSUCURSAL`, `DDEPTO`, `DRUTA` |
| Factura | Pzs / Alm / Inicial | `pieces`, `warehouse`, `initial` | `DPZAS`, `DALMACEN`, `DINICIAL` |
| Factura | CFD / Fecha de pago | `cfdStatus`, `dates.paidAt` | `DSTATUSCFD`, `DFECHAPAGO` |
| Factura | Moneda / tipo de cambio | `currency` | `DMONEDA`, `DTIPOC` |
| Partidas | Producto / Descripción | `lines[].productCode`, `description` | `FINV.ICOD`, `FINV.IDESCR` |
| Partidas | Cantidad / U.M. / Precio | `quantity`, `unit`, `price` | `AICANT`, `AIUNIDAD`, `AIPRECIO` |
| Partidas | Dto / Importe / Suc / Agt / Pzas / Pag. | campos de `lines[]` | `AIDESCTO`, cálculo, `AISUCURSAL`, `AIAGENTE`, `AIPZAS`, `AIPAGINA` |
| Totales | Subtotal a Saldo | `totals.*` | `DBRUTO`, `DDESC`, `DFLETE`, `DSEGURO`, `DOTROS`, `DIEPES`, `DIVA`, `DCANT`, `DPAGO1..11` |

## Acciones y Sumarios

| Sección | Botón visible | Endpoint GET | Contenido devuelto |
| --- | --- | --- | --- |
| Acciones | Auxiliar | `/:invoiceId/actions/auxiliary` | Fecha, T.M., referencia, cargos, abonos y totales de `FAX` |
| Acciones | Cajas | `/:invoiceId/actions/boxes` | Cajas/empaques asociados por `FCAJAS.CAJFACTURA` |
| Acciones | Clasifica | `/:invoiceId/actions/classifications` | `DPAR0..DPAR9` y opciones `FAG` |
| Acciones | Comentarios | `/:invoiceId/actions/comments` | `FCOMENT` y contexto de pago, ruta, talón, folio y cliente |
| Acciones | CT | `/:invoiceId/actions/ct` | Partidas con pedido/surtido y totales |
| Acciones | Imprimir | `/:invoiceId/actions/print` | Opciones del diálogo; no envía impresión |
| Acciones | Lotes | `/:invoiceId/actions/lots` | Producto, lote, fecha, cantidad, aduana y pedimento |
| Acciones | Piezas | `/:invoiceId/actions/pieces` | Código, número, piezas, cantidad, almacén, pedido, referencia, alta y recepción |
| Acciones | Sellar | `/:invoiceId/actions/seal` | Estado CFD/folio; no ejecuta sellado |
| Sumarios | Tiket > Factura | `/:invoiceId/summaries/ticket-to-invoice` | Contexto, operación deshabilitada |
| Sumarios | Traspaso | `/:invoiceId/summaries/transfer` | Partidas a transferir; no modifica inventario |
| Sumarios | Edita pzas | `/:invoiceId/summaries/edit-pieces` | Piezas/cajas actuales; no edita |
| Sumarios | Liquidación camión | `/:invoiceId/summaries/truck-settlement` | Ruta, fecha, cliente e importe; no liquida |

Cada panel regresa `button`, `section`, `source`, `available`, `readOnly`,
`items` y, cuando corresponde, `summary` y `reason`. Esto permite reutilizar el
diálogo ERP compartido del frontend y distinguir claramente las operaciones que
permanecen deshabilitadas durante la migración de lectura.

Los requests reproducibles están en `http/sales/invoices.http`. La evidencia de
captura se documenta en `invoices-capture.md`; el registro crudo y las capturas de
pantalla permanecen en `captures/`, excluido de Git.
