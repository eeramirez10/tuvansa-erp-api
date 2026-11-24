# Botones laterales de Inventarios PT

Captura realizada el 26 de agosto de 2026 sobre la copia local de pruebas con
el producto `004212899` (`finv.ISEQ = 47087`). Todos los endpoints reciben
`page` y `pageSize` y devuelven el producto, boton visible, disponibilidad,
origen, registros y paginacion.

## Acciones

| Boton OMNIS | Endpoint GET | Origen confirmado |
| --- | --- | --- |
| Almacenes | `/:productId/actions/warehouses` | `falm`, `falmcat` |
| Alta CT | `/:productId/actions/color-size-registration` | No disponible: esta version no incluye Color y Talla |
| Bloquear | GET/PATCH `/:productId/actions/block-status` | `finv.IBAJA`, `IUSEQ`, `IFECHACAMBIO` |
| Clasificar | GET/PATCH `/:productId/actions/classifications` | `FINV`, `FFAM`, `FYG`, `FCIA` para lectura. PostgreSQL para los cambios del piloto. |
| Descr. ext. | `/:productId/actions/extended-description` | `finv2` |
| % Descuentos clis | `/:productId/actions/discounts/customers` | `fdesctos.DESKEY2` por prefijo de producto |
| % Descuentos prv | `/:productId/actions/discounts/suppliers` | `fdesctos.DESKEY2` por prefijo de producto |
| Otros | GET/PATCH `/:productId/actions/other-data` | `FINV`, `FALMCAT` y `FCIA` para lectura. PostgreSQL para los cambios del piloto. |
| Especificaciones | `/:productId/actions/specifications` | `finv2` |
| Foto | `/:productId/actions/photo` | No hubo consulta MySQL para el contenido |
| Inv. CT | `/:productId/actions/ct-inventory` | `falm` |
| Precios | `/:productId/actions/prices` | Listas, monedas y planes POS de `finv` |
| SKUs | `/:productId/actions/skus` | `fskus` |
| Prepacks | `/:productId/actions/prepacks` | `finv.IPREPACK` cargado en la ficha |

## Compras/Prod

| Boton OMNIS | Endpoint GET | Origen confirmado |
| --- | --- | --- |
| Alternos | `/:productId/purchases-production/alternates` | `falternos.ALTPROD = finv.ICOD` |
| Componentes | `/:productId/purchases-production/components` | `fens.EPRO = finv.ICOD` |
| Especific. Cal | `/:productId/purchases-production/quality-specifications` | `fpruebas.ISEQ` |
| Implosion | `/:productId/purchases-production/implosion` | `fens.EART = finv.ICOD` |
| Lotes | `/:productId/purchases-production/lots` | `flotes.ISEQ` |
| UEPS / PEPS | `/:productId/purchases-production/inventory-layers` | `flotes.ISEQ` |

### Presentación de las ventanas de Acciones

| Botón | Ventana OMNIS reproducida |
| --- | --- |
| Almacenes | Tabla horizontal por almacén, fila TOTAL, scroll XY y controles de localización/mínimos |
| Alta CT | Aviso literal del módulo Color y Talla no incluido |
| Bloquear | Confirmación No/Yes y cambio real de `finv.IBAJA` mediante PATCH |
| Clasificar | Selección de parámetros con dos listas, filtro por familia anterior, transferencia y Guardar |
| Descr. ext. | Cuatro bloques de descripción y botón Cambiar |
| % Descuentos clis/prv | Filtros superiores, tabla de descuentos y scroll XY |
| Otros | Cambio, OK y Cancelar con secciones de empaque, opciones, precios, importación, producción, compras y varios |
| Especificaciones | Lista vertical de descripciones y botón Cambiar |
| Foto | Visor con modos Normal, Boceto, Boceto 2, Color y Completo |
| Inv. CT | Matriz por almacén y selector visual de Stock/Pedido/Disponible/etc. |
| Precios | Costo y listas 1..13 con moneda y plan POS |
| SKUs | Tabla L/SKU y botones Cancelar/Aceptar |
| Prepacks | Matriz horizontal, código del producto y botones OK/Cancelar/Reparte |

### Clasificar

