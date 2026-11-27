# Recepciones de orden de compra

Módulo capturado desde la ventana **Recepciones** de Omnis. Ruta base.

`/api/purchasing/purchase-receptions`

## Pantalla principal y barra

| Vista o boton OMNIS | Endpoint | Fuente real |
|---|---|---|
| Recepcion y partidas | `GET /:purchaseReceptionId` | `FDOC + FPRV`; partidas `FAXINV + FINV + FLOTES` |
| Buscar | `GET /` | `FDOC + FPRV` |
| Abrir por documento | `GET /by-number/:number` | `FDOC + FPRV` |
| Flecha anterior | `GET /:id/previous` | `DNUM < documento`, orden descendente |
| Flecha siguiente | `GET /:id/next` | `DNUM > documento`, orden ascendente |

El criterio real de Recepciones es:

```sql
(DESFACT IN (2, 3) OR DESCXC = 2)
AND DEST = 0
AND DMULTICIA = 1
```

El buscador reproduce **Documento, Fecha, Pedido, Ped. Proveedor, Talon, Folio, Proveedor y Alm**. La consulta capturada por documento usa el rango de prefijo sobre `DNUM` y ordena por `DNUM, DSEQ`.

## Alta vinculada a una orden

**Nueva recepción** solicita el folio de la orden, el almacén, la fecha y la referencia del proveedor. En México, **MRECEP/39** propone la cantidad confirmada dividida por el factor de la unidad. Se pueden quitar partidas de la captura o cambiar la cantidad. **Cancelar** descarta el borrador. Para TUVANSA, `CIACOMPORTA[109]=1` conserva la orden al terminar de surtirla.

| Operación | Ruta |
|---|---|
| Consultar el borrador | `GET /create?orderNumber=…` |
| Guardar con revisión, versión y UUID | `POST /` |

El alta conserva el vínculo de cada partida con la orden, equivalente a `FAXINV.AIPED`, y guarda en una sola transacción el folio web `RW`, la entrada de Inventarios tipo `RA`, el surtido, los pendientes, el cargo al proveedor y su póliza cuando están configurados. El UUID permite recuperar el mismo resultado al reintentar. Una revisión anterior recibe un conflicto. La orden queda en `SURT` según `MRECEP/35`. Al recibir se disminuye lo confirmado hasta la cantidad recibida y se reduce el pendiente de Inventarios por partida hasta cero. **Auxiliar** en la orden lista los folios de sus recepciones. **Auxiliar** en Recepciones muestra el cargo vinculado a su póliza.

En Neon se probó en Chrome una orden confirmada con dos unidades. Cancelar mantuvo las dos unidades pendientes. Dos recepciones de una unidad dejaron surtidos 1 y 2, pendientes 1 y 0 y asignados 1 y 0. La prueba verificó ambos movimientos y los cargos, y retiró sus datos temporales.

El alta cubre recepciones en pesos, incluidas las partidas con PEPS
automático de TUVANSA y pedimento capturado. La captura aplica a inventario
en unidad base, proveedores ordinarios e impuestos de la recepción
compatibles. El folio y la numeración de la póliza se asignan en PostgreSQL.

### Recepción con PEPS

| Vista / acción | Procedencia | Tablas y efecto |
| --- | --- | --- |
| Nueva recepción / OK | Derivada de German de pruebas `MRECEP/38,32`, `MBASE/41` y `MCPAR03/21,28,51` | Lee apertura de `FINV` y cola de `FLOTES`. Guarda una capa por partida en `inventory_adjustment_layers`, el vínculo RA y las unidades en `inventory_adjustment_layer_stock` y la valoración en `inventory_peps_costs` |
| Inventarios / Lotes y UEPS / PEPS | Derivada de la consulta por `FLOTES.LOSEQ` | Muestra el identificador de la capa, el folio, los saldos y los movimientos web asociados |
| Cancelar recepción / Confirmar | Derivada de `MRECEP/25–26,111,136–138` | Resta la cantidad en la capa de origen, deja su cantidad inicial en cero y conserva su clave PEPS. Registra el movimiento K, el regreso al pendiente de la orden y la póliza inversa |

`MBASE/41` actualiza Lista 5 al costo neto de la partida y Lista 4 al
promedio ponderado por la existencia global anterior. También promedia el
advalorem. Con el pedimento de la recepción vacío, `MCPAR03/28` toma
estos valores ya actualizados y los datos de importación del producto.
Cada partida obtiene su capa aun si el producto se repite. La cola es
común entre almacenes con la posición 94 desactivada.

