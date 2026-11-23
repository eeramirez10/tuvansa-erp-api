# Ventas - Facturación

## Origen y alcance

- Acceso OMNIS: botón superior **FACTURA**.
- Documento contrastado: `0007069` (`FDOC.DSEQ=244045`), relacionado con el pedido `P015471`.
- Encabezado: `FDOC`; partidas: `FAXINV`; cliente: `FCLI`; producto: `FINV`.
- Movimientos del auxiliar: `FAX`; comentarios: `FCOMENT`; piezas/cajas: `FCAJAS`.
- Prefijo API: `/api/sales/invoices`.
- La API consulta el historial de Facturación y permite registrar una remisión FA desde un pedido web.

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

Las remisiones web con folio `FAW` se consultan en detalle, por folio, mediante flechas y en el buscador. La fuente derivada es `tuvansa.sales_remissions` en PostgreSQL. **Auxiliar** muestra el cargo FA y la referencia al pedido según `MFACT/33`. **CT** muestra las partidas registradas. **Sellar** muestra el estado y permite una simulación en el entorno de desarrollo o pruebas.

## Remisión México desde pedido

**Facturar** abre la captura de un pedido autorizado y asignado. Omnis sigue
`MFACT/2 → /39 → /38` y toma `CIATMFACT=FA` de México. El tipo FA reduce
Inventarios y genera el cargo en Cuentas por cobrar. El tipo fiscal FE se
emite en un paso independiente que requiere la integración de timbrado.

| Operación | Endpoint | Efecto |
| --- | --- | --- |
| Preparar | `GET /api/sales/invoices/from-order?orderNumber=:number` | La revisión del pedido y el máximo que se puede remitir en cada partida |
| Registrar | `POST /api/sales/invoices/from-order` | Guarda folio FAW, salida y cargo. Aumenta lo surtido y libera la asignación aplicada |
| Cancelar | Cierre de la captura | Descarta la fecha y las cantidades ingresadas |

La captura web cubre pedidos locales de México en pesos, dentro del periodo
fiscal, con IVA del 16 % y productos en su unidad base sin capas, lotes ni piezas.
PostgreSQL verifica la revisión del pedido, las existencias y el crédito al
confirmar. Una clave de solicitud repetida devuelve el folio original si todos
los datos coinciden. Los requests están en `http/sales/invoices.http`.

Los depósitos de [Cobranza](../accounts-receivable/clients.md#cobrar-una-remisión-web) actualizan **Pagado** y **Saldo**. **Auxiliar** conserva el cargo FA, muestra los abonos PA por fecha y enlaza cada póliza. Al liquidar, Facturación muestra la fecha del último cobro aplicado.

## Simulación de timbrado

En Omnis, `MFACT/86` lee `FTIPMV.TICONVERTIR` para convertir una remisión.
En México el movimiento destino de FA es FE. El botón web **Sellar** abre
una prueba de esa etapa para una remisión web FA activa con importe positivo.
La ventana muestra el origen, el IVA, el total y el tipo previsto FE de ingreso.

| Vista y botón | Endpoint | Procedencia y efecto |
| --- | --- | --- |
| Facturación / Sellar | `GET /api/sales/invoices/:invoiceId/actions/seal` | Estado de la ficha. El contexto de simulación lee `tuvansa.sales_remissions` y `tuvansa.sales_stamping_simulations` mediante SQL derivado |
| Sellar / Simular timbrado | `POST /api/sales/invoices/:invoiceId/actions/seal/simulation` | SQL derivado. Registra una referencia `SIM-FE-…` en `tuvansa.sales_stamping_simulations`. Un reintento devuelve la misma referencia y fecha |
| Sellar / Cancelar | Cerrar la ventana | Conserva el estado anterior |

La referencia se muestra como **Sin validez fiscal**. El resultado consiste
en la referencia interna y su fecha. La simulación queda fuera de los
acumulados de Inventarios y Cuentas por cobrar. La captura fiscal, la
validación de CFDI 4.0, el sellado con CSD y la certificación con un PAC
corresponden a la integración posterior.

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
| Acciones | Sellar | `/:invoiceId/actions/seal` | Estado CFD/folio y simulación disponible para remisiones web en pruebas |
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
