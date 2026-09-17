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
- Para editar, el pedido no debe estar autorizado. La ventana `Cambio de pedido` expone sólo las partidas.
- `Cotiz` funciona en ambos sentidos y mueve acumulados entre pedido y cotización.
- El precio bajo costo se valida en la aplicación con los datos del producto ya cargados; el marcador de advertencia no emitió SQL.

## Endpoints relacionados

| Comportamiento | Endpoint actual o propuesto | Estado después de la captura |
| --- | --- | --- |
| Estado de autorización | GET `/api/sales/orders/:orderId/actions/authorize` | Existe; debe corregir el booleano para usar `PEPAR9` |
| Autorizar / desautorizar | POST `/api/sales/orders/:orderId/actions/authorization` | Propuesto; persistencia PostgreSQL/Neon |
| Consultar asignación | GET `/api/sales/orders/:orderId/actions/assign-all` | Existe |
| Asignar / desasignar | POST `/api/sales/orders/:orderId/actions/assignment` | Propuesto; persistencia PostgreSQL/Neon |
| Cambiar partidas | PATCH `/api/sales/orders/:orderId` | Existe; debe aplicar bloqueo por `PEPAR9='O.K.'` |
| Alternar Pedido/Cotización | POST `/api/sales/orders/:orderId/actions/quote-conversion` | Existe; sólo cubre 4 → 1 y debe alinearse con la alternancia observada |

Las futuras consultas adaptadas deben conservar tablas, filtros y significado de la captura, usar parámetros y evitar los `SELECT *` de OMNIS. No se implementó ningún cambio HTTP en esta captura.