La salida SI consume las capas en orden PEPS y registra el movimiento al
costo promedio vigente más advalorem. La anulación de la RW comprueba la
existencia libre del almacén y la cantidad completa de cada capa
original. Conserva la valoración registrada al recibir. Los pagos PP
activos y el periodo contable siguen aplicando como condiciones para
anular. La escritura de capas, existencias, orden, proveedor y póliza
pertenece a la misma transacción.

### Pedimento

| Control | Ruta | Procedencia |
| --- | --- | --- |
| Nueva recepción / Capturar datos de importación | `GET /create` anuncia `pedimentoAvailable`. `POST /` recibe `pedimento` con número, fecha, aduana e incrementables | Derivada de `ERECEPC#8` y `MRECEP/38,324,65`. El pedimento queda registrado en el folio web y las capas se ligan por partida |
| Pedimento | `GET /:id/actions/pedimento` | Para RA, lee `FPEDIMENTO.PMTODOC` por folio y los pasivos `FDOC/DREFER` marcados IMPORT con su auxiliar `FAX`. Para RW, lee el pedimento del folio guardado |
| Reporte pedimento | `GET /:id/actions/pedimento-report` | Lectura derivada de `ERECEPC#13/32` y del formato `RREPEDIM`. Usa `FPEDIMENTO`, `FDOC`, `FAXINV`, `FINV` y `FCIA` |
| Cancelar recepción | `GET` y `POST /:id/actions/cancel-reception` | Derivada de `MRECEP/24–26`. La RW devuelve el pendiente de la orden, revierte mercancía, pasivo y póliza, y conserva el pedimento para consulta |

El campo `PMTNUM` permite hasta 15 caracteres en TUVANSA y el mismo
pedimento puede aparecer en más de un folio. La fecha y la aduana pueden
quedar vacías. `CIACOMPORTA[22]=1` selecciona el cálculo por precio.
Para las recepciones de este alcance, `MRECEP/32` aplica el porcentaje de
arancel del producto al precio neto unitario más los incrementables por
unidad. Distribuye los incrementables con `#4 / (DBRUTO-DDESC)`: el
numerador incluye el descuento de partida y el denominador también los
descuentos de la recepción. La capa de `MCPAR03/28` registra por separado
costo de mercancía y advalorem. `MBASE/41` actualiza el promedio de
advalorem del artículo con las existencias previas.

El cargo y la póliza de mercancía usan los importes de la factura del
proveedor. La generación automática de los gastos de pedimento de
`MRECEP/104–105` requiere las cuentas de importación configuradas. En
TUVANSA las cuentas de gastos, IVA de flete y agente, e IEPS de
importación están vacías. Los pasivos históricos se consultan en su
moneda original. Por ejemplo, RA09154 contiene el cargo IMPORT RA09154A
por 735 MXN y su pago PP, sin póliza de origen acreditada. `MRECEP/24`
bloquea la cancelación genérica del documento IMPORT. La anulación web de
la mercancía aplica a sus folios RW.

**Reporte pedimento** abre una vista previa con los gastos desglosados,
IVA, total, porcentaje de gastos y las partidas facturadas. Los importes
usan los campos de gastos de `FPEDIMENTO`. Los pasivos históricos
vinculados por `DREFER` aparecen en **Pedimento**. Las RW consultan
los datos de importación guardados y tienen cero gastos de este formato.
El prorrateo usa el importe de mercancía en TUVANSA
(`CIACOMPORTA[50]=0`). La vista web muestra el folio vinculado y el
encabezado leído de `FPEDIMENTO`. En la sesión nativa del 24/11/2026 el
encabezado de la vista previa RA09154 salió vacío, aunque la fila de
pedimento existe. `bank-inline-receipt-secondary-23.png` documenta la
vista nativa y las capturas `-48`, `-50` y `-55` conservan los campos
y cálculos del diseñador. El formato alterno al pulsar Mayús queda
pendiente. La acción independiente **Imprimir** falló al cargar
`QTUVANSA006` en la biblioteca alemana de pruebas (`E101201`,
`bank-inline-receipt-secondary-36.png`).

## Gastos múltiples (GA)

