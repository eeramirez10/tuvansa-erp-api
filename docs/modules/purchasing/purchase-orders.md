# Órdenes de compra

Módulo de la ventana **Órdenes de compra** de OMNIS. La ruta base es:

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
| Clasificar | `GET /:id/actions/classifications` | Valores de `PEPAR1..PEPAR9` y PostgreSQL cuando existe una revisión local. Opciones `FAG`, `AGT 1..9`, `AGTIPO IN (0,2)`, orden `AGNUM`. `MBASE/91` lee los rótulos de `FYG.YGKEY='ABITITPAR2'`, con respaldo de `FCIA.CIAPAR1..9` si falta esa entrada. |
| Comentarios | `GET /:id/actions/comments` | `FCOMENT`, `COMSEQFACT=10000000+PESEQ`. Lectura adaptada según `EOC#6` para el encabezado y `FTIPMV.TICOML1..5` para los rótulos. |
| CT | `GET /:id/actions/ct` | Consulta derivada de `EOC#6AA/240–241`. `FPLIN` por `PESEQ`, raíz y color según `FCIA`, tallas de producto raíz en `FUNIDAD`. Devuelve Pedido, Surtido y Resta por raíz y por celda. |
| Piezas | `GET /:id/actions/pieces` | Consulta derivada de `EOC#18/240`. `FCAJAS.CAJFACTURA=PENUM`, producto de `FINV` y suma de `CAJCANT`. |

## Escritura de Clasificar en PostgreSQL

`PATCH /:id/actions/classifications` recibe `{ current: string[], revision: number }`. La lista contiene los nueve valores en orden. Los cambios deben ser un `AGTNUM` del clasificador correspondiente o vacío. Un valor histórico ausente del catálogo se puede conservar sin cambiarlo. Una revisión desactualizada devuelve `409`.

La persistencia derivada usa `tuvansa.purchase_order_classifications` en el PostgreSQL configurado por `NEON_DATABASE_URL`. La tabla se crea mediante migración al guardar por primera vez. Los GET conservan MySQL como fuente de catálogo y partidas y aplican los nueve valores locales donde hay una revisión guardada, incluida la búsqueda por Agente. MySQL permanece en lectura.

**Comentarios** es de consulta. Los controles **Cambio** de CT y **Confirmar** e **Imprimir** de Piezas se conservan deshabilitados. Los demás botones de Acciones conservan el marcador de esta etapa, incluido **Cotiz**, cuyo procedimiento nativo cambia el estado.

La verificación web cubrió acceso directo, menú, buscador, flechas y apertura de los cinco paneles. En Neon de pruebas se guardaron dos revisiones desde el flujo de Clasificar y se comprobó la consulta posterior, la búsqueda por agente y el rechazo de una revisión obsoleta. Se retiró el registro de prueba de PostgreSQL y se verificó el valor original en MySQL. La lectura de Piezas con filas y la cuadrícula de CT con tallas configuradas también se verifican con pruebas de datos simulados.

## Diferencia conocida del legado

La biblioteca OMNIS intenta consultar `FPLIN.PLUMXXXX`, columna que no existe en la base actual, y produce un error ODBC. La API usa `PLUNIDAD`/`FINV.IUM`, que sí existen, por lo que no replica ese defecto.

## Auditoría previa a la implementación del 20 de noviembre de 2026

Biblioteca `PROSCAI_GERMAN - PRUEBAS`, compañía TUVANSA, ventana `EOC#2`. Referencias web revisadas: API `8d7bf96` y frontend `ce81c29`. Las referencias `formato/procedimiento` y las fórmulas provienen del editor de Omnis. Se contrastaron la pantalla nativa, la aplicación web y muestras de MySQL de sólo lectura. La sección anterior conserva las referencias a las capturas históricas de SQL. Esta revisión no generó una nueva captura literal, no ejecutó mutaciones y verificó `general_log=OFF`.

### Pantalla, partidas y totales

