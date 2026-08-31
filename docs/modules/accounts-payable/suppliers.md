# Cuentas por pagar — Catálogo de proveedores

Módulo de solo lectura reconstruido desde la ventana **Cuentas x Pagar / Catálogo de proveedores** de OMNIS 7.

## Pantalla principal y barra

| Elemento OMNIS | Endpoint |
| --- | --- |
| Abrir catálogo / primer registro | `GET /api/accounts-payable/suppliers/first` |
| Flecha izquierda | `GET /api/accounts-payable/suppliers/:supplierId/previous` |
| Buscador | `GET /api/accounts-payable/suppliers?q=...&status=all` |
| Flecha derecha | `GET /api/accounts-payable/suppliers/:supplierId/next` |
| Ficha del proveedor | `GET /api/accounts-payable/suppliers/:supplierId` |

La consulta inicial observada en OMNIS carga los identificadores con `SELECT PRVSEQ FROM FPRV ORDER BY PRVCOD, PRVSEQ` y después lee la ficha completa de `FPRV`. La API conserva ese orden y usa `PRVSEQ` como identificador estable.

## Acciones

| Botón OMNIS | Endpoint GET | Fuente real |
| --- | --- | --- |
| Bloquear | `/:id/actions/block-status` | `FPRV.PRVBAJA` (estado solamente; no modifica) |
| Clasificar | `/:id/actions/classifications?position=1..9` | `FPRV.PRVPAR1..9` y opciones de `FAG` por `AGT` |
| % Descuentos | `/:id/actions/discounts` | `FPRV.PRVDESC1`, `FPRV.PRVDESC2` |
| Eventos | `/:id/actions/events` | `FEVENTOS` por `PRVSEQ` |
| Varios | `/:id/actions/various` | campos bancarios, fiscales y varios ya almacenados en `FPRV` |
| Contactos | `/:id/actions/contacts` | `FCONTACTOS` por `CONTKEY = PRVCOD` |

`Foto` se omitió por decisión del proyecto. Los controles de alta, baja y cambio que aparecen dentro de las ventanas se muestran deshabilitados en el frontend porque esta fase es GET.

## Consultas

| Botón OMNIS | Endpoint GET | Tablas principales / filtros capturados |
| --- | --- | --- |
| Saldo | `/:id/balance` | `FDOC`, `DEST=0`, `DMULTICIA=1`, `DESCXC=2` |
| Movimientos | `/:id/movements` | `FAX + FDOC`, `AMES=1`, `DEST=0`, `DMULTICIA=1` |
| Facturas | `/:id/invoices` | `FDOC`, `DESFACT IN (2,3)`, `DEST=0` |
| Productos ordenados CT | `/:id/products/ordered` | `FPLIN + FINV + FPENC`, `PESPEDIDO<>5` |
| Fill · Rate | `/:id/fill-rate` | `FPENC` por proveedor |
| Productos cotizados | `/:id/products/quoted` | `FPLIN + FINV + FPENC`, `PESPEDIDO=5` |
| Productos comprados CT | `/:id/products/purchased` | `FAXINV + FINV + FDOC`, agrupado por producto |
| Productos comprados desg. | `/:id/products/purchased-detail` | `FAXINV + FINV + FDOC` |
| Historial de precios | `/:id/products/price-history` | `FAXINV + FINV + FDOC`, `AICANTF>1` |
| Gastos comprados | `/:id/expenses/purchased` | `FBANMOV + FBENC` |
| Compras anuales | `/:id/purchases/annual` | `FAXINV + FDOC + FINV`, agrupado por producto/año/mes |
| Compras anuales resumen | `/:id/purchases/annual-summary` | `FDOC`, compras netas agrupadas por año/mes |
| W.I.P. CT | `/:id/work-in-progress` | OMNIS abrió la tabla sin emitir SQL para el caso capturado; la API lo documenta y devuelve lista vacía |

Todas las rutas anteriores se montan bajo `/api/accounts-payable/suppliers`.

## Correspondencia visual

- La ficha conserva los bloques **Catálogo de proveedores**, **Condiciones** y **Acumulados**.
- Acciones queda a la izquierda y Consultas a la derecha, como en OMNIS.
- Los modales usan tablas compactas, scroll XY, totales y la misma fila de botones inferiores. Esos botones internos permanecen deshabilitados hasta abordar sus operaciones específicas.
- La base usada por OMNIS durante la captura era de pruebas; la API se ejecuta contra la conexión configurada en `.env`.