En **Recepciones → Gastos múltiples**, `MRECEP/5` abre la captura de
`ERECEP#12`. La vista permite capturar fecha, beneficiario, concepto y
varios renglones con proveedor, producto de gasto, referencia, importe, IVA,
retenciones y centro de costo. **OK** guarda el grupo, y **Cancelar** sale
del borrador.

| Control | Ruta relativa a `/api/purchasing/purchase-receptions` | Procedencia y resultado |
| --- | --- | --- |
| Gastos múltiples | GET `/general-expenses/create` | `FCIA`, `FTIPMV`, `FBENC` y `FALMCAT` adaptados al periodo, tipo GA, cuentas y centros de costo de la compañía |
| Códigos Proveedor y Gasto | GET `/general-expenses/catalog?supplierCode=…&productCode=…` | `FPRV`, `FINV`, `FBENC` y valores por defecto de impuestos de `ERECEP#12/411` |
| OK | POST `/general-expenses` | Escritura derivada de `ERECEP#12/401–403,411–412` en `purchase_expense_batches` y `purchase_expense_documents` |
| Documento, Búsqueda y Auxiliar | GET `/:id`, `/by-number/:number`, `/` y `/:id/actions/auxiliary` | Ficha de GA, importes y movimientos GA y PP del documento |
| Proveedores → Saldo → Paga | GET y POST `/api/accounts-payable/suppliers/:supplierId/payments/:receiptId` | Pagos parciales o liquidación. El PP usa la cuenta de pasivo del GA guardado y actualiza Recepciones, Proveedores, Bancos y Contabilidad |
| Cancelar GA | GET y POST `/:id/actions/cancel-expense` | Previsualiza todos los documentos de la póliza y registra su cancelación en `purchase_expense_cancellations` |

La cancelación se aplica a todos los documentos de la póliza GA web. Requiere motivo, confirmación, fecha dentro del periodo abierto y que se hayan revertido todos los PP del lote. El auxiliar muestra el GA original junto con el movimiento **CG**. Contabilidad invierte los cargos y abonos del GA, incluido IVA y retenciones.

`ERECEP#12/402` agrupa documentos por proveedor y referencia, y líneas por
producto y centro de costo. El saldo por pagar es importe más IVA menos
retenciones de IVA e ISR. `/403` construye la póliza de diario, y `/401`
continúa con su aplicación. El alta web reserva folios `GAW` y pólizas
`3GW`. Los documentos y la póliza se guardan en una transacción. El registro
GA genera Cuentas por Pagar y la póliza aplicada. El movimiento bancario se
genera cuando se registra un PP.

La captura web admite servicios en pesos y documentos con saldo positivo.
Los importes con signo se conservan por renglón y las referencias duplicadas
se validan contra MySQL y PostgreSQL. Si una cuenta fiscal de `FCIA` está
vacía, el usuario elige explícitamente una cuenta elegible para ese impuesto.
En el respaldo local se corroboraron `1119001` para IVA pendiente de pago,
`2016013` para retención de IVA de fletes y `2016018` para ISR RESICO en
pólizas históricas. La consulta del catálogo ofrece esos antecedentes por
concepto contable.

La captura nativa `bank-inline-gastos-multiples-ga.png` muestra la ficha.
`bank-inline-ga-erecep12-proc402-fdoc.png` y las capturas de `/403` muestran
los cargos y abonos. En la prueba local del 23/11/2026 se observó el GA
`GA36183`, por $100.00, con IVA y retenciones de cero, y la póliza
`312512-0003`. El proveedor y el producto de esa prueba habían aparecido
juntos en un GA previo del respaldo. Los requests reproducibles están en
`http/purchasing/purchase-expenses.http`.
El GA de prueba nativo quedó marcado con la referencia `GAT231701`. Se
conservó para evitar el ajuste de existencias que ejecuta la baja estándar
de Recepciones.

## Cancelar una recepción de orden

`GET /api/purchasing/purchase-receptions/:id/actions/cancel-reception`
prepara la baja de una recepción web RW o una RA histórica de TUVANSA y
explica los bloqueos. El POST registra fecha, motivo, confirmación y clave de
reintento. La ficha RA muestra la acción mediante `cancellationAvailable`.
El flujo se contrastó con `MRECEP/25–26,111,136–138` y `MBASE/124` en la
biblioteca German de pruebas.

