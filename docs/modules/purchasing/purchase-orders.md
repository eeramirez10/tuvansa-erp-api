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
| Hoja / Nueva orden de compra | `GET /create` | Movimiento O en `FTIPMV`, periodo y reglas de `FCIA` |
| Nueva orden de compra / Almacén | `GET /create` | Catálogo `FALMCAT`, consulta derivada de `EALM#1/240` |
| Nueva orden de compra / Proveedor | `GET /create/suppliers?q=...` | Proveedores activos de `FPRV` |
| Nueva orden de compra / Producto | `GET /create/products?supplierCode=...&q=...` | `FINV`, `FUNIDAD` y condiciones de compra del proveedor |
| Nueva orden de compra / OK | `POST /` | Alta transaccional en PostgreSQL |
| Papelera / Baja de orden de compra | `GET /:purchaseOrderId/removal` | `FPENC`, `FPLIN` y revisión local vigente |
| Baja de orden de compra / Sí | `DELETE /:purchaseOrderId` | Baja transaccional y ajuste del pendiente en PostgreSQL |
| Confirmar todo / Desconfirmar todo | `GET /:purchaseOrderId/actions/confirmation`, `PATCH /:purchaseOrderId/actions/confirmation` | Reglas de `EOC#2/7`, `/422–423` y `MBASE/124`, persistencia derivada en PostgreSQL |
| Autorizar / O.K. A–F | `GET /:purchaseOrderId/actions/authorization`, `PATCH /:purchaseOrderId/actions/authorization` | Reglas de `EOC#16/1–6`, permisos `FUSERS` y `FHELP`, bitácora en PostgreSQL |
| Autorizar / Cambia proveedor | `GET /authorization/suppliers`, `PATCH /:purchaseOrderId/actions/authorization/supplier` | `EOC#16/7 → ECIA#26 → INICIO/44`, lectura de `FPRV`, sustitución de `PRVSEQ` en `FPENC` y `FPLIN` mediante PostgreSQL |
| Acciones / Cambia Prv | `GET/PATCH /:purchaseOrderId/actions/change-supplier` | `EOC#2/4 → ECIA#26`, proveedor de `FPRV`, `FPLIN.PRVSEQ`, `FPENC.PRVSEQ` y `FPENC.PEPARA` mediante PostgreSQL |
| Lápiz / Cambio de orden de compra | `GET /:purchaseOrderId/edit` | `FPENC`, `FPLIN`, `FCIA` y revisión vigente en PostgreSQL |
| Cambio de orden de compra / Producto | `GET /:purchaseOrderId/edit/products?q=...` | Catálogo de compra `FINV`, configuración `FCIA` y unidades `FUNIDAD` |
| Cambio de orden de compra / OK | `PATCH /:purchaseOrderId` | Persistencia derivada en PostgreSQL |

El buscador reproduce los campos observados: **Pedido, Ped. Proveedor, Proveedor, Fecha, Vencimiento, Agente y Tipo**.

## Acciones con lectura verificada

| Botón OMNIS | Endpoint | SQL capturado/adaptado |
|---|---|---|
| Auxiliar | `GET /:id/actions/auxiliar` | `FDOC`, `DREFER=PENUM`, `DEST=0`, `DMULTICIA=1` |
| Clasificar | `GET /:id/actions/classifications` | Valores de `PEPAR1..PEPAR9` y PostgreSQL cuando existe una revisión local. Opciones `FAG`, `AGT 1..9`, `AGTIPO IN (0,2)`, orden `AGNUM`. `MBASE/91` lee los rótulos de `FYG.YGKEY='ABITITPAR2'`, con respaldo de `FCIA.CIAPAR1..9` si falta esa entrada. |
| Comentarios | `EOC#2/6 → /421 → EOC#6`, `MBASE/122–123` | Edita las cinco líneas y el encabezado. Recalcula los totales cuando cambian descuentos o cargos. | `GET /:id/actions/comments`, `GET /:id/actions/comments/editor`, `PATCH /:id/actions/comments` |
| CT | `EOC#2/9 → EOC#6AA/240–241`, `MBASE/124` | **Cambio** actualiza la primera partida de la variante y el pendiente. El catálogo de TUVANSA no tiene tallas configuradas. | `GET /:id/actions/ct`, `GET /:id/actions/ct/editor`, `PATCH /:id/actions/ct` |
| Piezas | `EOC#2/16 → EOC#18/240`, `EOC#18/107` | Muestra piezas por folio. **Confirmar** acumula `CAJCANT` en la primera partida del mismo código en orden `PLSEQ`. | `GET /:id/actions/pieces`, `GET/PATCH /:id/actions/pieces/confirmation` |

