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
| Preparar | `GET /api/sales/invoices/from-order?orderNumber=:number` | Revisión, máximo por partida y ejercicio fiscal (`fiscalStart`, `fiscalEnd`) de `FCIA.CIAFI/CIAFF`, mediante la consulta derivada de referencias |
| Registrar | `POST /api/sales/invoices/from-order` | Guarda folio FAW, salida y cargo. Aumenta lo surtido y libera la asignación aplicada |
| Cancelar | Cierre de la captura | Descarta la fecha y las cantidades ingresadas |

La captura web cubre pedidos locales de México en pesos, dentro del periodo
fiscal, con IVA del 16 % y productos en su unidad base. Admite productos
ordinarios y productos con PEPS global bajo la configuración de TUVANSA.
La preparación propone la fecha de México en `defaults.issuedAt` únicamente
si cae dentro del ejercicio, incluidos ambos extremos. Fuera del ejercicio
devuelve `null`. Al confirmar se vuelve a leer el periodo y el POST rechaza
una fecha fuera del rango con `422 SALES_REMISSION_INVALID`.
PostgreSQL verifica la revisión del pedido, las existencias y el crédito al
confirmar. Una clave de solicitud repetida devuelve el folio original si todos
los datos coinciden. Los requests están en `http/sales/invoices.http`.

