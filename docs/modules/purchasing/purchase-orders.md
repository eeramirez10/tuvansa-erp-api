# Órdenes de compra

Módulo de sólo lectura capturado desde la ventana **Órdenes de compra** de OMNIS. La ruta base es:

`/api/purchasing/purchase-orders`

## Pantalla principal y barra

| Vista o botón OMNIS | Endpoint | Fuente real |
|---|---|---|
| Carga de la orden y partidas | `GET /:purchaseOrderId` | `FPENC + FPRV`, partidas `FPLIN + FINV` |
| Buscar | `GET /` | `FPENC + FPRV`, tipos `PESPEDIDO IN (2,5)` |
| Abrir por número | `GET /by-number/:number` | `FPENC + FPRV` |
| Flecha anterior | `GET /:purchaseOrderId/previous` | Orden por `PENUM` |
| Flecha siguiente | `GET /:purchaseOrderId/next` | Orden por `PENUM` |

El buscador reproduce los campos observados: **Pedido, Ped. Proveedor, Proveedor, Fecha, Vencimiento, Agente y Tipo**.

## Acciones con lectura verificada

| Botón OMNIS | Endpoint | SQL capturado/adaptado |
|---|---|---|
| Auxiliar | `GET /:id/actions/auxiliar` | `FDOC`, `DREFER=PENUM`, `DEST=0`, `DMULTICIA=1` |
| Clasificar | `GET /:id/actions/classifications` | Valores `PEPAR1..PEPAR9`; opciones `FAG`, `AGT 1..9`, `AGTIPO IN (0,2)` |
| Comentarios | `GET /:id/actions/comments` | `FCOMENT`, `COMSEQFACT=10000000+PESEQ` |

## Acciones deliberadamente sin escritura

La interfaz conserva: Alta Piezas, Autorizar, Cambia Prv, Confirmar todo, Cotiz, CT, Div. Sucursal, Duplicar, Etiquetas, Gen %, Imprimir, Imprimir Conf., Piezas, Sucursal y Split.

No se publican endpoints de mutación en esta etapa. Durante la captura se comprobó que **Comentarios** y **Cotiz** pueden ejecutar `UPDATE`/`INSERT` automáticos aun al parecer ventanas de consulta. La API evita ese comportamiento y sólo ejecuta `SELECT`.

## Diferencia conocida del legado

La biblioteca OMNIS intenta consultar `FPLIN.PLUMXXXX`, columna que no existe en la base actual, y produce un error ODBC. La API usa `PLUNIDAD`/`FINV.IUM`, que sí existen, por lo que no replica ese defecto.