## Escritura de Clasificar en PostgreSQL

`PATCH /:id/actions/classifications` recibe `{ current: string[], revision: number }`. La lista contiene los nueve valores en orden. Los cambios deben ser un `AGTNUM` del clasificador correspondiente o vacío. Un valor histórico ausente del catálogo se puede conservar sin cambiarlo. Una revisión desactualizada devuelve `409`.

La persistencia derivada usa `tuvansa.purchase_order_classifications` en el PostgreSQL configurado por `NEON_DATABASE_URL`. La tabla se crea mediante migración al guardar por primera vez. Los GET conservan MySQL como fuente de catálogo y partidas y aplican los nueve valores locales donde hay una revisión guardada, incluida la búsqueda por Agente. MySQL permanece en lectura.

Los controles **Cambio** de CT y **Confirmar** e **Imprimir** de Piezas siguen pendientes de migración.

La verificación web cubrió acceso directo, menú, buscador, flechas y apertura de los cinco paneles. En Neon de pruebas se guardaron dos revisiones desde el flujo de Clasificar y se comprobó la consulta posterior, la búsqueda por agente y el rechazo de una revisión obsoleta. Se retiró el registro de prueba de PostgreSQL y se verificó el valor original en MySQL. La lectura de Piezas con filas y la cuadrícula de CT con tallas configuradas también se verifican con pruebas de datos simulados.

## Edición de Comentarios

`EOC#2/6 → /421 → EOC#6` prepara las modificaciones de `FCOMENT` y `FPENC`.
Los rótulos de COML1 a COML5 provienen de `FTIPMV`. Las capturas exportadas
`20261120-EOC6-FIELDS-PROCEDURES` y `20261120-MBASE-122-OC` documentan los
campos y el recálculo.

**OK** envía `{revision, legacyVersion, fields}` y guarda en la revisión de la
orden en PostgreSQL. **Cancelar** descarta el borrador. Los cambios de
descuentos y cargos recalculan los totales y el importe con letra con
`MBASE/122–123` como referencia. Se conserva el IEPS guardado. La fecha
manual de confirmación y la bitácora de autorización conservan su precedencia
por fecha de escritura. Las firmas se proyectan aparte del texto editable
COML4. El buscador incorpora el número del proveedor y el vencimiento efectivos.

Chrome y Neon verificaron el guardado y la cancelación, el total y el importe
con letra, la búsqueda, la revisión obsoleta, un guardado idéntico y la
conservación de los cambios tras editar partidas. Se retiró la orden de prueba
y se verificaron los acumulados iniciales.

## Cotiz y Gen %

**Cotiz** sigue `EOC#2/8 → MBASE/125` en la biblioteca German de pruebas.
Conserva folio, partidas, cantidades, surtido, asignación y totales. Cambia
`PESPEDIDO` efectivo entre pedido (`2`) y cotización (`5`). El saldo firmado
`PLCANT - PLSURT` se transfiere entre los acumulados de pedido (`FINV.IPEDPRV`)
y cotización (`FINV.IORDCOTIZ`). Capturas locales `purchase-cotiz-01-mbase125`
y `purchase-cotiz-02-mbase125`.

El GET carga la revisión y la versión de origen. El PATCH recibe
`{revision, legacyVersion, target}`, con `target` igual a `order` o `quote`.
La escritura derivada guarda el tipo y los acumulados en PostgreSQL dentro
del mismo bloqueo de la orden. La edición, autorización y confirmación usan el
tipo efectivo. La web pide confirmación antes de guardar. Se probaron en
Chrome y Neon ambos sentidos, Cancelar, conservación del folio y partidas,
filtro por tipo, acumulados y reintento. Se retiró la orden de prueba.

