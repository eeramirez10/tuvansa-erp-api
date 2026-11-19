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
| Clasificar | `/:productId/actions/classifications` | `finv.IFAM`, `IFAM1..9`; OMNIS consulta `ffam` por niveles |
| Descr. ext. | `/:productId/actions/extended-description` | `finv2` |
| % Descuentos clis | `/:productId/actions/discounts/customers` | `fdesctos.DESKEY2` por prefijo de producto |
| % Descuentos prv | `/:productId/actions/discounts/suppliers` | `fdesctos.DESKEY2` por prefijo de producto |
| Otros | `/:productId/actions/other-data` | Campos adicionales de `finv` |
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
| Clasificar | Selector doble de familias con bloque SELECCIONADOS |
| Descr. ext. | Cuatro bloques de descripción y botón Cambiar |
| % Descuentos clis/prv | Filtros superiores, tabla de descuentos y scroll XY |
| Otros | Formulario vertical por secciones de empaque, opciones, precios, importación y producción |
| Especificaciones | Lista vertical de descripciones y botón Cambiar |
| Foto | Visor con modos Normal, Boceto, Boceto 2, Color y Completo |
| Inv. CT | Matriz por almacén y selector visual de Stock/Pedido/Disponible/etc. |
| Precios | Costo y listas 1..13 con moneda y plan POS |
| SKUs | Tabla L/SKU y botones Cancelar/Aceptar |
| Prepacks | Matriz horizontal, código del producto y botones OK/Cancelar/Reparte |

### Presentación de las ventanas de Compras/Prod

| Botón | Ventana OMNIS reproducida |
| --- | --- |
| Alternos | Cabecera del producto, tabla Código/Descripción/Stock/Precio 1 y navegación inferior |
| Componentes | Cabecera con lote y unidad, filtros, tabla XY de componentes, totales y comandos inferiores |
| Especific. Cal | Selector lateral y matriz de 15 pruebas con mínimo, máximo, unidad y observaciones |
| Implosión | Cabecera del componente, productos padre, cantidad, porcentaje de costo y navegación |
| Lotes | Dos paneles: lotes disponibles y movimientos de entradas/salidas, con totales separados |
| UEPS / PEPS | Capas de inventario con cantidad inicial, costo, advalorem, documento, lote, caducidad y llave |

## Consultas

| Boton OMNIS | Endpoint GET | Origen confirmado | Procedimiento → ventana |
| --- | --- | --- | --- |
| Auxiliar | `/:productId/queries/ledger` | `faxinv`, `fdoc`, `flotes` | `EINV#8/1` → `EINV#10` |
| Pedidos por cliente | `/:productId/queries/customer-orders` | `fplin`, `finv`, `fpenc`, `fcli`; `PESPEDIDO=1`, `PEMULTICIA=1` | `EINV#8/2` → `EINV#7` |
| Pedidos por cliente `*` | `/:productId/queries/customer-orders/star` | `fplin`, `finv`, `fpenc`, `fcli.CLIPAR1..9` y `fag` al elegir clasificador | `EINV#8/3` → `EINV#7A` |
| Pedidos por cliente `CT` | `/:productId/queries/customer-orders/ct` | Rango de `finv.ICOD` según `FCIA.CIARAIZ`, con `FPLIN` agrupada por pedido | `EINV#8/4` → `EINV#7AA` |
| Cotizaciones por cliente | `/:productId/queries/customer-quotes` | `fplin`, `fpenc`, `fcli`; `PESPEDIDO=4` | `EINV#8/5` → `EINV#47` |
| Ventas por cliente | `/:productId/queries/customer-sales` | `faxinv`, `fdoc`, `fcli` | `EINV#8/6` → `EINV#6` |
| Ventas por cliente `*` | `/:productId/queries/customer-sales/star` | Acumulados de `finv` usados por OMNIS | `EINV#8/7` → `EINV#6BA` |
| Ventas por cliente `CT` | `/:productId/queries/customer-sales/ct` | Rango de `finv.ICOD` | `EINV#8/8` → `EINV#6AA` |
| Ventas desglosadas | `/:productId/queries/customer-sales/detail` | `faxinv`, `fdoc`, `fcli` | `EINV#8/9` → `EINV#38` |
| Ventas por sucursal | `/:productId/queries/sales/by-branch` | `faxinv.AISUCURSAL` | `EINV#8/10` → `EINV#30` |
| Ventas anuales | `/:productId/queries/sales/annual` | `faxinv`, `fdoc`, `fcli` | `EINV#8/11` → `EINV2#2` |
| Ventas anuales resumen | `/:productId/queries/sales/annual-summary` | `faxinv`, `fdoc` | `EINV#8/12` → `EINV2#20` |
| Ordenado a proveedor | `/:productId/queries/supplier-orders` | `fplin`, `fpenc`, `fprv`; `PESPEDIDO IN (2,3)` | `EINV#8/13` → `EINV#12` |
| Ordenado a proveedor `CT` | `/:productId/queries/supplier-orders/ct` | Rango de `finv.ICOD` | `EINV#8/14` → `EINV#12A` |
| Cotizado a proveedores | `/:productId/queries/supplier-quotes` | `fplin`, `fpenc`, `fprv`; `PESPEDIDO=5` | `EINV#8/15` → `EINV#12B` |
| Compras por proveedor | `/:productId/queries/supplier-purchases` | `faxinv`, `fdoc`, `fprv` | `EINV#8/16` → `EINV#5` |
| Compras por proveedor `DT` | `/:productId/queries/supplier-purchases/dt` | `fplin`, `fpenc`, `fprv` por rango | `EINV#8/17` → `EINV#50` |
| Compras desglosadas | `/:productId/queries/supplier-purchases/detail` | `faxinv`, `fdoc`, `fprv` | `EINV#8/18` → `EINV#39` |
| Compras anuales | `/:productId/queries/purchases/annual` | `faxinv`, `fdoc`, `fprv` | `EINV#8/19` → `EINV2#4` |
| Compras anuales resumen | `/:productId/queries/purchases/annual-summary` | `faxinv`, `fdoc` | `EINV#8/27` → `EINV2#21` |
| Piezas | `/:productId/queries/pieces` | No disponible: esta version no incluye PIEZAS | `EINV#8/20` → `EINV#28` |
| Piezas surtidas | `/:productId/queries/pieces/fulfilled` | `fcajas` | `EINV#8/21` → `EINV#28A` |
| W.I.P. | `/:productId/queries/work-in-progress` | `ftikets.TKTPROD` | `EINV#8/22` → `EINV#42` |
| W.I.P. `CT` | `/:productId/queries/work-in-progress/ct` | `ftikets` por rango de producto | `EINV#8/23` → `EINV#42A` |
| E.D.I. | `/:productId/queries/edi` | `fvsucursal`, `fedi`, `fcli` | `EINV#8/24` → `EINV#44` |
| Habilitaciones pendientes | `/:productId/queries/pending-enablements` | `faxinv`, `fdoc`; `DPAR9 IN ('9NVO','9HAB')` | `EINV#8/25` → `EINV#51` |
| Documentos | `/:productId/queries/documents` | No disponible: reutilizo el ultimo documento sin filtro de producto | `EINV#8/26` → `EINV#24` |

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
