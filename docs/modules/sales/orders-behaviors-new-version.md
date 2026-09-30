# Pedidos: reglas verificadas en la versión nueva

Captura controlada del 2026-09-17 sobre la copia aislada de pruebas. Se creó `P021066` para el cliente `000001` con el producto `01300938`. La evidencia cruda permanece bajo `captures/sql/new-version/sales/orders-behaviors-20260917-135248/`; no se versiona.

| Vista / acción visible | Marcador | Resultado confirmado | Tablas funcionales | Procedencia |
| --- | --- | --- | --- | --- |
| Captura / Cliente + Tab | `ORDERS_CUSTOMER_MATCHES_00000` | Abre coincidencias por rango de código | FCLI, FTIPMV | Capturada |
| Captura / Producto | `ORDERS_PRODUCT_01300938` | Carga inventario, extensión y almacén | FINV, FINV2, FALM | Capturada |
| Captura / Precio menor al costo | `ORDERS_PRODUCT_01300938_PRICE_BELOW_COST` | Bloquea localmente; no emite SQL durante la advertencia | Ninguna nueva | Capturada: 0 sentencias |
| Pedidos / Cotiz | `ORDERS_COTIZ_WHEN_ORDER` | Alterna Pedido (1) → Cotización (4) | FPENC, FALM, FINV | Capturada |
| Pedidos / Cotiz | `ORDERS_COTIZ_RESTORE_ORDER` | Alterna Cotización (4) → Pedido (1) | FPENC, FALM, FINV | Capturada |
| Pedidos / Ctrl+A | `ORDERS_AUTHORIZE_CTRL_A` | Autoriza y muestra `O.K.` | FPENC, FCOMENT | Capturada |
| Pedidos / Ctrl+P | `ORDERS_ASSIGN_AUTHORIZED_BLOCKED_CTRL_P` | Sólo abre la asignación cuando el pedido está autorizado | FUSERS, FPENC, FCLI, FPLIN, FINV, FCIA | Capturada |
| Asignación / OK | `ORDERS_ASSIGN_AUTHORIZED_AMOUNT_1` | Ajusta partida, almacén, inventario y encabezado | FPLIN, FALM, FINV, FPENC | Capturada |
| Pedidos / Ctrl+A asignado | `ORDERS_DEAUTHORIZE_CTRL_A` | Bloquea la desautorización | FUSERS | Capturada |
| Pedidos / Editar autorizado | `ORDERS_EDIT_AUTHORIZED_ICON` | Bloquea la edición | FUSERS; FSES sólo por mantenimiento de sesión | Capturada |
| Cambio de pedido / OK | `ORDERS_EDIT_LINE_SAVE_OK_COMMITTED` | Edita partidas y recalcula acumulados/totales | FPLIN, FALM, FINV, FPENC, FCOMENT | Capturada |
| Pedidos / Ctrl+P no autorizado | `ORDERS_ASSIGN_UNAUTHORIZED_OPEN_CTRL_P` | Bloquea antes de consultar MySQL | Ninguna | Capturada: 0 sentencias |

## Reglas que debe reproducir la API

- La autorización visible se representa con `FPENC.PEPAR9='O.K.'`. `PEUSRAUT` conserva el usuario incluso después de desautorizar, por lo que no sirve por sí solo como booleano.
- Para asignar, el pedido debe estar autorizado.
- Para desautorizar, el pedido no debe tener cantidades asignadas.
- Para editar, el pedido no debe estar autorizado. La ventana `Cambio de pedido` expone sólo el detalle y permite agregar productos, cambiar código, cantidad, precio o descuento, y eliminar renglones. El PATCH recibe el detalle final completo y Neon conserva una nueva revisión. El servidor vuelve a bloquear pedidos autorizados, asignados, surtidos o facturados.
- `Cotiz` funciona en ambos sentidos y mueve acumulados entre pedido y cotización.
- El precio bajo costo se valida en la aplicación con los datos del producto ya cargados; el marcador de advertencia no emitió SQL.

## Endpoints relacionados

| Comportamiento | Endpoint actual o propuesto | Estado después de la captura |
| --- | --- | --- |
| Estado de autorización | GET `/api/sales/orders/:orderId/actions/authorize` | Implementado; usa `PEPAR9` en la lectura legacy |
| Autorizar / desautorizar | POST `/api/sales/orders/:orderId/actions/authorization` | Implementado en PostgreSQL/Neon |
| Consultar asignación | GET `/api/sales/orders/:orderId/actions/assign-all` | Existe |
| Asignar / desasignar | POST `/api/sales/orders/:orderId/actions/assignment` | Implementado en PostgreSQL/Neon |
| Cambiar partidas | PATCH `/api/sales/orders/:orderId` | Implementado; reemplaza el detalle completo y bloquea pedidos con `O.K.` |
| Alternar Pedido/Cotización | POST `/api/sales/orders/:orderId/actions/quote-conversion` | Implementado en ambos sentidos |

La búsqueda de coincidencias usa SQL adaptado y parametrizado sobre FCLI. Las escrituras nuevas son derivadas y se guardan exclusivamente en PostgreSQL/Neon; no escriben MySQL.

## Corrección del almacén México (2026-09-30)