`EOC#2/13` muestra **bye** en TUVANSA y sale. **Gen %** reproduce el mensaje
con **OK** y no envía solicitudes.

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
| Alta Piezas | `EOC#2/1 → EOC#17` | Captura, edición e importación por producto. Cantidad cero elimina la pieza. | `GET /:id/actions/pieces/editor`, `PATCH /:id/actions/pieces` |
| Autorizar | `EOC#2/2 → EOC#16` | O.K. A–F valida estado y permisos, modifica `FPENC.PEPAR9` y registra el cambio en `FCOMENT.COML4`. **Cambia proveedor** sustituye el proveedor inicial `COMPRA` en nivel A. | `GET/PATCH /:id/actions/authorization`, `PATCH /:id/actions/authorization/supplier` |
| Auxiliar | `EOC#2/3 → EPRV#7C/240` | Lee `FDOC` por `DREFER=PENUM`, `DEST=CIAKYT`, `DMULTICIA=LVCIA`. Presenta `DNUM` y `DFECHA`. La API fija `DEST=0` y `DMULTICIA=1` para el contexto capturado. | `GET /:id/actions/auxiliar` |
| Cambia Prv | `EOC#2/4 → ECIA#26` | Valida `FPRV.PRVCOD`; cambia proveedor en `FPLIN.PRVSEQ` y `FPENC.PRVSEQ` y guarda el código en `PEPARA`. | `GET/PATCH /:id/actions/change-supplier` |
| Clasificar | `EOC#2/5 → EPDC#199/239–240`; guarda en `/3` | Opciones de `FAG` con `AGTIPO IN (0,2)`, ordenadas por `AGNUM`, comparadas por `AGTNUM` contra `PEPAR1–9`. `MBASE/91` determina las etiquetas. La web usa el mismo filtro, ordena por `AGSEQ`, tiene etiquetas fijas y sólo lectura. | `GET /:id/actions/classifications` |
| Comentarios | `EOC#2/6 → /421 → EOC#6`, `MBASE/122–123` | Edita las cinco líneas y el encabezado. Recalcula los totales cuando cambian descuentos o cargos. | `GET /:id/actions/comments`, `GET /:id/actions/comments/editor`, `PATCH /:id/actions/comments` |
| Confirmar todo | `EOC#2/7 → /422–423` | Ajusta cada `FPLIN.PLASIGNADO` a `PLCANT−PLSURT`. Shift quita la asignación. | `GET/PATCH /:id/actions/confirmation` |
| Cotiz | `EOC#2/8 → MBASE/125` | Cambia el tipo entre `2` y `5` y transfiere `PLCANT-PLSURT` entre `IPEDPRV` e `IORDCOTIZ`. | `GET/PATCH /:id/actions/quote-conversion` |
| CT | `EOC#2/9 → EOC#6AA/240–241`, `MBASE/124` | **Cambio** actualiza la primera partida de la variante y el pendiente. El catálogo de TUVANSA no tiene tallas configuradas. | `GET /:id/actions/ct`, `GET /:id/actions/ct/editor`, `PATCH /:id/actions/ct` |
| Div. Sucursal | `EOC#2/10 → EPED#8` | Aumenta el surtido de la partida origen y crea una partida por esa cantidad en la orden y sucursal destino. | `GET/POST /:id/actions/branches`, modo `divide` |
| Duplicar | `EOC#2/11 → EOC#7` | Copia las partidas por porcentaje y genera un folio nuevo. Shift copia sólo `PLCLASE='X'` y desmarca el origen al guardar. | `GET/POST /:id/actions/duplicate` |
| Etiquetas | `EOC#2/12 → /263` en la ruta predeterminada | El reporte y el medio de impresión dependen de la configuración. La ruta predeterminada usa `FTIPMV` y las asignaciones de `FPLIN`. | Sin ruta |
| Gen % | `EOC#2/13` | Para TUVANSA el procedimiento muestra `bye` y termina antes de efectuar cálculos o consultas. | Mensaje local |
| Imprimir | `EOC#2/14 → MOCOM/36` | Genera el reporte de orden con `#48=0`. El medio de impresión depende de `TIPRINTER` y existen rutinas por configuración. | Sin ruta |
| Imprimir Conf. | `EOC#2/15 → MOCOM/36` | Usa `#48=1`; el filtro predeterminado de partidas incluye `PLASIGNADO>0`. | Sin ruta |
| Piezas | `EOC#2/16 → EOC#18/240`, `EOC#18/107` | Muestra piezas por folio. **Confirmar** acumula `CAJCANT` en la primera partida del mismo código en orden `PLSEQ`. | `GET /:id/actions/pieces`, `GET/PATCH /:id/actions/pieces/confirmation` |
| Sucursal | `EOC#2/17 → EPED#8` | Copia un porcentaje de las partidas de la sucursal origen a la orden y sucursal destino. | `GET/POST /:id/actions/branches`, modo `percentage` |
| Split | `EOC#2/84` | Crea una orden hija con sufijo `A` a `Z` y mueve partidas sin surtido, asignación ni piezas. | `GET/POST /:id/actions/split` |

### Guardado de partidas y piezas