| Vista | Botón | Evidencia German | Endpoint | Tablas afectadas |
| --- | --- | --- | --- | --- |
| Barra de Recepciones | Eliminar recepción | `MCONTROL/6 → MRECEP/25`, exportación `20261120-MCONTROL-EDITAR` | Los mismos GET y POST de **Cancelar recepción** | Póliza, movimientos, orden, existencias, capas y CxP de la cancelación vigente |
| Barra de Recepciones | Editar recepción | `MCONTROL/7` tiene ramas para otros módulos y carece de una rama MRECEP | Las ediciones disponibles siguen en Comentarios, Cambia Prv y Piezas | Las que correspondan a cada acción |

La barra ofrece **Eliminar recepción** en recepciones de orden habilitadas.
La confirmación comparte la revisión, las validaciones y la transacción de
la acción en la ficha. **Gastos múltiples** conserva su propia reversión en
la ficha.

Para un producto activo que se dio de alta en el catálogo web, la cancelación
usa una base de existencias heredadas de cero. La disponibilidad en el almacén
se valida con los movimientos y las asignaciones guardados en PostgreSQL.

Se recorrió la barra en Chromium con `RA09214` y PostgreSQL embebido. Se
comprobó el saldo cero, la contrapartida K, la póliza balanceada por
1,013.03, el regreso de seis unidades al pendiente de `OA05036`, la salida
de las existencias y el cambio de saldo en la ficha del proveedor. La
recepción hermana conservó su saldo. Evidencia
`ev_00c894f6f911defa55621c62851df71ffff863db26b93a5924c0bf5eac7a3255`.

La transacción conserva el folio, expone sus partidas K, resta las unidades
recibidas del almacén, devuelve las cantidades al pendiente de la orden
y revierte el pasivo y las contrapartidas contables de la recepción,
incluido el IVA. Respeta los pagos vigentes, el periodo abierto y la
existencia libre. Una segunda recepción de la misma orden conserva sus
propios efectos.

### Recepciones RA de Omnis

| Vista / acción | Origen de la comprobación | Efecto web |
| --- | --- | --- |
| Recepciones / Cancelar recepción | MySQL adaptado. `FDOC` y `FAX` por `DSEQ`. Un único cargo RA pendiente en pesos, dentro del periodo abierto | La ficha mantiene las partidas, muestra el estado cancelado y deja saldo cero. El Auxiliar agrega la contrapartida K |
| Orden de compra vinculada | MySQL adaptado. `FDOC.DREFER`, `FPENC.PENUM`, `FAXINV.AIPED` y `FPLIN.PLSEQ` | Resta `AICANTF` del surtido y conserva la asignación y el importe histórico `PESURT` |
| Inventarios / Existencias y Documentos | MySQL adaptado. `FAXINV.AICANT`, unidad y almacén originales, `FINV`, `FALM` y `FCAJAS` | Registra la salida inversa K por el mismo costo y almacén con referencia al folio original |
| Proveedores / Saldos y Movimientos | MySQL adaptado. Cargo RA de `FAX`, sin pagos PP ni compensaciones previas | Retira el saldo abierto y agrega el abono K junto al cargo histórico, con enlace a su póliza |
| Contabilidad / Pólizas | MySQL adaptado. `FAX.APOLIZA`, `FPOLIZA`, `FBANMOV`, `FBENC` y cuentas de `FCIA` | Registra póliza aplicada e inversa con las mismas cuentas y centros verificados de inventario, IVA y proveedor |

La operación se guarda en una transacción de PostgreSQL independiente del
registro de origen. Los efectos requieren una orden vigente con partidas
vinculadas, unidades base con factor uno y cantidades libres suficientes.
La aplicación verifica otra vez la recepción y las existencias bajo los
bloqueos de escritura. Los pagos históricos, costos estándar, impuestos
especiales, capas, piezas físicas nativas o lotes quedan fuera de este flujo.
Si la recepción tiene piezas capturadas en la web, la cancelación las retira
en la misma transacción al revertir la entrada. El historial de captura se conserva.
Para la RA histórica, `FDOC.DPZAS` puede contar las unidades ordinarias.
El control de piezas físicas usa `FCAJAS` y las partidas de `FAXINV`.

En Omnis, los ejemplos históricos RA09168 y RA09189 tienen K y póliza inversa
aplicados el 7 de febrero de 2025. La fecha elegida en la web corresponde a
esa fecha de compensación. La prueba web con RA09214 y la orden OA05036
devolvió seis unidades al pendiente. Las otras recepciones conservaron sus
efectos. El cargo de 1,013.03 y el IVA de 139.73 se compensaron y se
retiraron los registros temporales. RA09260 sirve para verificar el bloqueo
por pago PP y RA09280 el bloqueo por existencia insuficiente.