El botón **Acciones → Clasificar** llama a `EINV#1/53`, que abre
`EINV#25C`. `MBASE/92` lee los títulos de `FYG.ABITITFAM1`. Cuando esa
entrada falta, recurre a `FCIA.CIAFAMPAR1..9` para las primeras categorías.
`EINV#25C/240` arma las filas por posición (1–9 y A–K) con los valores
`FINV.IFAM<posición>` y busca cada código completo en `FFAM.FAMTNUM`.
La ventana muestra `FAMNUM` como código corto.

La lista derecha abre vacía. Al seleccionar una categoría, `EINV#25C/242`
consulta las opciones de `FFAM.FAMT`. A partir de la segunda fila acepta
opciones con `FAMPADRE` vacío o igual al código corto de la fila anterior.
La flecha y el doble clic llaman a `/230`, que pasan la opción al borrador
sin cambiar las demás filas. **Guardar** ejecuta `/17` y cierra la ventana.
`IFAM` se deriva de los códigos de los parámetros 1–9 cuando está activo
el comportamiento 79 o se usa Shift al guardar. El comportamiento 79
está activo en el origen configurado para TUVANSA.

En Omnis 7, con `004212899` en la base local de pruebas, se recorrieron
las trece categorías visibles. **Sucursal** pasó de `04` a `01` con la
flecha y el cambio persistió al reabrir. **Material** pasó de `A01` a `A02`
con doble clic. Después de guardar, **Familia** pasó de `CONRBUA0114009` a
`CONRBUA0214009`. Se restauraron `04` y `A01` con su familia original.
La lectura del catálogo se apoya en el marcador histórico
[INV_ACTION_CLASIFICAR](product-buttons-capture.md#inv_action_clasificar).
La escritura de la API en PostgreSQL se deriva de los procedimientos de
Omnis y de la prueba funcional.

El GET entrega `data.classification` con la revisión, la familia compuesta,
los grupos, sus opciones y la disponibilidad de Guardar. PATCH recibe la
revisión leída y un objeto `changes` con códigos completos `FAMTNUM` por
grupo. Una revisión desactualizada devuelve `409`. Para habilitar Guardar
en el ambiente de pruebas, aplica la migración de Clasificar y configura
`INVENTORY_CLASSIFICATION_PILOT_PRODUCTS` con los ID autorizados para el
piloto. La API usa PostgreSQL para esos cambios y refleja la familia
compuesta en el detalle del catálogo.

```powershell
pnpm exec tsx scripts/migrate-postgres-inventory-classifications.ts
```

### Otros

**Acciones → Otros** entra por `EINV#1/57` y abre `EINV2#1` en TUVANSA.
La ventana muestra **Dimensiones y empaque**, **Opciones Varias**, **Precios**,
**Datos de importación**, **Datos de producción**, **Información de compras**
y **Varios**. El diseño identifica los campos editables, sus decimales y
controles de sólo lectura. Los grupos de radio comparten un campo y guardan
su posición desde cero. [Referencia de controles de Omnis](https://www.omnis.net/developers/resources/onlinedocs/Programming/11wincomps.html#radio-groups-and-buttons)

**Cambio** entra por `EINV2#1/145`. `/240` carga los aranceles de `FALMCAT`
con `CATTIPO='ARA'`. `/100` copia el código elegido al arancel y toma el
porcentaje entre `*` y `%` en la descripción, cuando está presente. El
catálogo de aranceles de TUVANSA consultado está vacío. El campo Arancel
permite la captura manual.

`EINV2#1/401` toma una copia de los campos editables con `MBASE/146`.
**OK** obtiene los cambios con `MBASE/148` y actualiza `FINV` mediante
`MBASE/69`. El procedimiento registra fecha y usuario. La API usa la
fecha de la escritura en PostgreSQL y conserva el último usuario del
origen mientras la sesión web carezca de un operador de Omnis asociado.
La Lista 6 se deriva de precio de compra / factor si está activo el
comportamiento 56 y el factor es distinto de cero. El comportamiento 56
está apagado en el origen de TUVANSA revisado.

**Cancelar** vuelve a cargar el producto y deja la ventana abierta en
consulta. En la prueba con `004212899`, Omnis convirtió `prueba-otros` en
`PRUEBA-OTROS` en Localización y restauró el valor original al cancelar.
El marcador histórico [INV_ACTION_OTROS_RETRY](product-buttons-capture.md#inv_action_otros_retry)
registra la apertura. El guardado en PostgreSQL se deriva del diseño y el
código de los procedimientos.

GET entrega `data.otherData` con los valores, los campos editables y la
revisión. PATCH recibe `{ revision, changes }` y rechaza revisiones
desactualizadas con `409`. El guardado se habilita por producto mediante
`INVENTORY_OTHER_DATA_PILOT_PRODUCTS` después de aplicar la migración en
la instancia de PostgreSQL de pruebas.

```powershell
pnpm exec tsx scripts/migrate-postgres-inventory-other-data.ts
```

### Presentación de las ventanas de Compras/Prod

| Botón | Ventana OMNIS reproducida |
| --- | --- |
| Alternos | Cabecera del producto, tabla Código/Descripción/Stock/Precio 1 y navegación inferior |
| Componentes | Cabecera con lote y unidad, filtros, tabla XY de componentes, totales y comandos inferiores |
| Especific. Cal | Selector lateral y matriz de 15 pruebas con mínimo, máximo, unidad y observaciones |
| Implosión | Cabecera del componente, productos padre, cantidad, porcentaje de costo y navegación |
| Lotes | Dos paneles: lotes disponibles y movimientos de entradas/salidas, con totales separados |
| UEPS / PEPS | Capas de inventario con cantidad inicial, costo, advalorem, documento, lote, caducidad y llave |

**Lotes** consulta los movimientos de la fila seleccionada mediante el
mismo Auxiliar con `lotId`. La captura de **EINVLOTES** incluye
`FLOTES.LOSEQ` como filtro en la segunda tabla. La API usa `FAXINV.LOSEQ`
para limitar el auxiliar histórico y la identidad `lotId` de cada partida web
con el mismo criterio. El filtro se aplica antes de paginar y
`lotTotals` devuelve el conteo, entradas, salidas y neto de toda la consulta.
Las consultas de Lotes y UEPS / PEPS conservan los identificadores históricos
y muestran los saldos ajustados y las capas creadas en PostgreSQL.

## Consultas

| Boton OMNIS | Endpoint GET | Origen confirmado | Procedimiento → ventana |
| --- | --- | --- | --- |
| Auxiliar | `/:productId/queries/ledger` | `faxinv`, `fdoc`, `flotes` | `EINV#8/1` → `EINV#10` |
| Pedidos por cliente | `/:productId/queries/customer-orders` | `fplin`, `finv`, `fpenc`, `fcli`; `PESPEDIDO=1`, `PEMULTICIA=1` | `EINV#8/2` → `EINV#7` |
| Pedidos por cliente `*` | `/:productId/queries/customer-orders/star` | `fplin`, `finv`, `fpenc`, `fcli.CLIPAR1..9` y `fag` al elegir clasificador | `EINV#8/3` → `EINV#7A` |
| Pedidos por cliente `CT` | `/:productId/queries/customer-orders/ct` | Rango de `finv.ICOD` según `FCIA.CIARAIZ`, con `FPLIN` agrupada por pedido | `EINV#8/4` → `EINV#7AA` |
| Cotizaciones por cliente | `/:productId/queries/customer-quotes` | `fplin`, `fpenc`, `fcli`; `PESPEDIDO=4` | `EINV#8/5` → `EINV#47` |
| Ventas por cliente | `/:productId/queries/customer-sales` | `faxinv`, `finv`, `fdoc`, `fcli`, acumulados por `CLICOD` | `EINV#8/6` → `EINV#6` |
| Ventas por cliente `*` | `/:productId/queries/customer-sales/star` | `faxinv`, `finv`, `fdoc`, `fcli.CLIPAR1..9`, `fag` al elegir clasificador | `EINV#8/7` → `EINV#6BA` |
| Ventas por cliente `CT` | `/:productId/queries/customer-sales/ct` | Rango de `finv.ICOD` según `FCIA.CIARAIZ`, ventas agrupadas por cliente | `EINV#8/8` → `EINV#6AA` |
| Ventas desglosadas | `/:productId/queries/customer-sales/detail` | `faxinv`, `fdoc`, `fcli` | `EINV#8/9` → `EINV#38` |
| Ventas por sucursal | `/:productId/queries/sales/by-branch` | `faxinv.AISUCURSAL` | `EINV#8/10` → `EINV#30` |
| Ventas anuales | `/:productId/queries/sales/annual` | `faxinv`, `fdoc`, `fcli`, o `fvanu2` según `fcia` | `EINV#8/11` → `EINV2#2` |
| Ventas anuales resumen | `/:productId/queries/sales/annual-summary` | `faxinv`, `fdoc`, o `fvanu2` según `fcia` | `EINV#8/12` → `EINV2#20` |
| Ordenado a proveedor | `/:productId/queries/supplier-orders` | `fplin`, `fpenc`, `fprv`; `PESPEDIDO IN (2,3)` | `EINV#8/13` → `EINV#12` |
| Ordenado a proveedor `CT` | `/:productId/queries/supplier-orders/ct` | Rango de `finv.ICOD` | `EINV#8/14` → `EINV#12A` |
| Cotizado a proveedores | `/:productId/queries/supplier-quotes` | `fplin`, `fpenc`, `fprv`; `PESPEDIDO=5` | `EINV#8/15` → `EINV#12B` |
| Compras por proveedor | `/:productId/queries/supplier-purchases` | `faxinv`, `fdoc`, `fprv` | `EINV#8/16` → `EINV#5` |
| Compras por proveedor `DT` | `/:productId/queries/supplier-purchases/dt` | `fplin`, `fpenc`, `fprv` por rango | `EINV#8/17` → `EINV#50` |
| Compras desglosadas | `/:productId/queries/supplier-purchases/detail` | `faxinv`, `fdoc`, `fprv` | `EINV#8/18` → `EINV#39` |
| Compras anuales | `/:productId/queries/purchases/annual` | `faxinv`, `fdoc`, `fprv` | `EINV#8/19` → `EINV2#4` |
| Compras anuales resumen | `/:productId/queries/purchases/annual-summary` | `faxinv`, `fdoc` | `EINV#8/27` → `EINV2#21` |
| Piezas | `/:productId/queries/pieces` | No disponible: esta version no incluye PIEZAS | `EINV#8/20` → `EINV#28` |
| Piezas surtidas | `/:productId/queries/pieces/fulfilled` | `FCAJAS` con factura vinculada. **Recepción** muestra el folio de `CAJRECEPCION` | `EINV#8/21` → `EINV#28A` |
| W.I.P. | `/:productId/queries/work-in-progress` | `ftikets.TKTPROD` | `EINV#8/22` → `EINV#42` |
| W.I.P. `CT` | `/:productId/queries/work-in-progress/ct` | `ftikets` por rango de producto | `EINV#8/23` → `EINV#42A` |
| E.D.I. | `/:productId/queries/edi` | `fvsucursal`, `fedi`, `fcli` | `EINV#8/24` → `EINV#44` |
| Habilitaciones pendientes | `/:productId/queries/pending-enablements` | `faxinv`, `fdoc`; `DPAR9 IN ('9NVO','9HAB')` | `EINV#8/25` → `EINV#51` |
| Documentos | [`/api/inventories/movements`](movement-documents.md) | Búsqueda y detalle de movimientos independientes del producto | `EINV#8/26` → `EINV#24` |

## Evidencia y adaptacion

### Pedidos por cliente

`EINV#8/2` abre `EINV#7`. Su procedimiento 240 arma la búsqueda por ISEQ
y los filtros de pedidos, compañía y sesión. Después de cargar la lista
ordena por `PEDESDE`. La variante `*` abre `EINV#7A`, CT abre `EINV#7AA`
en el flujo normal y Cotizaciones abre `EINV#47`. El alcance de compañía
de las consultas normal, CT y Cotizaciones se adaptó a la sesión capturada
de México (`PEMULTICIA=1`). Véanse los SELECT de
[Pedidos](product-buttons-capture.md#L3427),
[CT](product-buttons-capture.md#L4199) y
[Cotizaciones](product-buttons-capture.md#L3453).

**Filtrar pedidos surtidos** ejecuta `EINV#7/12` y conserva únicamente las
partidas con `PLSURT < PLCANT`. El GET del panel principal admite
`excludeFulfilled=true`, aplica el filtro antes de paginar y devuelve
`data.customerOrdersTotals` con el Total (`sum(PLCANT) - sum(PLSURT)`) y el
Asignado (`sum(PLASIGNADO)`) del conjunto completo. Los cálculos de los
campos 3 a 7 del diseño de `EINV#7` confirman también que Disponible es
Stock menos Asignado y Faltante es el excedente del Total sobre Stock, con
piso de cero. El SQL agregado adapta esas fórmulas a la paginación de Tuvansa.

Los comandos inferiores tienen flujos separados. Asignar llama a
`EINVAPP/100` desde `EINV#7/8`, Traspasar sólo modifica `FPENC.PEPAR9`
en la rama `PFEIFER` de `EINV#7/11` e Imprimir formatea la lista y sus
totales en `EINV#7/495` antes de llamar a `INICIO/38`.

En la variante **Pedidos por `*`**, `EINV#7A/0` inicializa una lista vacía.
Los botones `EINV#7A/11–19` eligen `CLIPAR1..9` y el procedimiento 240
carga las partidas del producto para la compañía, incluyendo todos sus
tipos. Resuelve cada código en `FAG.AGTNUM` y ordena primero por `PEDESDE`.
El GET admite `classifier=1..9` y `sort=code|name|order|date` para los
encabezados del panel. Sus totales usan todas las partidas del resultado.
`Faltante` muestra Total menos Stock, incluido el valor negativo. Esta
adaptación procede del código de Omnis 7. La apertura capturada de
[Pedidos por `*`](product-buttons-capture.md#L4156) corresponde al estado
inicial sin consulta de partidas.

**CT** lee el largo de la raíz del producto desde `FCIA.CIARAIZ`.
`EINV#7AA/240` carga el rango de esa raíz hasta su concatenación con `z`,
y después acumula Pedido y Surtido por `PENUM` para el listado superior.
El GET agrega antes de paginar. Los controles de la matriz inferior
corresponden a `EINV#7AA/241` y requieren el desglose por color y talla
del pedido seleccionado.

**Cotizaciones por cliente** abre `EINV#47`. Su carga (`/240`) usa
`PESPEDIDO=4` y ordena la lista por `PEDESDE`. **Filtrar pedidos surtidos**
(`/13`) conserva `PLSURT < PLCANT`. El GET admite el mismo filtro antes de
paginar y agrega la lista completa de cotizaciones para el Total. El diseño
de Omnis calcula el Total desde `LLISTA`, pero vincula Asignado, Disponible
y Faltante con la lista global `#L1`. Por ello los otros valores dependen
del contexto anterior de la sesión.

### Ventana Auxiliar

La ventana visible se valido de nuevo en OMNIS con el producto `010193`. El
endpoint conserva el orden cronologico de `faxinv` y expone los campos que la
tabla presenta como `Fecha`, `Doc.`, `T.M.`, `Costo`, `Entradas`, `Salidas`,
`Stock`, `Alm`, `Lote`, `Usr` y `Reval`. `AIUSEQ` se publica como `userId` y
`faxinv.LOSEQ` como `lotId`; entradas, salidas y stock acumulado se derivan de
`AICANT` en la presentacion.

La captura literal completa esta en `product-buttons-capture.md` y el archivo
crudo local en `captures/inventory-pt-buttons-2026-08-26.log`. La API conserva
los `JOIN` y filtros funcionales observados, usa parametros enlazados, agrega
paginacion y evita consultas de configuracion o permisos ajenas al resultado.

Otros, Precios, Inv. CT, los botones `*` y Prepacks no emitieron un nuevo
`SELECT`: OMNIS uso campos ya cargados al abrir la ficha. Los endpoints consultan
esas mismas columnas y lo indican con `source: product-cache`.

### Ventas por cliente

`EINV#6/240` carga la lista por producto y excluye los documentos POS.
Después la ordena por `CLICOD` y acumula `AICANTF` y
`AICANTF * AIPRECIO` por ese código. El GET agrupa antes de paginar y
conserva el nombre de la primera línea de cada cliente en el orden del
Auxiliar. El agrupamiento SQL es una adaptación de la lista de Omnis 7.
Los encabezados de `EINV#6/5–8` ordenan por código, cliente, cantidad o
importe. El GET admite `sort=code|name|quantity|amount` y devuelve
`data.customerSalesTotals` con el total de cantidad e importe de toda
la consulta.

**Ventas por `*`** inicia con la lista vacía. `EINV#6BA/8–16` elige
`CLIPAR1..9`; su procedimiento 240 acumula los movimientos por el código
del clasificador y busca su nombre en `FAG`. En esta variante el código
conserva `AIMES=1`, estado y compañía, y utiliza todos los tipos de documento
que los cumplan. El GET deja seleccionar `classifier=1..9` y el mismo
orden que en Ventas por cliente. La consulta es adaptada del procedimiento,
diferente del filtro de la ventana normal.

**Ventas CT** usa `EINV#6AA/240`. Filtra por raíz configurada de producto,
excluye POS y acumula cantidad e importe por `CLICOD`. Su listado superior
presenta clientes. La matriz inferior es otro cálculo por color y talla
(`EINV#6AA/37`) que se carga al seleccionar el cliente.

**Ventas desglosadas** carga la lista por producto en `EINV#38/240`.
La captura literal proyecta `DTIPOC2` y `AIOTROS` por separado. En el diseño
de la ventana, el campo 19 calcula Precio US como `AIPRECIO / DTIPOC2`.
El GET presenta los dos valores como `priceUsd` y `exchangeRate`, y
devuelve `priceUsd: null` si el tipo de cambio es nulo o cero. El total
inferior suma `AICANTF` en toda la consulta.
[SQL histórico](product-buttons-capture.md#L3517)

**Ventas por sucursal** se abre desde `EINV#8/10`. `EINV#30/240`
acumula por `AISUCURSAL` y `CLICOD`, usa todos los tipos de movimiento
vigentes y ordena inicialmente por sucursal. El GET permite
`sort=branch|code|name|quantity|amount` y devuelve los totales de toda
la consulta. [SQL histórico](product-buttons-capture.md#L3555)

**Ventas anuales** y **Ventas anuales resumen** usan el procedimiento 121
de `EINV2#2` y `EINV2#20`. Según la posición 30 de `FCIA.CIACOMPORTA`,
el procedimiento 127 carga movimientos vigentes desde `CIAVANUALDEL`, o el
124 carga las cantidades mensuales de `FVANU2`. Esta última calcula el año
como `1900 + VAANO`. Ambos GET devuelven los totales mensuales y el total
global en `annualSalesDetails`. La fecha de inicio se informa sólo en el
modo de movimientos. La sesión capturada usó
[movimientos en Ventas anuales](product-buttons-capture.md#L3593) y
[movimientos en el resumen](product-buttons-capture.md#L3631).

**Ordenado a proveedor** usa `EINV#12/240`; la sesión capturada limita a la
compañía 1 y permite `PESPEDIDO=2` y `3`. El código conserva sólo tipo 2
si `CIAOTROSDESC=99` y `CIAKYT=0`. Para tipo 2, Observaciones lee
`FCOMENT.COML4` mediante `10000000 + PESEQ`. El tipo 3 tiene una referencia
separada, `LVCOMPENC + PESEQ`, pendiente de contrastar. El GET acepta
`excludeFulfilled=true`, que conserva `PLSURT < PLCANT` conforme a
`EINV#12/4`. Pedido, Surtido y Resta de cada fila se presentan divididos
entre `PLFACTOR`. Por llegar usa la suma sin convertir de toda la consulta
(`supplierOrdersTotals.remaining`) y Total la agrega al stock.
[SQL histórico](product-buttons-capture.md#L3669)

### Cambio de estado de Bloquear

`PATCH /:productId/actions/block-status` recibe `{ "blocked": true }` o
`{ "blocked": false }`. OMNIS genero literalmente:

```sql
UPDATE finv
SET IBAJA='2026-08-26', IUSEQ=0, IFECHACAMBIO='2026-08-26'
WHERE ISEQ=47087;

UPDATE finv
SET IBAJA='1900-12-31', IUSEQ=0, IFECHACAMBIO='2026-08-26'
WHERE ISEQ=47087;
```

La API sustituye la fecha literal por `CURDATE()` y usa parametros enlazados.
El segundo `UPDATE` se ejecuto para restaurar el producto de prueba.