- Duplicar usa la serie PostgreSQL `OW` de Alta de orden y conserva la moneda del origen. Split conserva el identificador de las partidas y recalcula ambas órdenes. En Omnis está comentada la totalización del padre en Split.
- Div. Sucursal guarda los dos documentos en una sola transacción y compensa el pendiente del origen con el de la nueva partida. Sucursal aumenta el pendiente por las partidas copiadas. Ambas conservan unidad y factor del origen.
- Cambio en CT conserva surtido, asignado y los importes de la orden, como en `MBASE/124`. El guardado se verificó con una matriz de prueba en una orden aislada de Neon.
- Alta Piezas guarda en PostgreSQL por orden y producto. Las series automáticas usan prefijo `W`. Importar acepta filas de código, cantidad y serie separadas por tabuladores para el producto seleccionado, y espera **OK** para guardar. El origen del valor `#45` usado para comparar el total en `EOC#17/411` sigue pendiente de confirmar.
- **Piezas → Confirmar** guarda las asignaciones, el clasificador `ASIGNAD` y el confirmado de Inventarios en la misma transacción. Los folios, las cantidades pedidas y surtidas, y el acumulado pendiente se conservan.

### Evidencia para reproducir el contraste

- Exportaciones locales en `captures/ui/omnis7-developer-check/`. `20261120-EOC2-FIELDS.txt` contiene campos, orden y fórmulas; `20261120-EOC2-PROCEDURES.txt` contiene los eventos; `20261120-MOCOM-PROCEDURES.txt` contiene carga y navegación; `20261120-MBASE-122-OC.txt` contiene la fórmula de totales. Las ventanas de Acciones se exportaron por formato en el mismo directorio.
- Capturas web REA. La orden `O000001` abierta por ID mostró **COTIZ** (`ev_91c54f3317e62541632aa3e012464b1bdf15a4cbed68c8ef9496a3464dceaa7b`). La entrada por `/ordenes-compra` mostró una tabla vacía para `185535` (`ev_1b5394f5d87a222e17b7adb0e05e9e40cca96981555c46bed840c8d6d58a7747`). El acceso directo al mismo ID mostró partidas (`ev_1f4fcd2fec01416acec70b89b944aa57a83df0036cf2c1bac835e8ff067fca78`).
- Contraste en el código web. API `legacy-mysql-purchase-orders-data-source.ts` y `purchase-orders-routes.ts`. Frontend `purchase-orders-route.tsx`, `purchase-order-details.tsx`, `purchase-order-action-dialog.tsx` y `constants.ts` bajo `src/features/purchasing/purchase-orders/`.

## REA de Editar en Omnis 7

El lápiz de la barra corresponde a **Control → Cambio**. `MCONTROL/7` comprueba que el menú de Órdenes de compra esté activo y llama a `MOCOM/40`. El código de **Cambiar O.C.** abre el formato `EOC#3` encima de la ficha `EOC#2`. La acción **Comentarios** usa su propio formato `EOC#6`.

En Omnis 7 se abrió **Cambio de orden de compra** con `O000001` de la compañía TUVANSA. La ventana tiene los campos de la partida seleccionada arriba, la lista de partidas debajo y **OK** y **Cancelar** al pie. El formato confirma este orden de captura:

| Campo visible | Campo en `EOC#3` | Comportamiento |
|---|---|---|
| Producto | `ICOD` | Editable, con conversión a mayúsculas. |
| Pedido | `#1` | Editable. Se mostró con tres decimales en la partida cargada. |
| Unidad junto a Pedido | `MEMUC` | Editable. El cambio de unidad recalcula el factor y el precio ingresado. |
| Descuento | `PLDESC` | Editable, condicionado por la configuración de compañía. |
| Precio | `#2D5` | Editable, condicionado por la configuración. Se mostró con cinco decimales. |
| Sucursal | `EOC#2/17 → EPED#8` | Copia un porcentaje de las partidas de la sucursal origen a la orden y sucursal destino. | `GET/POST /:id/actions/branches`, modo `percentage` |
| Pzas. | `PLASIGNPZAS` | Editable. Es el mismo campo que la ficha muestra en **Obs.** |
| Descripción | `IDESCR` | Texto del producto en sólo lectura. |

`EOC#3/0` deshabilita **Descuento** y **Precio** cuando la posición 71 de `CIACOMPORTA` está activada. En el MySQL consultado, TUVANSA tiene `0` en esa posición. La edición observada fue un borrador de cantidad **5 → 6**, descartado con **Cancelar**. La ficha volvió a mostrar **5**. Al recargar apareció el aviso ODBC de `PLUMXXXX` documentado arriba y se descartó. No se pulsó **OK** del editor.