## Acciones de lectura verificadas

| Boton OMNIS | Endpoint | Fuente real |
|---|---|---|
| Auxiliar | `GET /:id/actions/auxiliary` | `FAX LEFT JOIN FDOC`, por `DSEQ`, orden `ASEQ` |
| Clasificar | `GET /:id/actions/classifications` | `DPAR1..DPAR9`; catálogo `FAG`, `AGT 1..9`, `AGTIPO IN (0,2)`, orden `AGNUM`. Rótulos de `FYG.ABITITPAR2` con respaldo de `FCIA.CIAPAR1..9`. |
| Clasificar → Guardar | `PATCH /:id/actions/classifications` | PostgreSQL `tuvansa.purchase_reception_classifications` y `tuvansa.purchase_reception_comments` para el flete. |
| Piezas | `GET /:id/actions/pieces` | Derivada de `EINV#28D/240`. Consulta `FCAJAS.CAJRECEPCION` por folio exacto y agrega las piezas y series guardadas en PostgreSQL |

El modal **Auxiliar del documento** presenta Fecha, T.M., Referencia, Cargos y Abonos, más el total inferior.

### Clasificar y guardar

En German, `ERECEPC#13/24` abre **Clasificadores** (`ERECEP#19`).
`/0` carga los rótulos con `MBASE/91` y `MEMTIPOPAR=2`. `/239–240`
ordena las opciones de `FAG` por `AGNUM` y selecciona el `AGTNUM`
vigente. **Guardar** pasa por `INICIO/30` con `ERECEP#19/19` y
actualiza los nueve `DPAR` de `FDOC` con `MBASE/77` y `/69`.
La ventana también abrió en la recepción cancelada `RA09189`.
Evidencia `20261124-ERECEP19-FIELDS-PROCEDURES.txt` y
`bank-inline-receipt-secondary-07.png`.

El PATCH recibe los nueve valores `current` y la `revision` del GET.
Los cambios aceptan un `AGTNUM` de su propio grupo o un valor vacío.
El editor permite conservar códigos históricos fuera del catálogo.
La revisión evita sobrescribir una clasificación o flete modificados desde otra ventana.
La persistencia derivada guarda únicamente las modificaciones y aplica la
misma referencia de flete en **Comentarios**, **Clasificar** y la ficha.

La verificación web de RA09214 cambió Tipo de proveedor de 801 a 802,
releyó el valor en PostgreSQL y retiró sólo la modificación de prueba
(`ev_d7694601801c2699435e1a82b8e7443b77fef0d3f630f3551ea1b3e9e51972de`).
Los accesos individuales al cuadro quedan en la sesión de Omnis.

## Piezas en una recepción

En German de pruebas, **Piezas**, **Alta Piezas** y **Edita pzas** abren en
la recepción `RA09214`. **Alta Piezas L.** muestra que el complemento
está desactivado. La comprobación usa `ERECEPC#13/20,21,29,71`,
`EINV#22A/401,411`, `EINV#28D/14,18,240` y `ECIA#11JC/600`.

### Traspaso desde la orden de compra

**Nueva recepción → OK** (`POST /`) guarda las piezas en la misma
transacción que la entrada. `MRECEP/38 → 110` busca las filas de
`FCAJAS` cuyo `CAJFACTURA` y `CAJRECEPCION` coinciden con el folio de
la orden. `EOC#17` asigna esos dos valores al dar de alta la pieza.
La consulta de la API es derivada de esos procedimientos.

La primera recepción, aunque sea parcial, traslada todo el conjunto.
Cada pieza conserva su identificador y serie, toma el folio, fecha y
almacén de la recepción, y queda libre de referencias a pedido y factura.
El movimiento de existencias y el pendiente de la orden reflejan solamente
las cantidades recibidas. Los sucesivos folios y reintentos conservan una
sola ubicación por pieza.

`MRECEP/111` bloquea la cancelación si encontró piezas ligadas a una
factura. La web comprueba ese vínculo para la recepción RW y retira las
piezas libres en la misma transacción que revierte el movimiento. El
historial conserva la orden de origen. En la copia consultada, la
vinculación directa por serie en Facturación usa `CIACOMPORTA[53]`, con
valor `0`. `MFACT/38 → 110 → 116` propaga piezas previamente asignadas a
un pedido, condición sin casos observados en esta instalación.