| Elemento | Omnis 7 | Tuvansa ERP al revisar |
|---|---|---|
| Carga y navegación | `MOCOM/24` abre `EOCFIND/100`. `MOCOM/25–26` navega por `PENUM`. `MOCOM/28` arma la lista `#L2` de `FPLIN` por `PESEQ`, con datos de `FINV`. La exportación de ese método contiene `PLUNIDAD`. | La entrada `/ordenes-compra` sembró la caché de detalle con un resultado de búsqueda sin partidas. Se reprodujo para el ID `185535`. En una sesión limpia, la ruta directa a ese ID sí presentó las partidas. |
| Tipo | Campo 25 de `EOC#2`. `PESPEDIDO=2` es **PEDIDO**, `5` es **COTIZACION**. | El datasource invierte `2` y `5`, tanto en la ficha como en el buscador. `O000001` se vio como **PEDIDO** en Omnis y **COTIZ** en la web. |
| Encabezado y status | Incluye `PENUM`, `PENUMELLOS`, proveedor, sucursal, departamento, almacén, fechas, `PEPAR1`, `mid(PEPAR9,2,99)`, `PESURT`, `PEPZASSURT` y `PEINICIAL`. | La web toma el status de `PESTATUS`. Para `O000001` la pantalla nativa mostró `1` y la lectura devuelve `PEPAR1='1'` con `PESTATUS` vacío. |
| Cantidades y precio por partida | Campos 63–68. Divide Pedido, Surtido y Resta por `PLFACTOR`, con `1` como factor cuando vale `0`. Multiplica `PLPRECI` por ese mismo factor. Cantidades a dos decimales, precio y Descto a cuatro. | Muestra las cantidades y el precio almacenados sin aplicar `PLFACTOR`. Precio y Descto se muestran a dos decimales. |
| Moneda, Confirmado y Obs. | Campos 70–72. Moneda es el nombre `CIAPDDn` de la moneda de la orden, con `FINV.IMONEDA` cuando `PEMONEDA=0`. Confirmado es `FPLIN.PLASIGNADO`, con tres decimales, en blanco si es cero. Obs. es `FPLIN.PLASIGNPZAS`. | Muestra el identificador `FPLIN.PLMONEDA`, un «Sí» derivado de `FINV.ICONFIRMADO` y el código de producto del proveedor `FINV.ICODPRV`, respectivamente. Las partidas ya incluyen por separado los valores `assigned`, `piecesAssignment` y `supplierProductCode`. |
| Orden de partidas | Los encabezados de `#L2` tienen procedimientos de ordenamiento en `EOC#2/49–60,74`. | Los encabezados son estáticos. |
| Totales de cantidades | Campos 44–47. Suma los valores originales `PLCANT`, `PLSURT` y `PLASIGNADO`, sin dividir por `PLFACTOR`. Resta = Pedido − Surtido. | La API ya suma valores originales, con un decimal menos en la presentación de la web. Las cantidades de renglón y las de totales usan escalas distintas en Omnis. |
| Totales monetarios | Campos 29–36, 39–43. Lee importes persistidos `PEBRUTO`, `PEDESC`, `PEIEPES`, `PEFLETE`, `PESEGURO`, `PEOTRO`, `PEIVA` y `PECANT`. Muestra también `PDESC1–3`, `PEPORCIVA` y `PEOTROTXT`. | La API ya lee los importes persistidos. Faltan los tres porcentajes de descuento y el texto asociado a Otros. |

`MBASE/122` recalcula los importes al modificar la orden. Suma `PLCANT × PLPRECI × (1 − PLDESC/100)` para el bruto. Aplica `PDESC1–3` en cascada y redondea el descuento general a dos decimales. Usa `PEPORCIVA` sobre las partidas gravadas (`FINV.IPORCIVA=0`) después de los descuentos y sobre IEPS, flete, seguro y otros. El total es bruto menos descuento, más cargos e IVA, redondeado a dos decimales. El GET actual lee los resultados persistidos de `FPENC`. Como control de lectura, `OH00205` tiene bruto `3153.39`, IVA `504.54` y total `3657.93`.

### Botones de Acciones

Las rutas son relativas a `/api/purchasing/purchase-orders`. «Sin ruta» indica que la web presenta el botón como marcador en esta revisión. Los efectos de guardado se leen del procedimiento nativo.