| Paso | Comportamiento leído en PROSCAI_GERMAN - PRUEBAS |
|---|---|
| Entrar | `MOCOM/39–40` comprueba que la suma de `FPLIN.PLASIGNADO` sea cero y verifica el permiso `MOCOM40`. Para abrir `EOC#3` exige `PESPEDIDO=2` y `PEMULTICIA=LVCIA`. Hay reglas adicionales por alias de compañía. |
| Cargar las partidas | Trabaja con la lista `#L2`. Convierte cantidad a `PLCANT / factor` y precio a `PLPRECI × factor`, con factor 1 cuando `PLFACTOR=0`. Conserva unidad, cantidad surtida y cantidad anterior. |
| Capturar o cambiar producto | `MOCOM/41` valida `ICOD` con `INICIO/42`, resuelve el precio con `EOC#1/420`, valida producto con `MOCOM/43` y ajusta unidad y conversión con `MRECEP/70`. El control rechaza productos inactivos para compras. En TUVANSA se observó `CIACOMPORTA[97]=0` en el MySQL consultado. En el último campo de observaciones, Tab pasa a la siguiente partida o agrega un renglón vacío. |
| Confirmar | `MOCOM/44` reconvierte cantidad y precio a la unidad almacenada. Omnis pregunta si debe retirar partidas con cantidad cero. `MOCOM/40` agrega renglones con `MBASE/121`, actualiza los existentes mediante `MBASE/69` y puede retirar partidas con código borrado o cantidad cero según la respuesta. |
| Ajustar inventario | `MBASE/121` inserta `FPLIN`, suma la cantidad a `FINV.IPEDPRV` y `FPENC.PEPZAS`, y actualiza `FINV.IPROXRECEP` con `PEDESDE`. `MBASE/124` aplica deltas en `FPLIN`, ajusta `FINV.IPEDPRV` por el cambio en `max(PLCANT−PLSURT,0)` y modifica `FINV.ICONFIRMADO` sólo por el delta de confirmación. También actualiza los acumulados correspondientes en `FPENC`. |
| Recalcular y salir | Después de aplicar cambios relee la orden y llama a `MBASE/122` para recalcular importes y a `MBASE/123` para actualizar `FCOMENT.COMLETRA` por `10000000+PESEQ`, creando el registro si falta. Cuando se cancela, omite el bloque de guardado y recarga la ficha con `MOCOM/28`. La integración posterior `MOCOM/403` termina de inmediato para TUVANSA. |

Referencias locales bajo `captures/ui/omnis7-developer-check/`. `20261120-MCONTROL-EDITAR.txt` línea 266 identifica el evento. `20261120-EOC3-EDICION.txt` contiene los controles del editor. `20261120-MOCOM-PROCEDURES.txt` línea 902 contiene las condiciones de entrada, línea 921 el editor y el guardado, línea 1051 el teclado, línea 1136 las validaciones de producto y línea 1213 la conversión. Se exportaron también `20261120-MBASE-121-OC.txt`, `20261120-MBASE-123-OC.txt` y `20261120-MBASE-124-OC.txt`. Las capturas `20261120-oc-edicion-modal.png`, `20261120-oc-edicion-borrador.png` y `20261120-oc-edicion-restaurada.png` muestran el recorrido nativo.

Las reglas de guardado provienen del código exportado. El recorrido de Omnis fue de lectura y cancelación de un borrador. El guardado de esta implementación se prueba en PostgreSQL. `general_log` se verificó en `OFF` en el MySQL consultado por la API.

### Edición web y persistencia

- El editor adapta `EOC#3` y `MOCOM/39–44`. La compañía activa se resuelve en el servidor mediante `PURCHASE_ORDER_EDIT_COMPANY_ID`, con México (`1`) como valor predeterminado. La versión de MySQL y la revisión de PostgreSQL se validan al guardar. Dos guardados de la misma revisión producen un éxito y un conflicto `409`.
- La API recibe los campos de la unidad visible. Convierte a la unidad almacenada con su factor antes de recalcular. `MRECEP/70` usa la unidad base cuando `CIACOMPORTA[56]` está apagado y las equivalencias de `FUNIDAD` cuando está activo. La configuración consultada de TUVANSA tiene la conversión de proveedor desactivada. Se conserva el factor guardado en partidas históricas que conservan su unidad.
- **Pzas.** guarda `PLASIGNPZAS` en partidas existentes. Al agregar desde Cambio, `MOCOM/40 → MBASE/121 → /71` deja la columna con el valor predeterminado vacío. En el editor web se habilita una vez que la partida tiene identificador. Una partida existente se retira al borrar su código o al aceptar la confirmación de cantidad cero. El editor nativo admite agregar una partida con cantidad cero.
- La migración de PostgreSQL guarda el documento editado y los deltas de pendiente en la misma transacción. Aplica las reglas de `MBASE/121–124`: pendiente por producto, totales, importe con letra y fecha prevista al agregar un producto. Ficha, búsqueda, flechas, CT y Comentarios proyectan la revisión guardada. El acumulado **Ordenado a proveedor** del catálogo de Inventarios incorpora los deltas. La consulta histórica de partidas de proveedor de Inventarios mantiene su lectura heredada.
- La edición para TUVANSA usa las reglas consultadas del catálogo. La autorización de usuarios `MOCOM40` y las variantes especiales nativas de matriz color/talla y EDI todavía corresponden a Omnis. Esta etapa usa selección directa de SKU y no escribe en MySQL.