La inspección de lectura del respaldo de la API confirmó FALMCAT.CATALM=01 para SUC. MEXICO y encabezados FPENC.PEALMACEN con ambos formatos, 01 y 1. La comparación estricta rechazaba esos pedidos al cargar un producto. Se normaliza exclusivamente 1 a 01 (quitando espacios exteriores); otros almacenes y códigos vacíos conservan su validación.

| Vista / botón | Endpoint | Evidencia / procedencia | Tablas |
| --- | --- | --- | --- |
| Pedido / capturar código o IEAN | GET /api/sales/orders/capture/products/:code | Consultas adaptadas existentes; normalización derivada, sin nueva captura OMNIS | FALMCAT, FINV, FALM, FTIPMV, FDESCTOS |
| Encuentra producto / buscar | GET /api/sales/orders/capture/products | Consulta derivada existente, filtro ALMNUM=01 | FALMCAT, FINV, FALM |
| Pedido / guardar o editar detalle | POST /api/sales/orders/capture, PATCH /api/sales/orders/:id | Persistencia derivada en PostgreSQL; código canónico en documento y diferencias de inventario | tuvansa.orders, tuvansa.order_stock_deltas, tuvansa.order_changes |

Los DTO de pedidos heredados/locales muestran 01; los documentos base conservan el respaldo original. Al calcular diferencias de inventario se normalizan ambos lados para evitar separar México en dos almacenes. No se actualizó el respaldo MySQL ni se activó general_log; la comprobación de lectura devolvió OFF.

Validación: regresiones de carga por código/IEAN, búsqueda, rechazo de otros almacenes, alta y edición de documentos con 1, y cálculo de diferencias en PostgreSQL embebido, sin escribir en MySQL ni Neon.

Comprobación directa de sólo lectura: 01300938 retorna el mismo producto y disponibilidad con almacén 1 y 01; IEAN tsc480 resuelve a 01300938; las coincidencias por código corresponden a 01 y un encabezado heredado con 1 se entrega como 01. general_log permaneció OFF. Backend: pnpm lint, pnpm build y pnpm test (102 pruebas) correctos; frontend: pnpm lint, pnpm typecheck y pnpm build correctos.

## Coincidencias de productos y búsqueda durante la edición (2026-09-30)

Requisito funcional del usuario: Captura de pedido y Cambio de pedido muestran sugerencias al escribir un prefijo de código/IEAN. Un identificador sin resolución o con varias coincidencias abre Encuentra producto. Sus filtros son Código / IEAN, Descripción y Cod Prv; doble clic u OK seleccionan, recargan las referencias y agregan o sustituyen la partida en el borrador. Si no había cantidad, se usa 1; una cantidad ya capturada se conserva. No se guarda el pedido hasta el OK final.

| Vista | Control / acción | Marcador | Procedencia | Endpoint | Tablas |
| --- | --- | --- | --- | --- | --- |
| Captura de pedido / Cambio de pedido | Código / IEAN; sugerencias al escribir | Sin nueva captura OMNIS; requisito del usuario | Derivada | GET /api/sales/orders/capture/products?warehouse=...&code=... | FINV, FALM |
| Encuentra producto | Buscar por código / IEAN o descripción | Sin nueva captura OMNIS | Derivada | GET /api/sales/orders/capture/products | FINV, FALM |
| Encuentra producto | Doble clic / OK | Lectura existente; sin nuevo marcador | Adaptada; comparación sin mayúsculas derivada | GET /api/sales/orders/capture/products/:identifier | FINV, FALM, FTIPMV, FDESCTOS |

La restricción de alta limitada a México no se aplica a estas lecturas: el filtro FALM.ALMNUM y la clave ALMKEY siguen usando el almacén del pedido, sin reemplazar un almacén diferente por 01. La equivalencia 1/01 se conserva. No se amplían las opciones de almacén para pedidos nuevos. Si el producto no tiene registro de inventario en el almacén activo, el endpoint devuelve 404 y la UI abre el buscador. Almacenes vacíos siguen siendo errores HTTP 400. No se suprimen errores de conexión ni errores comerciales al recargar un resultado seleccionado.

Código, IEAN y descripción se comparan sin distinguir mayúsculas en la búsqueda parametrizada. Esta mejora es derivada y no se presenta como SQL literal de OMNIS. La validación de costo en la moneda correspondiente (listas 5/6 y conversión con T.C.) permanece en UI y backend.

Validación de sólo lectura del catálogo real: tsc480/TSC480 devuelven las mismas coincidencias en 01, el prefijo 01300 devuelve múltiples productos de México, y tsc480 resuelve 01300938. general_log=OFF. No se modificó MySQL ni Neon.

Prueba local en Chromium con respuestas HTTP simuladas: entrada directa a /pedidos/10, sugerencias en ambas ventanas, navegación con flechas/Enter, apertura del buscador para código inexistente, búsqueda por descripción y por IEAN, doble clic que agrega al borrador, Tab que agrega y vuelve a Código, y bloqueo de precio bajo costo. Se verificó que las solicitudes de producto usaran 01 para el encabezado heredado con 1 y que no hubiera solicitudes de escritura. Evidencia local excluida de Git: captures/ui/new-version/order-product-suggestions/.

Comprobaciones finales: pnpm lint, pnpm build y pnpm test del backend (101 pruebas), pnpm lint, pnpm typecheck y pnpm build del frontend, y prueba en Chromium con respuestas simuladas; todas correctas.