Los depósitos de [Cobranza](../accounts-receivable/clients.md#cobrar-una-remisión-web) actualizan **Pagado** y **Saldo**. **Auxiliar** conserva el cargo FA, muestra los abonos PA por fecha y enlaza cada póliza. Al liquidar, Facturación muestra la fecha del último cobro aplicado.

### Remisión con PEPS global

`MFACT/38` genera el auxiliar de inventario a través de `MBASE/41`.
`MCPAR03/21, /33, /37` toma las capas más antiguas del producto en orden
de `LOKEY`. La partida se divide por `LOSEQ` cuando consume varias capas.
Con [45] activo, el costo de la partida es el promedio más ad valorem.
La salida de existencias se registra en el almacén del pedido. Con [94]
inactivo, la capa puede pertenecer a otro almacén.

| Vista / acción | Endpoint | Origen y efecto |
| --- | --- | --- |
| Pedidos / Facturar | `POST /api/sales/invoices/from-order` | Derivado de `MFACT/38` y `MCPAR03/33, /37`. Registra el FAW, las salidas por capa, el surtido y el cargo en una transacción |
| Facturación / Lotes | `GET /api/sales/invoices/:id/actions/lots` | Proyecta las capas, cantidades, almacenes y pedimentos registrados en el FAW |
| Facturación / Cancelar remisión | `POST /api/sales/invoices/:id/actions/cancel-remission` | Derivado de `MFACT/29, /112, /113` y `MCPAR03/35`. Repone las cantidades en los mismos `LOSEQ` y conserva el cargo FA y su contrapartida K en el auxiliar |

Las capas se leen de `FLOTES` y `tuvansa.inventory_adjustment_layers`.
Las salidas y reposiciones comparten el diario PostgreSQL
`tuvansa.inventory_adjustment_layer_stock` con Inventarios y Recepciones.
Al reponer una capa agotada, la misma capa se reactiva al final de la cola
con su cantidad inicial y sus costos originales. **Regenerar pedido**
suma las partidas de las capas de cada renglón y devuelve la cantidad al
pendiente. El documento K conserva las ligas a las capas para el Auxiliar
de Inventarios y el saldo del cliente se reduce por el importe de la remisión.

En German, la remisión histórica cancelada `FA25142` conserva las partidas
`K` en `FAXINV` vinculadas a las capas `14388` y `15034` de `FLOTES`.
`FAX` contiene tanto el cargo FA como la contrapartida K por el mismo importe.
La validación nativa se apoyó en esos registros y en los procedimientos
exportados. La sesión de pruebas llegó a **Pedidos** pero el alta quedó
bloqueada en esta biblioteca.

En PostgreSQL de pruebas, el pedido temporal `NP5000000034` asignó tres
unidades del producto `01511263`. `FAW00000025` remitió dos y registró
una salida en cada capa `18118` y `17836` por un cargo de 464 MXN.
**Lotes** mostró ambas capas en Chrome. La cancelación regeneró los
tres pendientes, revirtió el cargo y repuso las cantidades en las dos
capas. `18118` volvió al final de la cola PEPS. Se comprobaron los
reintentos de alta y cancelación y se retiraron los folios temporales.

La prueba integrada con Chromium y Neon asignó tres unidades, remitió dos
con PEPS y cobró 40 MXN del cargo de 464 MXN desde **Clientes → Saldo →
Cobrar**. El pendiente de la remisión quedó en 424 MXN. La cuenta web
apareció al habilitar depósitos. Al deshabilitarlos después de abrir la
captura, el POST devolvió conflicto y el saldo de la cuenta quedó en cero.

Se concilió el depósito y luego se revirtió el PA. La reversión reabrió el
pendiente por 40 MXN y se concilió en su propio corte. El saldo bancario
pasó de 0 a 40 y regresó a 0 MXN. Ambas pólizas reflejaron el corte
correspondiente en la partida bancaria. Con el PA vigente, la cancelación
FAW fue rechazada y conservó las existencias. Tras la reversión, la
cancelación con regeneración devolvió los tres pendientes, conservó la
unidad asignada sin remitir y restauró la existencia, el crédito y ambas
capas. **Lotes** mostró sus dos identificadores en Chromium. Se verificaron
los reintentos y se retiraron las filas de prueba.

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

## Cancelar una remisión

`GET /api/sales/invoices/:invoiceId/actions/cancel-remission` prepara la
cancelación de una remisión web FAW o una histórica FA de TUVANSA. El POST
registra el motivo, la fecha, la confirmación y la elección de regenerar el
pedido. El servidor aplica las reglas de `MFACT/28,29,112,113,232` para el
flujo ordinario de TUVANSA.

El folio original conserva su historial. El documento K repone las unidades
en el mismo almacén y se revierte el cargo de cartera. Al elegir regenerar,
las unidades vuelven al pendiente del pedido y se conserva la asignación
vigente. Si hay cobros web activos, se deben revertir primero. La API
requiere un periodo abierto y comprueba el estado fiscal.

### Remisiones históricas de Omnis

| Vista / acción | Origen de la comprobación | Efecto web |
| --- | --- | --- |
| Facturación / Cancelar remisión | MySQL adaptado. `FDOC` y `FTIPMV` de TUVANSA. Comprueba estado fiscal, UUID, folio, PAC y tipo de movimiento | La ficha histórica abre la consulta con `cancellationAvailable`. Al confirmar, conserva el documento original y muestra la cancelación |
| Inventarios / Documentos | MySQL adaptado de `MFACT/112` y `MCPAR03/21, /35`. Cantidad, costo, almacén y `LOSEQ` de `FAXINV`, con la capa correspondiente en `FLOTES` | Registra un K con cantidades positivas al costo original y abona cada capa por separado en `inventory_adjustment_layer_stock` |
| Clientes / Auxiliar, Saldos y Movimientos | MySQL adaptado de `MFACT/232`. Un único cargo FA en pesos por `FAX.DSEQ`, sin cobros ni movimientos vinculados | Agrega el abono K, retira la remisión del saldo abierto y refleja el crédito liberado |
| Pedidos / Regenerar pedido | MySQL adaptado de `MFACT/29,113`. `FAXINV.AIPED` apunta a `FPLIN.PLSEQ`. Verifica pedido, cliente, almacén, moneda, tipo de cambio y cantidad surtida | Suma `AICANTF` por renglón de pedido cuando se surtió desde varias capas. Devuelve el total al pendiente y reduce el importe surtido por `AIPRECIO × AICANTF` con piso de cero |

**PEPS histórico.** La acción **Cancelar remisión** acepta FA ordinarias de
México en pesos, dentro del periodo abierto, con el cargo íntegro y sin
timbrado ni cobros. Comprueba que cada capa pertenezca al producto y conserva
el almacén de cada capa aunque difiera del almacén de la remisión. La salida
original ya está reflejada en la apertura de MySQL. PostgreSQL registra la
reposición con la cancelación, la devolución de existencias, el abono y la
regeneración elegida en una sola transacción. Al reactivar una capa agotada,
conserva el mismo `LOSEQ` y lo devuelve al final de la cola.

`FA24192` de German documenta el surtido parcial. Los dos renglones de
`FAXINV`, con 1 y 18 piezas, comparten la partida `FPLIN.PLSEQ=595115`
y conservan las capas `14484` y `14556`. El folio corresponde a 2024.
La copia de pruebas contiene dos FA activas con capas en el periodo 2025,
ambas en dólares. El caso de dos capas en pesos se reproduce con datos
sintéticos de prueba.

En PostgreSQL de pruebas, la cancelación del caso sintético repuso dos
unidades, cambió los saldos de las capas de 0 y 4 a 1 y 5, devolvió los
tres pendientes del pedido y abonó 116 MXN. Dos solicitudes simultáneas
con la misma clave registraron una sola reversión. Se retiraron los
datos temporales. La consulta de `FA25374` verificó el bloqueo por
periodo contable y la de `FA25587`, el bloqueo por moneda.

Los cobros PA históricos, el timbrado, RECADV, los kits y las partidas
con manejo especial muestran el motivo de bloqueo. La regeneración tiene
su propia validación. Por ejemplo, la FA25675 en pesos admite cancelación
y devuelve 12 unidades al almacén 01. Su pedido P019208 se emitió en dólares
y queda fuera de la regeneración automática.

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
| Sumarios | Tiket > Factura | `GET` y `POST /:invoiceId/summaries/ticket-to-invoice` | Vista previa y conversión de remisión web `FAW` a factura web `FEW` pendiente de timbrar |
| Sumarios | Traspaso | `/:invoiceId/summaries/transfer` | Partidas a transferir; no modifica inventario |
| Sumarios | Edita pzas | `GET /:invoiceId/summaries/edit-pieces`, `PATCH /:invoiceId/summaries/edit-pieces/:lineId` | Valor de piezas de la partida seleccionada (`FAXINV.AIPZAS`), con cambios web en PostgreSQL |
| Sumarios | Liquidación camión | `/:invoiceId/summaries/truck-settlement` | Ruta, fecha, cliente e importe; no liquida |

### Edita pzas y sumarios en German de pruebas

El 25 de noviembre de 2026, TUVANSA México abrió **Cambio pzas** sobre la
primera partida de `FA25675` (`DSEQ=346421`, `AISEQ=617810`, almacén `01`). La
ventana mostró **Valor** vacío. Se pulsó **Cancelar**. El registro de origen
contiene `FDOC.DPZAS=12` y `FAXINV.AIPZAS=''` en las tres partidas. Los
artefactos locales son `captures/ui/closure-20261125-sales-invoices-edit-pieces.png`
y `captures/ui/omnis7-developer-check/20261125-EFACT13-PROCEDURES.txt`.

`EFACT#13/74` llama a `INICIO/30` con el acceso `EFACT#13/74` y requiere una
partida seleccionada. Lee `FAXINV` por `AISEQ` con `MSQL/251`, presenta
`ECIA#11JC///600` y, al confirmar, llama a `MBASE/74` para guardar el valor en
`FAXINV.AIPZAS`. Reemplaza la partida en la lista y redibuja. El procedimiento
no tiene filtros adicionales por estado de timbrado ni llamadas de actualización
de totales, almacén, existencias, capas PEPS o saldo. El tipo histórico de
`AIPZAS` es `varchar(24000)`.

La consulta web devuelve el valor textual y una `version` por partida. El
PATCH recibe `{expectedVersion, requestKey, value}`. El identificador de partida
corresponde a `AISEQ` para documentos históricos o al identificador persistido para
remisiones web. La consulta histórica restringe la escritura al catálogo de
Facturación de México, con `DEST=0`, `DMULTICIA=1` y `DESFACT=1` o `DESCXC=1`.
Cada revisión conserva los identificadores de documento y partida en
`tuvansa.sales_invoice_line_pieces`. El mismo UUID y contenido recuperan la
revisión confirmada. Una versión vencida recibe `409`. La ficha y **CT** muestran
el valor guardado, con los totales, almacén e inventario originales.

La verificación web recorrió la selección de la segunda partida, Cancelar, OK,
la ficha y CT en Chrome con un folio sintético y PGlite. La prueba HTTP cubre
reintento, UUID reutilizado con otro valor, dos solicitudes superpuestas y
rollback tras un fallo inyectado entre INSERT y COMMIT. Las bases temporales
se cerraron al terminar.

En la prueba integrada de Chromium se abrió `FA25675` y se enfocó
`AISEQ 617811`. **Edita pzas** guardó ` 7 x 2 ` en PostgreSQL temporal.
La ficha y CT devolvieron el mismo texto, incluidos los espacios. Se
compararon los totales y todas las partidas. La cantidad de la partida
siguió en −6 y la lectura de MySQL conservó `AIPZAS` vacío.

El 25 de noviembre también se confirmó el despacho de las acciones siguientes.

- **Tiket > Factura** llama a `MFACT/86`. En México `FTIPMV` contiene la
  conversión `FA → FE`. El procedimiento valida las partidas fiscales en
  `/322`, conserva `DSEQ` y copia el folio y la fecha originales a
  `DTALON` y `DFECHATALON`. `/362` asigna el folio y deja `DSTATUSCFD=1`.
  `/139` actualiza la fecha y el importe de la primera partida existente
  en `FAX`. Para TUVANSA el factor de cambio es 1. La rama que modifica
  precios de `FAXINV` se ejecuta con un factor distinto de 1.
- **Traspaso** usa los permisos de `EFACT#13/34` y llama a `/197` o a `/198`
  con Shift. La copia histórica habilita `CIACOMPORTA[37]`, pero el tipo `FA`
  de `FA25675` tiene `TITRASPASOS=0`. El procedimiento requiere un tipo que
  admita traspasos y trae `TZ` para la operación normal. Falta el folio elegible
  con el tipo de destino configurado para verificar los efectos sobre `FDOC`,
  `FAX`, `FAXINV` y piezas.
- **Liquidación camión** requiere `EFACT#13/76` y abre `EFACT#23`, el formato de
  liquidación de camionetas Unifoods. Usa listas propias de entrega/devolución,
  con importación de archivo tabulado o colector COM1/COM2. Falta una sesión
  con liquidación de prueba y sus documentos de devolución. La lectura de ruta
  de la ficha de Facturación brinda contexto, mientras se comprueba el flujo.

### Tiket > Factura en la web

La vista previa devuelve `ticketConversion` junto con `readOnly` y
`reason`. La confirmación recibe `expectedVersion` y `requestKey`.
Se admite la remisión web de México en pesos, con partidas positivas,
un cargo original sin movimientos PA y tipos `FA` y `FE` compatibles
en `FTIPMV`. La fecha de emisión se toma en `America/Mexico_City`.
El mismo envío recupera el resultado al reintentar. Una revisión
vencida devuelve `409`.

La numeración `FEW` y el vínculo con `FAW` quedan en
`tuvansa.sales_ticket_conversions`. Facturación resuelve ambos folios
al mismo ID y conserva el vencimiento, las partidas, el total y el saldo.
Se conserva el código de movimiento `FA` y el estado queda pendiente
de timbrar. Saldo, Movimientos y Auxiliar muestran el cargo único con
la nueva fecha. El pedido y los auxiliares de inventario muestran el
nuevo folio sobre el mismo surtido y la salida original, cuya fecha,
cantidades y capas siguen siendo las del movimiento de remisión.
Los cambios de piezas conservan el vínculo por ID, folio de origen
e ID de partida.

La evidencia histórica incluye `FE0061935`, antes `FA25659`, con el
mismo `DSEQ` y un cargo `FA` fechado el día de la conversión. El
controlador mexicano de German llama a `MFACT/86` directamente. Ese
procedimiento puede escribir al cerrar el diálogo de tipo de cambio.
La verificación nativa se hizo con lectura del historial y los
procedimientos exportados.

Chromium recorrió vista previa, Cancelar, Confirmar y reapertura
de la factura `FEW` con el mismo ID. Evidencia
`ev_233c15177c4f0abd155aa9543f27a670ea1fe4ab81d3bf51c23a7cd81a08d243`.
En la misma instancia de PGlite se cotejaron Facturación, Pedido,
Inventarios y Saldo. Con PostgreSQL 17 local se comprobaron carreras
en la misma remisión contra otra conversión, una captura PA y una
cancelación. También se verificaron el conflicto `409`, el reintento
y el rollback tras un fallo entre `INSERT` y `COMMIT`
(`captures/postgres-ticket-conversion/verified-run.txt`).

### Contrato de los paneles

Cada panel regresa `button`, `section`, `source`, `available`, `readOnly`,
`items` y, cuando corresponde, `summary` y `reason`. Esto permite reutilizar el
diálogo ERP compartido del frontend y distinguir claramente las operaciones que
permanecen deshabilitadas durante la migración de lectura.

Los requests reproducibles están en `http/sales/invoices.http`. La evidencia de
captura se documenta en `invoices-capture.md`; el registro crudo y las capturas de
pantalla permanecen en `captures/`, excluido de Git.

### Evidencia histórica de Cajas y Empaque

Cajas y empaque quedan fuera del alcance vigente de TUVANSA México.
En German, **Cajas** abrió Empaque en `FA25675` con el resumen, la lista
y el detalle vacíos. `EFACT#13/23` llama a `EFACTEMP/100(kTrue,DNUM)`.
Las lecturas `/121`, `/190` y `/191` consultan `FYG` con
`EMP_LTD_F_<DNUM>` y resuelven los detalles `EMP_EMP_<ID>.<n>`.
**Generar** requiere `EFACTEMP/131`, pide la distribución en
`EFACTEMPGENM/100` y toma partidas positivas. La copia histórica carece de
registros `EMP_LTD_`. El panel web consulta `FCAJAS` como contexto.