## Nueva orden de compra

`MCONTROL/5` lleva a `MOCOM/21` y a la ventana `EOC#1`. El procedimiento `401` carga el movimiento O, las fechas y el almacén de la sesión. `411` valida periodo, proveedor activo y clasificador, precarga descuentos e IVA de proveedor y descarta el borrador con **Cancelar**. `412` propone el folio a partir de `TICLA`, `TICEROS` y `TINUM + 1`. Al aceptar el folio propuesto, `MBASE/29` incrementa el consecutivo después de insertar la orden.

`EOC#1/420` calcula el precio sugerido a partir de `ILISTA5` o `ILISTA6` y los descuentos del proveedor. `403` convierte cantidad y precio a la unidad de almacenamiento. `406` lleva únicamente partidas de cantidad positiva a `MBASE/121`, incluida la captura de **Pzas.**, y actualiza fecha prevista y pendiente de proveedor. El subtotal, descuentos, IEPS, cargos e IVA se derivan de las fórmulas de `EOC#1` y `MBASE/122`.

La ventana web adapta el movimiento O de TUVANSA. El folio web se asigna al guardar con una secuencia propia, formato `OW00000001`. El **OK** guarda encabezado, partidas, totales, importe en letra y pendiente en una sola transacción. La orden se puede consultar por identificador o folio, localizar en la búsqueda y editar con control de revisión. La clave UUID de la petición permite reintentar el mismo guardado sin duplicar la orden.

**Almacén** se abre antes de la captura si `CIACOMPORTA[37]` está habilitado y hay más de una opción, como en `EALM#1/100` y `/241`. Al cancelar el selector se aplica el almacén predeterminado. El encabezado muestra el almacén seleccionado para el borrador y `POST /` valida el código contra los mismos almacenes.

`EALM#1/240` usa `FALMCAT.CATALM` y `CATDESCR`, filtrados por tipo, compañía y sesión. La consulta web es **derivada** de ese código. Para el perfil inicial de México replica la lista observada en Omnis (`01, 11, 12, 13, 97, 99`), dentro de la compañía activa y los almacenes compartidos. La API usa el alcance configurado en `PURCHASE_ORDER_WAREHOUSES` en vez de una sesión de Omnis. El primer código configurado es el predeterminado si está en el catálogo. Para otra compañía sin un alcance configurado sólo se consultan almacenes de catálogo sin restricción por usuario.

Los catálogos y la configuración se leen de MySQL. El flujo y las fórmulas se leyeron en la biblioteca de Omnis 7. El selector de almacenes se contrastó en ejecución y con el formato exportado `EALM#1`. El alta web, su borrador y su persistencia se verifican en PostgreSQL de pruebas. La captura posterior de comentarios de `MOCOM/50` y las variantes automáticas de otros alias de empresa quedan pendientes.

## Baja de orden de compra

`MCONTROL/6` llama a `MOCOM/22`. El procedimiento exige una orden de la compañía activa con `PESPEDIDO=2` y verifica que no haya partidas confirmadas (`PLASIGNADO`) antes de mostrar **Sí / No** con `PENUM` y `PRVCOD`. Se observó el aviso en Omnis 7 con `O000001` y se eligió **No**.

Al confirmar, `MOCOM/22 → MBASE/124` resta a `FINV.IPEDPRV` el pendiente de la partida, `max(PLCANT-PLSURT, 0)`. `MBASE/72` elimina las partidas y el encabezado. La regla permite recepciones parciales y conserva sus documentos. `MOCOM/2` y `EOC#8` corresponden a otra acción del menú.

La API aplica esa regla en PostgreSQL con un registro de baja por identificador y folio. Excluye la orden de detalle, buscador, flechas y consultas de compras. El catálogo abre la siguiente disponible y usa la anterior al llegar al final. Para órdenes web retira su contribución al pendiente. Para las heredadas descuenta las partidas aún pendientes en la lectura de MySQL, de modo que una recepción posterior en el sistema de origen no duplique el descuento. Los paneles de Inventarios **Ordenado a proveedor** y **CT** excluyen las bajas. Los documentos de recepción conservan su referencia.