| Orden en pantalla | Código Omnis 7 | Fuente y comportamiento | API web |
|---|---|---|---|
| Alta Piezas | `EOC#2/1 → EOC#17` (`EOC#19` según compañía) | Lee partidas y piezas. Cambio e importación escriben en `FCAJAS`; la serie usa `FTIPMV.PZ`. | Sin ruta |
| Autorizar | `EOC#2/2 → EOC#16` | O.K. A–F valida estado y permisos, modifica `FPENC.PEPAR9` y registra el cambio en `FCOMENT.COML4`. | Sin ruta |
| Auxiliar | `EOC#2/3 → EPRV#7C/240` | Lee `FDOC` por `DREFER=PENUM`, `DEST=CIAKYT`, `DMULTICIA=LVCIA`. Presenta `DNUM` y `DFECHA`. La API fija `DEST=0` y `DMULTICIA=1` para el contexto capturado. | `GET /:id/actions/auxiliar` |
| Cambia Prv | `EOC#2/4 → ECIA#26` | Valida `FPRV.PRVCOD`; cambia proveedor en `FPLIN.PRVSEQ` y `FPENC.PRVSEQ` y ajusta `PEPARA`. | Sin ruta |
| Clasificar | `EOC#2/5 → EPDC#199/239–240`; guarda en `/3` | Opciones de `FAG` con `AGTIPO IN (0,2)`, ordenadas por `AGNUM`, comparadas por `AGTNUM` contra `PEPAR1–9`. `MBASE/91` determina las etiquetas. La web usa el mismo filtro, ordena por `AGSEQ`, tiene etiquetas fijas y sólo lectura. | `GET /:id/actions/classifications` |
| Comentarios | `EOC#2/6 → /421 → EOC#6` | Busca `FCOMENT` por `10000000 + PESEQ`. `FTIPMV.TICOML1–5` da las etiquetas. Usa `COML1–4` para líneas cortas y `COML5` para el texto largo. Plazo, descuentos, moneda, fechas, auditoría y cargos provienen de `FPENC`. La web usa otras fuentes para parte de estos campos. El retorno del modal nativo contiene escrituras a `FCOMENT` y `FPENC` y llama a totalizar. | `GET /:id/actions/comments` |
| Confirmar todo | `EOC#2/7 → /422–423` | Ajusta cada `FPLIN.PLASIGNADO` a `PLCANT−PLSURT`. Shift quita la asignación. | Sin ruta |
| Cotiz | `EOC#2/8 → MBASE/125` | Cambia `FPENC.PESPEDIDO` entre `2` y `5` y recarga la orden. | Sin ruta |
| CT | `EOC#2/9 → EOC#6AA/240–241` | Consulta partidas por `PESEQ`, agrupa por raíz de producto (`FCIA.CIARAIZ`) y muestra matriz de variantes con Pedido, Surtido y Resta. Su botón interno Cambio puede escribir `FPLIN`. | Sin ruta |
| Div. Sucursal | `EOC#2/10 → EPED#8` | Divide cantidad seleccionada, suma surtido a la partida origen, crea partida de destino y recalcula. | Sin ruta |
| Duplicar | `EOC#2/11 → EOC#7` | Selecciona tipo en `FTIPMV`, consume `TINUM` y copia `FPENC`, `FPLIN` y `FCOMENT`. Shift filtra partidas marcadas con `PLCLASE='X'`. | Sin ruta |
| Etiquetas | `EOC#2/12 → /263` en la ruta predeterminada | El reporte y el medio de impresión dependen de la configuración. La ruta predeterminada usa `FTIPMV` y las asignaciones de `FPLIN`. | Sin ruta |
| Gen % | `EOC#2/13` | Para TUVANSA el procedimiento muestra `bye` y termina. Otras compañías tienen ramas específicas. | Sin ruta |
| Imprimir | `EOC#2/14 → MOCOM/36` | Genera el reporte de orden con `#48=0`. El medio de impresión depende de `TIPRINTER` y existen rutinas por configuración. | Sin ruta |
| Imprimir Conf. | `EOC#2/15 → MOCOM/36` | Usa `#48=1`; el filtro predeterminado de partidas incluye `PLASIGNADO>0`. | Sin ruta |
| Piezas | `EOC#2/16 → EOC#18/240` | Lee `FCAJAS` por `CAJFACTURA=PENUM`. Muestra producto, serie, piezas, cantidad, almacén, documento y recepción, con suma de `CAJCANT`. Su botón interno Confirmar actualiza `FPLIN`. | Sin ruta |
| Sucursal | `EOC#2/17 → EPED#8` | Genera partidas por sucursal usando un porcentaje de `PLCANT`, luego recalcula la orden. | Sin ruta |
| Split | `EOC#2/84` | Para TUVANSA incrementa `FPENC.PEHIJOS`, crea una orden hija con sufijo, reasigna `FPLIN.PESEQ` de las partidas seleccionadas y recalcula la orden hija. | Sin ruta |

### Evidencia para reproducir el contraste

- Exportaciones locales en `captures/ui/omnis7-developer-check/`. `20261120-EOC2-FIELDS.txt` contiene campos, orden y fórmulas; `20261120-EOC2-PROCEDURES.txt` contiene los eventos; `20261120-MOCOM-PROCEDURES.txt` contiene carga y navegación; `20261120-MBASE-122-OC.txt` contiene la fórmula de totales. Las ventanas de Acciones se exportaron por formato en el mismo directorio.
- Capturas web REA. La orden `O000001` abierta por ID mostró **COTIZ** (`ev_91c54f3317e62541632aa3e012464b1bdf15a4cbed68c8ef9496a3464dceaa7b`). La entrada por `/ordenes-compra` mostró una tabla vacía para `185535` (`ev_1b5394f5d87a222e17b7adb0e05e9e40cca96981555c46bed840c8d6d58a7747`). El acceso directo al mismo ID mostró partidas (`ev_1f4fcd2fec01416acec70b89b944aa57a83df0036cf2c1bac835e8ff067fca78`).
- Contraste en el código web. API `legacy-mysql-purchase-orders-data-source.ts` y `purchase-orders-routes.ts`. Frontend `purchase-orders-route.tsx`, `purchase-order-details.tsx`, `purchase-order-action-dialog.tsx` y `constants.ts` bajo `src/features/purchasing/purchase-orders/`.
