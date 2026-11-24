# Inventarios P.T. → Consultas → Documentos

El panel abre **Consulta de movimientos de inventario** y su ventana
**Búsqueda** empieza vacía. El documento buscado se selecciona por sus
propios filtros, independientemente del producto que se estaba consultando.

| Control de Omnis 7 | Endpoint | Tablas | Procedencia |
| --- | --- | --- | --- |
| Búsqueda | `GET /api/inventories/movements` | FDOC, FCLI, FPRV | Derivada de `EINV#24/243` → `EMOVSINVFIND/100`; reglas en `/131` y lista en `/133` |
| Abrir el documento | `GET /api/inventories/movements/:id` | FDOC, FAXINV, FINV, FCLI, FPRV | Adaptación basada en el procedimiento `EINV#24/240` |
| Cancelar | `DELETE /api/inventories/movements/:id` | `tuvansa.inventory_movement_documents` y los saldos de apertura de PostgreSQL | Derivada de `EINV#24/41`, `MFACT/112` y `MCPAR03/21` |

El marcador histórico [INV_QUERY_DOCUMENTOS_RETRY](product-buttons-capture.md#inv_query_documentos_retry)
registra la apertura de `EINV#24` y consultas de sesión y configuración.
Los SELECT de la API se implementaron con los campos de la ventana y su
procedimiento. El marcador histórico no contiene los SELECT de Búsqueda.

La búsqueda acepta `document`, `date` en formato ISO, `reference`,
`reference2`, `warehouse`, `supplier`, `customer`, `page` y `pageSize`. Los
filtros de texto son por prefijo y la fecha es exacta. La búsqueda vacía
entrega cero resultados. La lista se limita a 1000 filas con `DESINV=1` y
ordena por el primer filtro activo de fecha, referencia, REF2, proveedor o
cliente. El listado usa el folio como orden predeterminado y desempata por
`DSEQ`.

El detalle usa el `DSEQ` seleccionado y presenta las líneas por `AISEQ`.
Conserva la cantidad firmada de `AICANT` y el costo unitario de `AICOSTO`.
El costo total es la suma de los costos por cantidad. `piecesText` conserva
el valor de origen de `AIPZAS`; `pieces` representa su valor numérico.

La API usa `FDOC.DITIPMV` para exponer el tipo de movimiento del encabezado.

## Prueba de cancelación en Omnis 7

En la biblioteca German de pruebas, el documento `EI1000` (`DSEQ=65047`)
tenía una partida del producto `01300935` con entrada de 2, costo unitario
de 5,777.0850 y costo total de 11,554.17. **Cancelar** pidió confirmación,
mostró **Eliminando movimientos** y terminó en **El documento ha sido
eliminado**. Al aceptar el mensaje, la ventana quedó vacía. Al volver a
buscar el folio, se pudo abrir el mismo encabezado con la partida de tipo
`K`, sin cantidad y con costo cero.

El procedimiento `EINV#24/41` comprueba `DESINV` y `DESFACT`, confirma con
el usuario y recorre las partidas del folio. `MFACT/112` revierte
`FINV.ISTKACT` y `FINV.ISTKPZS`, llama a `MCPAR03/21` y marca el auxiliar
`FAXINV` con `AITIPMV='K'`, cantidad, costo y precio en cero y, para la
compañía probada, piezas en blanco. `MCPAR03/21` deriva la actualización
de almacén a `INICIO/51` cuando corresponde. Otros flujos aplican efectos
en lotes, capas de costo o tránsito. Esta descripción proviene de la
prueba visual y de los procedimientos de la biblioteca. Los comandos de
PostgreSQL son una implementación derivada.

## PostgreSQL

La anulación revierte en una transacción las cantidades y piezas del
producto y, si la apertura lleva saldos por almacén, sus cantidades. Conserva
la versión original y el detalle con partidas `K`. El folio se mantiene en
la búsqueda para consulta histórica y su detalle indica que ya está anulado.
El primer `DELETE` y sus reintentos devuelven `204`. Un documento que carece
de los saldos o de las reglas necesarias se rechaza con `409` antes de
afectar el inventario. Las partidas con lotes, los efectos de capas y los
flujos de tránsito requieren validación adicional. El `GET` de detalle
indica cuándo el botón puede usarse mediante `cancellationAvailable` y
`cancellationReason`.

El valor predeterminado de `INVENTORY_MOVEMENTS_SOURCE` es `mysql` y habilita
la consulta en PROSCAI. El cambio a `postgres` usa los documentos y saldos
cargados en `NEON_DATABASE_URL`. Prepara una apertura conciliada antes del
cambio. El siguiente comando instala la migración `003_inventory_movements`
y carga la apertura una sola vez.

```powershell
pnpm exec tsx scripts/stage-postgres-inventory-movements.ts --snapshot archivo-de-apertura.json
```

El archivo contiene `policy` con `warehouseTracking`, `layerEffects` y
`transitEffects`, `documents` con `header`, `lines` y `totals` del detalle,
`products` con `productId`, `quantity` y `pieces`, y `warehouses` con
`productId`, `warehouse` y `quantity`. Los saldos usan cadenas decimales.
Si una regla se desconoce, usa `null` y el sistema bloqueará la anulación.
El selector afecta únicamente esta ventana. El catálogo y las consultas
de existencias de otros módulos conservan sus fuentes actuales.

## Inventarios → Movimientos

| Control de Omnis 7 | Endpoint | Tablas | Procedencia |
| --- | --- | --- | --- |
| Inventarios → Movimientos | `GET /api/inventories/movements/capture` | FCIA, FTIPMV, FALMCAT | Derivada de `MINV/1`, `EINV#3/401`, `EINV#3/411` y `EALM#1/240` |
| OK | `POST /api/inventories/movements` | FINV, FALM, FDOC de lectura, `tuvansa.inventory_adjustments`, `tuvansa.inventory_adjustment_stock` | Derivada de `EINV#3/401–402` |
| Consultas → Documentos → Cancelar EI/SI web | `DELETE /api/inventories/movements/:id` | `tuvansa.inventory_adjustments`, `tuvansa.inventory_adjustment_stock` | Derivada de la cancelación observada de `EI1000` |

La edición de pruebas de Omnis 7 inicia `EINV#3` con EI y toma el signo de
`FTIPMV.TIAFINV`. La configuración local de TUVANSA confirma EI Entrada de
inventario `+1` y SI Salida de inventario `−1`. La cantidad se captura en la
unidad base. Omnis propone `ILISTA5 + IADVALOREM` como costo unitario. La API
acepta el costo capturado con cuatro decimales.

La API aplica el alcance de almacenes de captura configurado y habilita los
almacenes ordinarios de la compañía. Los usuarios de Omnis están delimitados
en `TIUSUARIOS` y `CATUSUARIOS`. La sesión web usa la política de acceso de
la API y no identifica al operador por esos nombres históricos. La captura
admite productos activos en unidad base, incluidas las entradas y salidas
con PEPS automático de TUVANSA México. La captura manual de pedimentos y
los productos con control de piezas siguen en sus flujos dedicados.
Los productos web nuevos requieren **No manejar capa** en **Otros**
para registrar EI, SI o TR.

El POST requiere `requestKey` para reintentos. Permite usar un folio con el
prefijo del tipo o dejar que PostgreSQL genere `EIW…` o `SIW…`. Los folios
se comparan con los existentes y no incrementan `FTIPMV.TINUM`. La fecha
se propone con la zona horaria de México. La salida suma las partidas por
producto y valida disponibilidad del almacén con las asignaciones y los
movimientos locales. El alta y la cancelación comparten el bloqueo de
existencias utilizado por Pedidos y Compras.

Cancelar una entrada exige que la cantidad todavía esté disponible. Cancelar
una salida repone la cantidad. El documento conserva el mismo folio y se
puede consultar con las partidas `K` en cero. PostgreSQL conserva el original
y los movimientos de stock firmados de aplicación y cancelación. Las consultas
de documentos incluyen los folios web con ambas fuentes de lectura.

### Entradas y salidas con PEPS

German de pruebas confirma PEPS automático con las posiciones 24, 45 y 51
de `FCIA.CIACOMPORTA` activas y las posiciones 46, 67, 75 y 94 inactivas.
`MCPAR03/21` usa capas en los productos con `INOCAPAS` distinto de 1.

- **Entrada (EI).** `MCPAR03/28` y `/51` abren una capa con saldo inicial,
  folio y almacén. Con el encabezado de pedimento vacío, la capa usa lista 5,
  advalorem y datos de importación de `FINV`. El costo registrado en la
  partida puede ser distinto al de la capa.
- **Salida (SI).** `MCPAR03/33` y `/37` recorren las capas por `LOKEY` en la
  cola del producto y separan la partida por `LOSEQ` al consumir varias.
  TUVANSA tiene la posición 94 desactivada, por lo que la cola es común entre
  almacenes. La salida descuenta el almacén elegido y se registra a
  `ILISTA4 + IADVALOREM`, incluyendo la valoración generada por las
  recepciones con PEPS.
- **Anulación.** `MFACT/112` y `MCPAR03/35` restituyen las cantidades por
  `LOSEQ`, conservan la cantidad inicial y asignan una nueva clave al
  reactivar una capa agotada. La API exige el saldo completo de la capa
  antes de anular una EI y aplica ambas actualizaciones en una transacción.

`FLOTES` se lee en MySQL y se complementa con
`tuvansa.inventory_adjustment_layers` y
`tuvansa.inventory_adjustment_layer_stock` en PostgreSQL. Los paneles
**Lotes** y **UEPS / PEPS** consultan el saldo combinado. La captura web
con capas cubre EI y SI, y la anulación cubre sus folios web.

## Inventarios → Traspasos

`MINV/2` abre `EINV#17` en el flujo multi-almacén. `EINV#17/401` guarda un
folio `FDOC` cuando `CIACOMPORTA[94]=0` y registra el destino en `DALMACEN`
y el origen en `DREFERELLOS`. `/402` genera una partida negativa en el
origen y una positiva en el destino, ambas con el costo capturado. En
`TR0004` (`DSEQ=115003`), el almacén `13` tiene −1,526.18 unidades y el `01`
tiene +1,526.18 en el mismo folio, con costos opuestos en el auxiliar.
`/411` propone `ILISTA4 + IADVALOREM` con el costeo promedio vigente en
TUVANSA y comprueba `ALMCANT − ALMASIGNADO` en el origen.

`GET /api/inventories/movements/capture` oferta TR cuando hay al menos dos
almacenes habilitados y la configuración corresponde a un traspaso ordinario
de un solo folio. El POST usa `type: "TR"`, `warehouse` para el origen y
`destinationWarehouse` para el destino. La API propone `TRW…` y conserva
ambas partidas con sus almacenes. **Documentos** encuentra el TR por el
código de ambos almacenes y **Auxiliar** refleja cada signo en su almacén.
El costo tiene cuatro decimales y el efecto neto de cantidad y costo es cero.
La operación aplica a productos en unidad base, incluidos los que usan
PEPS automático en TUVANSA. El destino y el origen usan el mismo costo
capturado o el promedio vigente más advalorem, incluida la valoración
generada en las recepciones web. `FTIPMV.TR` tiene efecto de inventario y
flags de Cuentas por cobrar, ventas, bancos y fiscal en cero.

Para el PEPS global con `CIACOMPORTA[94]=0`, `EINV#17/402` envía las
dos partidas con `PSOLOALM=1`. La captura web registra el saldo por
almacén con `lotId=0` en ambas partidas. Las salidas desde el almacén
destino usan la cola PEPS común del producto.

`EINV#24/41` recorre todas las partidas del folio y aplica `MFACT/112`.
En `TR0001` (`DSEQ=37842`) las dos partidas de `01` y `13` conservan tipo
`K`, cantidad cero y costo cero. En la web, el `DELETE` requiere las
existencias libres del destino para regresar el traspaso. Registra los dos
deltas inversos, conserva el detalle original y muestra las partidas `K` con
el mismo folio. El registro y la cancelación bloquean ambos almacenes en el
mismo orden y se aplican en una sola transacción de PostgreSQL.

La cancelación web invierte los asientos por almacén del TR original y
conserva la cola PEPS. En German, `MFACT/112` llama a `MCPAR03/21` con
las capas habilitadas al invertir las partidas.

### Prueba nativa de un traspaso PEPS global

El 24 de noviembre de 2026, el usuario de pruebas **SISTEMAS** en México
registró en German el folio `TR0005` (`FDOC.DSEQ=346526`, fecha 31/12/2025)
por una unidad del producto `01511263` del almacén 01 al 12. Después
canceló ese folio desde **Inventarios → Documentos → Cancelar**.

| Momento | Existencias 01 | Existencias 12 | Capas PEPS globales |
| --- | ---: | ---: | --- |
| Antes | 5 | 0 | 17836: 5 unidades |
| Alta | 4 | 1 | 17836: 5 unidades |
| Cancelación | 5 | 0 | 17836: 4 unidades, 18118: 1 unidad |

La entrada de la reversión creó la capa `18118` con `LODOC='TR0005'`,
`LOALM='12'` y costo unitario de 159.4801. La salida consumió una unidad
de la capa anterior `17836` de `RA09139`. Los dos renglones de
`FAXINV` quedaron con tipo `K`, cantidad y costo cero, y referencias a
las capas `18118` (almacén de la partida 01) y `17836` (partida 12).
El total del producto y el saldo global de las capas quedaron en cinco
unidades. El encabezado conservó `DCANCELADA=0`. El efecto de la
cancelación sobre las capas queda pendiente en la web.

Evidencia local: `tr-sistemas-antes.json`, `tr-sistemas-registrado.json`,
`tr-sistemas-cancelado.json`, `20261124-tr-sistemas-registrado.png` y
`20261124-tr-sistemas-baja-confirmada.png`. La captura previa
`20261124-native-transfer-tr-user-blocked.png` registra el rechazo de
`TR` al probar con el perfil anterior.

La prueba web en PostgreSQL movió dos unidades del almacén 01 al 12
mediante `TRW00000017`. Una salida de una unidad desde el 12 usó la capa
histórica del producto y bloqueó la cancelación del TR por existencia
libre insuficiente. Después de revertir la salida, se canceló el TR y
los saldos regresaron a 5 y 0 con la misma cola PEPS.