`DELETE` recibe `number`, `revision` y `legacyVersion` del GET de confirmación. Revalida tipo, compañía, confirmaciones y versión. La baja y el ajuste se guardan en la misma transacción. Repetir la confirmación devuelve la baja aplicada sin descontar cantidades otra vez. Esta adaptación cubre la baja completa de TUVANSA. El permiso interno `MOCOM22` depende de la sesión de Omnis. La API aplica la compañía activa de Tuvansa ERP.

## Confirmar todo y desconfirmar

En Omnis 7 se observaron ambos avisos con `O000001`. El clic abre **¿Desea asignar todo el pedido?** y **Shift + clic** abre **¿Desea des-asignar todo el pedido?**. Se eligió **No** en ambos. La versión web conserva el atajo y ofrece **Desconfirmar todo** en el diálogo cuando hay partidas confirmadas.

`EOC#2/422` aplica a cada partida la diferencia `PLCANT − PLSURT − PLASIGNADO`. Deja lo confirmado en pedido menos surtido, en unidades de almacenamiento y con el signo del saldo. `EOC#2/423` resta la asignación vigente para dejarla en cero. `MBASE/124` aplica la misma diferencia a `FPLIN.PLASIGNADO`, `FINV.ICONFIRMADO` y `FPENC.PEPZASIGN`. Marca `PEPAR8` como `ASIGNAD` con un incremento y lo vacía con un decremento. El surtido, totales monetarios y pendiente de recibir conservan sus cantidades.

El GET devuelve la revisión, la versión y si hay asignaciones. El PATCH recibe esa revisión y versión y el modo `confirm` o `unconfirm`. PostgreSQL guarda en una sola transacción las partidas, el total asignado, el acumulado por producto y el marcador de clasificación. **Editar** y **Baja** consultan la asignación vigente. Inventarios refleja el acumulado **Confirmado** y las partidas heredadas de **Ordenado a proveedor**. La API aplica la compañía activa y el tipo orden. El permiso individual `EOC#2/422` pertenece a la sesión de Omnis.

La prueba en Neon cubrió ambos avisos en el navegador, una orden heredada con 44 unidades pendientes y la desconfirmación de una asignación que ya existía en MySQL. Se retiraron los registros de prueba de PostgreSQL y se verificaron los saldos originales.

## Autorizar

La ventana **Autoriza O.C.** de Omnis 7 muestra **O.K. A** a **O.K. F**. Cada botón guarda al pulsarse y **Shift + clic** invierte ese nivel cuando el estado lo permite. En `EOC#16/1–6`, A aplica si el código actual es menor a `9A`, B–E avanzan un paso desde su nivel precedente y F aplica si es menor a `9F`. La reversión de A deja `9`, B–E vuelven a su precedente y F revierte un estado `9F` o superior a `9E`.

La UI web aplica estas transiciones al clasificador 9 y pide una clave de firma personal. La API resuelve el `USRSEQ` en el servidor y comprueba la compañía, la cuenta activa y los permisos por grupo de `INICIO/30`. Las entradas de `FHELP` son `MRECEP63-A` para abrir y `EOC#16/1–6` para cada nivel. Se verificó la configuración de permisos por grupo de TUVANSA. Si un permiso requiere supervisor, ese nivel queda sujeto a validación adicional en Omnis.

`PURCHASE_ORDER_APPROVER_KEYS` recibe un arreglo JSON de entradas con `userId`, `sha256` y `levels`. Usa un `USRSEQ` activo y una clave aleatoria distinta por autorizador. Un ejemplo de generación local es `node -e "const c=require('node:crypto');const key=c.randomBytes(32).toString('hex');console.log({key,sha256:c.createHash('sha256').update(key).digest('hex')})"`. Guarda sólo el hash en la configuración y entrega la clave a su titular por un medio privado. La firma viaja en el encabezado HTTP `Authorization: Bearer` por HTTPS. La lista inicial vacía permite consultar la ventana y el estado.

En PostgreSQL se guardan el estado y la bitácora de forma atómica. Comentarios muestra el historial proyectado sobre `COML4`, la fecha de avance a C (`PEDATE3`) y el usuario de D (`PEUSRAUT`), que se limpia al revertir D. Clasificar reserva los códigos de autorización para este flujo. El GET aporta la versión, revisión y el estado exigidos por el PATCH. La validación de concurrencia evita transiciones sobre una orden modificada.

