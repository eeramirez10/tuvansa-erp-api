# Ventas - Pedidos

**Duplicar en México.** Confirmado en [la captura de Proscai](orders-capture.md#alta-real-observada) para una copia al 100 %. En la web, **Duplicar** revisa el pedido o cotización de origen y **OK** crea un pedido independiente para el mismo cliente. Conserva las cantidades originales y el nuevo pedido inicia pendiente, con un folio P del catálogo. La fecha de alta corresponde a México. El origen conserva su estado. En la copia de pruebas de Omnis, el pedido `P019406` con una partida de cantidad cero generó el encabezado `P019407` sin partidas. La vista previa web omite esas partidas y avisa cuando la copia quedará vacía.

| Vista / botón | Endpoint | Origen y procedencia |
| --- | --- | --- |
| Pedidos / Duplicar | GET `/api/sales/orders/:id/actions/duplicate?companyId=1` | Vista previa derivada del historial `FPENC/FPLIN` y la versión local de `tuvansa.orders`. JSON con `data.summary.revision`, `orderedAt`, total y partidas. |
| Duplica Pedido / OK | POST en la misma ruta | Guarda en PostgreSQL. Recibe `requestKey`, `revision` y `orderedAt`. El origen o los totales revisados que cambien producen 409. Guarda el recibo en `tuvansa.order_duplicate_requests` junto al alta y su auditoría. |

**Persistencia actual (2026-09-15):** [MySQL de lectura + PostgreSQL/Neon de escritura](../../NEON-WRITE-DATABASE.md). Incluye ambos POST de alta, PATCH, DELETE, Cotiz y lecturas combinadas. La implementación MySQL de escritura descrita en los documentos anteriores queda como referencia histórica.

| Vista / botón | Endpoint | Origen actual | Procedencia |
| --- | --- | --- | --- |
| Pedidos / Nuevo, Comentarios / OK | POST `/api/sales/orders/capture` | PostgreSQL; referencias MySQL | Derivada del flujo `ORDERS_NEW_000001_11-SAVE_OPEN_COMMENTS` y `13-COMMENTS_OK` |
| Alta anterior | POST `/api/sales/orders` | PostgreSQL | Derivada |
| Pedidos / Editar | PATCH `/api/sales/orders/:id` | PostgreSQL; copia base si es heredado | Derivada |
| Pedidos / Eliminar | DELETE `/api/sales/orders/:id` | Marca local en PostgreSQL | Derivada |
| Pedidos / Cotiz | POST `/api/sales/orders/:id/actions/quote-conversion` | PostgreSQL | Derivada de los marcadores capturados de alternancia 1↔4 |
| Pedidos / Autorizar, Ctrl+A | POST `/api/sales/orders/:id/actions/authorization` | PostgreSQL | Derivada de `ORDERS_AUTHORIZE_CTRL_A` y `ORDERS_DEAUTHORIZE_CTRL_A_SUCCESS` |
| Pedidos / Asignar todo, Ctrl+P | POST `/api/sales/orders/:id/actions/assignment` | PostgreSQL | Derivada de los marcadores de asignación/desasignación |
| Pedidos / Comentarios / OK | PATCH `/api/sales/orders/:id/actions/comments` | PostgreSQL | Derivada; cambia T.C./moneda y recalcula importes |
| Encuentra producto | GET `/api/sales/orders/capture/products` | MySQL de solo lectura, almacén 01 | Derivada de la pantalla observada; SQL literal pendiente de captura |
| Catálogo, búsqueda, navegación | GET `/api/sales/orders/...` | MySQL + versiones locales PostgreSQL | Adaptada y derivada |

Tablas nuevas: `tuvansa.orders`, `tuvansa.order_changes`, `tuvansa.order_stock_deltas`; migraciones en `tuvansa.schema_migrations`. MySQL FPENC/FPLIN/FINV/FALM/FCLI/FTIPMV no reciben escrituras.

Prueba real de desarrollo del 2026-09-15: `POST /api/sales/orders/capture` creó **NP5000000000** con cliente `000001` y producto `01300958`; GET, PATCH, **Cotiz** y DELETE quedaron verificados contra Neon. La baja es lógica: la API devuelve `404` y PostgreSQL conserva cuatro revisiones de auditoría. Detalle en [NEON-WRITE-DATABASE.md](../../NEON-WRITE-DATABASE.md).

Implementación del alta de la versión nueva: [contrato, procedencia SQL, flujo y validación](orders-create-api.md). El frontend usa `POST /api/sales/orders/capture`; el POST heredado no es equivalente.

Ejercicio de la versión nueva (2026-09-14): [alta desde el icono Nuevo](orders-create-new-version.md). Incluye selección de almacén, captura de partida, Comentarios y conversión de Cotización (4) a Pedido (1). Es evidencia visual y de lecturas de comprobación; no una nueva captura SQL.

Repetición con **SQL real capturado**: [alta de P021063](orders-create-sql-new-version.md), 99 sentencias funcionales y 17 escrituras. Confirma el vínculo nuevo de comentarios, la secuencia de persistencia y los ajustes de inventario. Neon registra diferencias locales por pedido; la API no escribe los acumulados ni existencias de MySQL que modifica OMNIS.

Reglas verificadas con SQL real en `P021066`: [búsqueda, costo, autorización, asignación, edición y Cotiz](orders-behaviors-new-version.md). La captura confirma que la asignación exige autorización, la desautorización exige desasignar, la edición autorizada se bloquea y `Cotiz` alterna en ambos sentidos. También demuestra que el indicador visible de autorización es `PEPAR9='O.K.'`; `PEUSRAUT` conserva el usuario después de desautorizar.

La captura de alta admite precios y costos en PESOS o DOLARES. `IMONEDA1=1` usa costo en pesos de `ILISTA5`; `IMONEDA1=2` usa costo en dólares de `ILISTA6`. La moneda de cobro y el T.C. se editan en **Comentarios del pedido**; la API convierte las partidas y totales a esa moneda antes de guardar en Neon. La fórmula de conversión es derivada y está cubierta por pruebas; no se presenta como SQL ni algoritmo capturado de OMNIS.

## Origen y alcance

- Acceso OMNIS: `F3` o botón **PEDIDOS**.
- Pedido usado para contrastar la pantalla: `P010773` (`PESEQ=72391`).
- Encabezado: `FPENC`; partidas: `FPLIN`; cliente: `FCLI`; productos: `FINV`.
- Comentarios: la API y documentación anterior usan `10000000 + FPENC.PESEQ`; el alta capturada en la versión nueva usa **`1000000000 + FPENC.PESEQ`**. Véase la evidencia enlazada; equivalencia pendiente de corregir.
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
| Abrir Pedidos | `GET /api/sales/orders/by-number/P010773` | Carga directamente el detalle inicial sin búsqueda paginada ni `COUNT(*)` |
| Ficha de pedido | `GET /api/sales/orders/:orderId` | Encabezado, cliente, partidas, Totales e Importes |
| Flecha izquierda | `GET /api/sales/orders/:orderId/previous` | Pedido anterior |
| Buscar | `GET /api/sales/orders?q=...` | Ventana Búsqueda por pedido, pedido cliente, cliente o nombre |
| Flecha derecha | `GET /api/sales/orders/:orderId/next` | Pedido siguiente |
| Hoja / Nuevo | `POST /api/sales/orders` | Alta de encabezado, partidas y acumulados |
| Borrar | `DELETE /api/sales/orders/:orderId` | Baja protegida si existe factura o surtido |
| Hoja y lápiz / Editar | `PATCH /api/sales/orders/:orderId` | Reemplaza el detalle completo: agrega, modifica o elimina partidas; bloquea pedidos autorizados |

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
| Pedido | At. / Plazo / O.K. | `attention`, `termsDays`, `authorization` | `PEPAR1`, `PEPLAZO`, `PEPAR9` |
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
| Duplicar | GET y POST `/:orderId/actions/duplicate` | Vista previa y confirmación de un pedido nuevo al 100 % para el mismo cliente de México. |
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

## Escrituras migradas

`POST`, `PATCH`, `DELETE`, autorización, asignación y `Cotiz` escriben únicamente
el modelo local de PostgreSQL/Neon. MySQL conserva su función de lectura y
referencias. La API copia el estado base de un pedido heredado al primer cambio,
guarda revisiones y diferencias de inventario, y aplica las reglas capturadas sin
actualizar `FPENC`, `FPLIN`, `FINV`, `FALM` ni otros acumulados legacy.

Los requests reproducibles están en `http/sales/orders.http`. La evidencia SQL
y la prueba controlada de alta/edición/baja están en `orders-capture.md`.

### Autorizar o desautorizar con Ctrl+A

En German, **Pedidos → Autorizar pedido** corresponde a `MPED/5` y consulta
`MPED5` mediante `INICIO/30`. La consulta de `FHELP` del respaldo de México
confirmó el acceso para los grupos 0, 18 y 21, con control por grupo activo
en `FCIA.CIACOMPORTA[39]`. Los avisos de límite de crédito del procedimiento
corresponden a las ramas `FERRIONI`, `FABRILMALLA` y `ESPECIA`. México conserva
el bloqueo del cliente al autorizar y el control del límite al remitir.

El POST recibe `authorized` y `revision` con la sesión web de TUVANSA México.
`revision` es `storage.revision` en la ficha y `0` para un pedido heredado
sin revisión web. La API resuelve al usuario desde la cookie y vuelve a
comprobar el permiso efectivo `MPED5` de su grupo. Si el permiso requiere
supervisor, la API devuelve `403`. Al faltar sesión, **Autorizar** abre el
inicio de sesión y regresa a la ficha. [Usuarios y permisos](../general-data/users.md)

El permiso se administra en **Usuarios → Grupo → Permisos**. Lo guardado
para `MPED5` se aplica en la siguiente operación del usuario.

La API verifica la vigencia y disponibilidad del cliente con `FCLI.CLIBAJA`,
`FCLI.CLISOLOPOS` y los bloqueos registrados en el catálogo web. Aplica la
misma elegibilidad que en **Captura de pedido**. También vuelve a comprobar
el precio unitario de las partidas pendientes antes de descuentos contra
el costo vigente de `ILISTA5` o `ILISTA6`, con el tipo de cambio del pedido.
Estas consultas de autorización son derivadas. **No ver costos** conserva
la validación y el aviso sin revelar el importe del costo.
Para desautorizar, se bloquean pedidos con asignación o surtido. PostgreSQL
comprueba la revisión bajo el bloqueo del pedido y guarda el estado y el
usuario de la transición en `tuvansa.order_changes`. **Comentarios** muestra
la bitácora de cambios web y conserva el último usuario que autorizó al
desautorizar. Una petición con el mismo estado y la revisión vigente devuelve
la ficha sin otra revisión.

En la primera versión, Chromium y PostgreSQL 17.12 de pruebas comprobaron que **Ctrl+A** abrió la firma y
rechazó un usuario sin `MPED5` y una partida bajo costo. El botón **Autorizar**
registró la firma válida y la mostró en **Comentarios**. Después del surtido
parcial y la desasignación de la unidad restante, desautorizar devolvió `409`
y conservó `O.K.`. Con dos sesiones concurrentes y la misma revisión, una
firma prosperó, la otra devolvió `409` y quedó un solo evento de bitácora.
Evidencia local en `captures/sales-authorization-result.txt` y
`captures/sales-authorization-concurrency-result.txt`.

La prueba actual con sesiones y PostgreSQL aislado verifica que conceder y
retirar `MPED5` en Usuarios surte efecto sobre la misma sesión. También
comprueba los rechazos por cliente bloqueado y precio bajo costo, y la firma
en **Comentarios**. [Prueba de integración](../../../tests/neon-orders.test.ts)

### Almacenes de captura en México

`SALES_ORDER_WAREHOUSES` habilita los códigos para **Nuevo** y para cambiar
el almacén de un pedido que se puede editar. El alcance predeterminado es
`01`. Por ejemplo, `SALES_ORDER_WAREHOUSES=01,12` permite elegir el almacén
principal y el resguardo 12. `GET /api/sales/orders/capture/options` devuelve
los códigos habilitados que existen como almacenes de la compañía 1 en
`FALMCAT` (`CATTIPO=''`, `CATMULTICIA=1`, `CATCIA IN (0,1)`).
El alta y la edición validan el mismo catálogo en el servidor. El POST
clásico propone 01 cuando se omite el almacén.

En el ejercicio de Nuevo se observaron 01, 11, 12, 13 y 99. La consulta local
identificó 01, 11, 12 y 13 en la compañía 1 y la cotización histórica
`XA16542` (`PESEQ=115788`) en el almacén 12. El tránsito 99 pertenece al catálogo global.
El selector `EALM#1/240` cruza `CATCIA` con `CIACIAUSR`, permite códigos
compartidos mediante `CATMULTICIA=0` y comprueba `CIAUSER` en `CATUSUARIOS`.
Los registros observados tienen `CATUSUARIOS` configurado. El alcance web
pertenece al servidor. La sesión web todavía carece de identidad del operador
de Omnis.
[Ejercicio de Nuevo](orders-create-new-version.md#flujo-observado)

El pedido conserva un solo almacén para buscar productos, registrar pendientes
y asignar existencias. El cambio de almacén de un pedido editable mueve el
pendiente al almacén elegido. La sucursal de entrega del cliente en
`FSUCURSALES` y la sucursal de partida `PLSUC` son campos independientes.

## Surtido desde Facturación

Facturación → Facturar toma un pedido web autorizado y asignado para emitir
una [Remisión México FA](invoices.md#remisión-méxico-desde-pedido).
Cada remisión incrementa lo surtido, reduce el saldo pendiente y libera la
asignación correspondiente. El pedido conserva el historial de cargos FA en
Auxiliar. La asignación de otros pedidos del mismo almacén se calcula con las
existencias, las recepciones, las remisiones y las reservas locales vigentes.