### Acciones por pieza y por partida

| Acción | Endpoint | Efecto |
| --- | --- | --- |
| Alta Piezas / Edita pzas | `GET /:id/actions/pieces/lines/:lineId` | Lee la partida seleccionada, su valor de piezas, la cantidad disponible y la serie propuesta por el consecutivo PZ |
| Alta Piezas | `POST /:id/actions/pieces/lines/:lineId` | Registra una pieza, suma la cantidad a la partida y refleja el control de piezas en **Inventarios → Otros**. Valida el saldo, la serie única y la revisión de la partida |
| Edita pzas | `PATCH /:id/actions/pieces/lines/:lineId` | Guarda el texto de la partida. Una captura libre puede impedir una alta posterior hasta que el valor vuelva a ser numérico |
| Cambiar serie | `PATCH /:id/actions/pieces/:pieceId/serial` | Cambia la serie de la pieza seleccionada tras verificar el número anterior y la disponibilidad de la nueva serie |

**Filtrar producto** conserva las filas con el código seleccionado y recalcula
los totales visibles. Las altas y cambios de serie de la web quedan en
PostgreSQL con referencia al documento de origen. La captura manual usa el
almacén de la partida y el pedimento de la recepción. La entrada original
ya registró la existencia, el pasivo y la póliza. Una pieza entra en
**Inventarios → Piezas surtidas** cuando tiene una factura vinculada.

## Comentarios y Documenta

| Acción | Endpoint | Procedimiento y datos |
| --- | --- | --- |
| Comentarios | `GET /:id/actions/comments` | Derivada de `ERECEPC#13/25 → MRECEP/85 → ERECEPC#6`. Lee `FCOMENT.COMSEQFACT = FDOC.DSEQ` y los campos del encabezado. Los títulos de comentario provienen de `FTIPMV` por el primer carácter del folio |
| Comentarios / OK | `PATCH /:id/actions/comments` | Guarda la revisión, observaciones y campos de encabezado en PostgreSQL. La ficha presenta los datos capturados y los movimientos y las pólizas leen los datos originales del registro |
| Documenta | `GET /:id/actions/document` | `ERECEPC#13/27 → ERECEP#100`. La ventana acepta cuatro pares de documento e importe y presenta la diferencia |
| Documenta / OK | `POST /:id/actions/document` | Derivada de `MBASE/34,35`. Liquida el cargo original en el auxiliar con DO y genera un cargo por cada documento, para el mismo proveedor, con la fecha original y el vencimiento vigente de la ficha |

En Comentarios, el formulario conserva el folio y el proveedor como campos de consulta.
La quinta línea admite saltos de línea, incluidos los comentarios históricos con retornos de carro.
**Cancelar** descarta el borrador. El guardado verifica la revisión antes de actualizar los campos.
La búsqueda de folios web usa la referencia, la orden y el almacén editados.
Las búsquedas de folios históricos consultan los datos de MySQL y su ficha muestra los cambios guardados en la web.

En Documenta, TUVANSA tiene el tipo DO configurado. La ventana nativa comprobada en
`RA09214` mostró una diferencia inicial de 1,013.03. La web requiere una recepción
vigente en pesos con saldo completo, de uno a cuatro folios distintos con importe
positivo y una diferencia de 0.00. La recepción original queda saldada y sus documentos
se consultan como cargos pagables del proveedor. El traspaso corresponde a Cuentas por Pagar.
La documentación bloquea la cancelación de la recepción.

## Cambia Prv

| Acción | Endpoint | Evidencia y efecto |
| --- | --- | --- |
| Cambia Prv / Confirmar | `GET /:id/actions/change-supplier` | `ERECEPC#13/23`, acceso `ERECEPC#13/44` y captura de proveedor en `ECIA#26`. La ficha devuelve el proveedor vigente y la revisión |
| Buscar proveedor | `GET /:id/actions/change-supplier/suppliers?code=…&name=…` | Derivada de `ECIA#26/100 → INICIO/44`. Consulta proveedores elegibles por código o nombre |
| Búsqueda de proveedor / OK | `PATCH /:id/actions/change-supplier` | La lectura usa `FDOC.DSEQ`, `FAX`, `FAXINV` y la línea de pasivo de la póliza. PostgreSQL guarda el proveedor efectivo y el vínculo original |

