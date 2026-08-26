# Inventarios PT - Catalogo de productos

## Origen y alcance

- Acceso: F2 / botón **INVENTARIOS P.T.**.
- Clase principal OMNIS: `EINV#1`.
- Panel de consultas: `EINV#8`.
- Tabla principal: `finv`.
- Unidad: `funidad` mediante `finv.USEQ`.
- Llave primaria y `productId` de la API: `finv.ISEQ`.
- Producto activo: `IBAJA = '1900-12-31'`.

El alcance incluye la ficha, la barra principal y todos los botones laterales
de Acciones, Compras/Prod y Consultas, incluidos los accesos `*`, `CT` y `DT`.
La correspondencia completa esta en `product-buttons.md`.

## Endpoints

```text
GET    /api/inventories/products
POST   /api/inventories/products
GET    /api/inventories/products/:productId
GET    /api/inventories/products/:productId/previous
GET    /api/inventories/products/:productId/next
PATCH  /api/inventories/products/:productId
DELETE /api/inventories/products/:productId
```

El listado acepta `q`, `status`, `page` y `pageSize`. `q` busca por código,
descripción, EAN o UPC; `status` acepta `active`, `inactive` y `all`.

## Mapeo de la ficha

| Panel | Etiqueta OMNIS | Campo API | Columna |
| --- | --- | --- | --- |
| Catálogo | Código | `code` | `finv.ICOD` |
| Catálogo | Descripción | `description` | `finv.IDESCR` |
| Catálogo | Unidad | `classification.unit` | `finv.USEQ`, `funidad.UCOD`, `funidad.UDESCR` |
| Catálogo | Familia | `classification.familyCode` | `finv.IFAM` |
| Catálogo | M.P./P.T./Juego/Ensamble/Servicio | `classification.type` | `finv.ITIPO` |
| Catálogo | Color y talla | `classification.usesColorAndSize` | `funidad.UTIPO` |
| Catálogo | Foto | `classification.hasPhoto` | `finv.IFOTO` |
| Precios de Venta | Precio 1..3 | `prices.sale[0..2].amount` | `finv.ILISTA1..3` |
| Precios de Venta | Moneda | `prices.sale[0..2].currencyId` | `finv.IMONEDA1..3` |
| Costos | Promedio 4 | `prices.costs.average` | `finv.ILISTA4` |
| Costos | Último 5 | `prices.costs.last` | `finv.ILISTA5` |
| Costos | Anterior 6 | `prices.costs.previous` | `finv.ILISTA6` |
| Costos | Moneda | `prices.costs.currencyId` | `finv.IMONEDA` |
| Costos | Advalorem | `prices.costs.adValorem` | `finv.IADVALOREM` |
| Cuentas / Info. Almacén | Mínimo / Máximo | `warehouse.minimum`, `warehouse.maximum` | `finv.IMINIMO`, `finv.IMAXIMO` |
| Cuentas / Info. Almacén | Localización | `warehouse.location` | `finv.ILOCALIZ` |
| Cuentas / Info. Almacén | EAN / UPC | `warehouse.ean`, `warehouse.upc` | `finv.IEAN`, `finv.IUPC` |
| Cuentas / Info. Almacén | Cta. Primaria | `warehouse.accounts.primary` | `finv.ICTA` |
| Cuentas / Info. Almacén | Cta. Sec. | `warehouse.accounts.secondary` | `finv.ICTADEV` |
| Cuentas / Info. Almacén | Cta. Costo vts | `warehouse.accounts.costOfSales` | `finv.ICTA3` |
| Acumulados | Última compra / Venta | `accumulated.lastPurchaseAt`, `lastSaleAt` | `finv.IULTCPR`, `finv.IULTVTA` |
| Acumulados | Asignado / Confirmado | `accumulated.assigned`, `confirmed` | `finv.IASIGNADO`, `finv.ICONFIRMADO` |
| Acumulados | Pedido/Cot | `accumulated.customerOrders`, `customerQuotes` | `finv.IPEDCLI`, `finv.IPEDCOTIZ` |
| Acumulados | Ordenado/Cot | `accumulated.supplierOrders`, `supplierQuotes` | `finv.IPEDPRV`, `finv.IORDCOTIZ` |
| Acumulados | Stock actual / Anterior / Acumulado | `accumulated.currentStock`, `previousStock`, `accumulatedStock` | `finv.ISTKACT`, `finv.ISTKANT`, `finv.ISTKACU` |
| Acumulados | Anterior / Acumulado | `accumulated.previousQuantity`, `accumulatedQuantity` | `finv.ICANTAN`, `finv.ICANTAC` |
| Acumulados | Stk. pzas | `accumulated.pieceStock` | `finv.ISTKPZS` |
| Acumulados | Alta / Baja | `createdAt`, `deactivatedAt` | `finv.IALTA`, `finv.IBAJA` |
| Acumulados | Vta 6s / Días Inv. | `accumulated.salesLastSixMonths`, `inventoryDays` | `finv.IVTA`, `finv.IDIASSTK` |

## Arquitectura

`domain/repositories` contiene el contrato consumido por los casos de uso y
`domain/datasources` el contrato de acceso a datos. El SQL real está únicamente
en `infrastructure/datasources/legacy-mysql-products-data-source.ts`; el
repository de infraestructura sólo delega. Una futura implementación PostgreSQL
podrá reemplazar ambos adaptadores sin cambiar aplicación ni presentación.

La captura literal de la barra está en `product-toolbar-sql.md` y los requests
manuales están en `http/inventories/products.http`.

## Consultas reproducidas en frontend

Los 27 controles de **Consultas** están documentados por texto visible y
endpoint en `product-buttons.md`. Para los modales agregados, MySQL devuelve la
misma unidad visual que OMNIS: cliente, sucursal, proveedor o año/mes, según el
botón. Esto evita calcular totales sobre una página incompleta de movimientos.

El endpoint `GET /api/inventories/products/:productId/queries/documents` filtra
`faxinv` por `ISEQ` y une `fdoc`, `fcli` y `finv` para llenar la ventana
**Consulta de movimientos de inventario**. El endpoint de **Piezas** conserva
`available: false` y el mensaje literal del ERP; **Piezas surtidas** sí consulta
`fcajas`.

Las consultas aceptan `pageSize` hasta 500. El producto de verificación manual
es `01300958` (`ISEQ=13288`) porque contiene movimiento suficiente para validar
tablas, desplazamiento y totales con la base actual de desarrollo.
