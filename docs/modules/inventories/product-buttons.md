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

## Consultas

| Boton OMNIS | Endpoint GET | Origen confirmado |
| --- | --- | --- |
| Auxiliar | `/:productId/queries/ledger` | `faxinv`, `fdoc`, `flotes` |
| Pedidos por cliente | `/:productId/queries/customer-orders` | `fplin`, `fpenc`, `fcli`; `PESPEDIDO=1` |
| Pedidos por cliente `*` | `/:productId/queries/customer-orders/star` | Acumulados de `finv` usados por OMNIS |
| Pedidos por cliente `CT` | `/:productId/queries/customer-orders/ct` | Rango de `finv.ICOD` |
| Cotizaciones por cliente | `/:productId/queries/customer-quotes` | `fplin`, `fpenc`, `fcli`; `PESPEDIDO=4` |
| Ventas por cliente | `/:productId/queries/customer-sales` | `faxinv`, `fdoc`, `fcli` |
| Ventas por cliente `*` | `/:productId/queries/customer-sales/star` | Acumulados de `finv` usados por OMNIS |
| Ventas por cliente `CT` | `/:productId/queries/customer-sales/ct` | Rango de `finv.ICOD` |
| Ventas desglosadas | `/:productId/queries/customer-sales/detail` | `faxinv`, `fdoc`, `fcli` |
| Ventas por sucursal | `/:productId/queries/sales/by-branch` | `faxinv.AISUCURSAL` |
| Ventas anuales | `/:productId/queries/sales/annual` | `faxinv`, `fdoc`, `fcli` |
| Ventas anuales resumen | `/:productId/queries/sales/annual-summary` | `faxinv`, `fdoc` |
| Ordenado a proveedor | `/:productId/queries/supplier-orders` | `fplin`, `fpenc`, `fprv`; `PESPEDIDO IN (2,3)` |
| Ordenado a proveedor `CT` | `/:productId/queries/supplier-orders/ct` | Rango de `finv.ICOD` |
| Cotizado a proveedores | `/:productId/queries/supplier-quotes` | `fplin`, `fpenc`, `fprv`; `PESPEDIDO=5` |
| Compras por proveedor | `/:productId/queries/supplier-purchases` | `faxinv`, `fdoc`, `fprv` |
| Compras por proveedor `DT` | `/:productId/queries/supplier-purchases/dt` | `fplin`, `fpenc`, `fprv` por rango |
| Compras desglosadas | `/:productId/queries/supplier-purchases/detail` | `faxinv`, `fdoc`, `fprv` |
| Compras anuales | `/:productId/queries/purchases/annual` | `faxinv`, `fdoc`, `fprv` |
| Compras anuales resumen | `/:productId/queries/purchases/annual-summary` | `faxinv`, `fdoc` |
| Piezas | `/:productId/queries/pieces` | No disponible: esta version no incluye PIEZAS |
| Piezas surtidas | `/:productId/queries/pieces/fulfilled` | `fcajas` |
| W.I.P. | `/:productId/queries/work-in-progress` | `ftikets.TKTPROD` |
| W.I.P. `CT` | `/:productId/queries/work-in-progress/ct` | `ftikets` por rango de producto |
| E.D.I. | `/:productId/queries/edi` | `fvsucursal`, `fedi`, `fcli` |
| Habilitaciones pendientes | `/:productId/queries/pending-enablements` | `faxinv`, `fdoc`; `DPAR9 IN ('9NVO','9HAB')` |
| Documentos | `/:productId/queries/documents` | No disponible: reutilizo el ultimo documento sin filtro de producto |

## Evidencia y adaptacion

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