`MOCOM/36` y `EOC#2/14` aplican validaciones de impresión por alias en BABY, CADER y KARELE. El flujo de recepción de `MRECEP` contiene otros controles por alias, incluidos ALDO, LIZ, MODPAR, ZOY, NEWBALANCE, BABY y DURAZNOS. La revisión del código no encontró en estos flujos una compuerta por nivel para TUVANSA.

La prueba en Neon usó una orden temporal y claves efímeras. Verificó la firma y reversión desde el navegador, permisos por grupo, revisiones, bitácora, fecha de C y usuario de D. Los registros de prueba se retiraron al terminar.

## Cambia proveedor dentro de Autorizar

`EOC#16/7` comprueba `PEPAR9='9A'` y `PRVCOD='COMPRA'`. Abre **Proveedor** (`ECIA#26`) con el código actual, **OK** y **Cancelar**. `INICIO/44` busca el código exacto en `FPRV` y usa `EPRVFINDEDWC` para localizar por código o nombre. En el buscador, un nombre precedido por `*` busca una coincidencia interna y `**` busca `PRVVARIOS1`. La web conserva esos filtros y limita los resultados a 35.

Tras OK, el método reemplaza `FPLIN.PRVSEQ` en todas las partidas y `FPENC.PRVSEQ` en el documento. Calcula `PEPARA` en memoria, pero el camino SQL de `MBASE/74 → MBASE/69` arma la edición con `PRVSEQ`. Las cantidades, los precios, la moneda, el IVA, los totales, el estado de autorización y las recepciones se conservan. La persistencia web derivada usa una transacción en `tuvansa.purchase_order_supplier_changes` para guardar la sustitución por orden, aplicada a todas las partidas, y el usuario responsable. Proyecta el proveedor en ficha, buscador, Comentarios y las consultas heredadas **Ordenado a proveedor** y **Ordenado a proveedor CT** de Inventarios.

Agrega `"supplierChange":true` a la entrada del autorizador que corresponda en `PURCHASE_ORDER_APPROVER_KEYS`. Se admite `"levels":[]` para una clave exclusiva de esta acción. La API autentica el cambio con la clave personal y comprueba los permisos de apertura y `EOC#16/7` en Omnis. En los orígenes consultados no existe una entrada de `FHELP` para ese método y aplica la excepción de grupo 0 de `INICIO/30`. También se comprueban las revisiones dentro del bloqueo de la orden.

Evidencia de código de Omnis 7, no SQL observado en ejecución: `20261120-EOC16-OC.txt` (líneas 220–263), `20261120-ECIA26-OC.txt`, `20261123-INICIO44-OC.pdf`, `20261123-EPRVFINDEDWC-OC.txt` y `20261123-MBASE69-OC.txt`. Ni el MySQL local de Omnis ni el MySQL de lectura de la API tenían el código `COMPRA`. Las escrituras se probaron con una orden temporal en Neon. `general_log` estaba en OFF.

## Cambia Prv en Acciones

`EOC#2/4` abre `ECIA#26` con el proveedor actual y valida el permiso `EOC#35/40` mediante `INICIO/30`. El bloque de validación de `9A` está comentado en la biblioteca German de pruebas. El método acepta los pedidos y cotizaciones de la vista, incluidas las órdenes con recepciones. Guarda `PRVSEQ` en cada partida y prepara `PEPARA` y `PRVSEQ` para guardar juntos en el encabezado. `PEPARA` y `PRVCOD` son campos de seis caracteres. Los documentos de recepción existentes conservan su proveedor y su referencia.

Activa `"supplierChangeAction":true` en la entrada del usuario de `PURCHASE_ORDER_APPROVER_KEYS`. La API valida su clave personal y el permiso de Omnis. En los orígenes revisados, la entrada de `FHELP` existe y no requiere supervisor. El GET devuelve el proveedor efectivo y `supplierRevision`. El PATCH exige esa revisión junto con la revisión de edición, la de clasificación y la versión de origen. La migración convierte las sustituciones previas en la primera revisión y registra cada cambio posterior bajo el mismo bloqueo. El detalle y Comentarios proyectan `supplierParameter` como valor efectivo de `PEPARA`.

El código se leyó en la exportación `20261120-EOC2-PROCEDURES.txt` (líneas 41–87). Las lecturas en MySQL confirmaron el esquema de los campos, el permiso y la presencia de órdenes con recepciones. El SQL de escritura web es derivado para PostgreSQL.

La prueba en navegador y Neon cubrió selección, cancelación, firma, cambios consecutivos y conflicto entre dos guardados simultáneos. En la orden `OA00005` se verificó que cambiar proveedor y `PEPARA` conserva surtido, partidas, totales y la consulta de recepciones. Se retiraron los registros temporales de Neon y se verificó la lectura original.