Se observó la confirmación y el selector en la RA pendiente `RA09214`, en
la pagada `RA09260`, en la cancelada `RA09189` y en el gasto `GI1169` con
movimientos DO y PP. El procedimiento nativo cambia `PRVSEQ` en `FDOC`,
`FAX` y `FAXINV` por el mismo `DSEQ`, y reconstruye `DPARA`, `DPAR0` y
`DCLINOM`. La ventana no comprueba dependencias externas antes de aceptar.

La web habilita RA/RW vigentes en pesos con el cargo original íntegro,
sin historial de pagos o documentación, y con un proveedor activo en la
misma cuenta contable del pasivo. Así se traslada el saldo completo en la
ficha, Auxiliar, **Proveedores → Saldo/Movimientos** e **Inventarios →
Documentos**. Las consultas históricas de compras por proveedor y compras
desglosadas también reflejan el proveedor efectivo. En las recepciones RW,
el proveedor efectivo puede pagar el cargo o registrarlo con Documenta.

La cancelación revierte el movimiento, la póliza y la orden de origen.
El movimiento K de Cuentas por Pagar se registra con el proveedor vigente.
La revisión protege cambios simultáneos y permite regresar al proveedor original.

## Etiquetas

**Etiquetas** consulta `GET /:id/actions/labels`, que devuelve los formatos
A–F configurados en `FYG.PCL_Z201_BI*` y las partidas con cantidad facturada
positiva. `ERECEPC#13/26` usa `ECPAETIEAN/151(2,#SHIFT)` cuando está activo
`CIACOMPORTA[74]`. `ECPAETIEAN/153` carga cada partida por `FAXINV.AISEQ`
y toma `AICANTF` para las copias. La captura del selector del documento
`RA09214` confirmó el formato A por defecto.

La vista previa web usa el formato elegido y las referencias de producto
de `FINV` y `FINV2`. Redondea a copias enteras y usa la partida enfocada
si se abre con **Mayús**. **Imprimir** abre la impresión del navegador.

## Botones conservados sin mutacion

La vista conserva Imprimir, Tiket > Factura, Traspaso y Reporte pedimento.

Estas acciones secundarias se muestran con un aviso de sólo lectura.

## SQL real capturado

- Encabezado: `FDOC LEFT JOIN FCLI LEFT JOIN FPRV`, localizado por `DSEQ`.
- Partidas: `FAXINV LEFT JOIN FDOC LEFT JOIN FINV LEFT JOIN FLOTES`, por `FDOC.DSEQ`, orden `AISEQ`.
- Auxiliar: `FAX LEFT JOIN FDOC`, por `FDOC.DSEQ`, orden `ASEQ`.
- Clasificadores: nueve consultas sobre `FAG`, una por `AGT` de 1 a 9.

Documento de comprobacion utilizado: `RA10724` (`DSEQ=421564`, orden `OA06307`), con dos partidas.
La consulta de captura proyecta `FCIA.CIAFI/CIAFF` como `DATE` después de
resolver el centinela `1900-12-31`. Así se conserva la fecha de recepción
en formato `AAAA-MM-DD` en MySQL 5.1.

### Recepción parcial, pago y reversión

El 24/11/2026, Chromium abrió **Nueva recepción** y registró dos
entregas de una unidad sobre una orden de dos unidades. Cancelar el
borrador conservó el pendiente. Los enlaces de **Auxiliar** y las pólizas
identificaron ambas entregas.

En una segunda prueba, una orden de dos unidades del producto `01511263`
recibió una unidad con PEPS. La recepción incrementó la existencia de 5 a
6 y dejó 1 unidad pendiente. El cargo al proveedor y su póliza fueron de
185 MXN. Un PP de 40 MXN redujo el pendiente de pago a 145 MXN. El corte
del PP dejó el saldo bancario de prueba en −40 MXN.

La cancelación de la recepción con el PP activo devolvió conflicto
sin cambiar la existencia ni el pendiente de la orden. El RP reabrió
los 185 MXN, conservó el corte del pago y tuvo su propio corte, que
regresó el saldo bancario a cero. Al cancelar la recepción, su
contrapartida K agotó la misma capa, dejó 2 unidades pendientes en la
orden y devolvió la existencia y el saldo del proveedor a sus valores
de apertura. La póliza de cancelación quedó aplicada y cuadrada. Los
reintentos recuperaron los registros y se retiraron los datos temporales.
