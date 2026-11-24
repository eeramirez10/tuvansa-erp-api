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

El alta cubre recepciones ordinarias en pesos, con productos sin capas de costo, sin pedimento con importes, sin cargos de importación, sin IEPS, sin retenciones y sin proveedor intercompañía. Los casos de importación y capas requieren la migración de `MRECEP/65,104,105` y de los costos asociados. El folio y la numeración de la póliza se asignan en PostgreSQL.

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
especiales, capas, cajas, piezas físicas o lotes quedan fuera de este flujo.
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
| Clasificar | `GET /:id/actions/classifications` | `DPAR1..DPAR9`; catalogos `FAG`, `AGT 1..9`, `AGTIPO IN (0,2)` |

El modal **Auxiliar del documento** presenta Fecha, T.M., Referencia, Cargos y Abonos, mas el total inferior. **Clasificar** presenta nueve clasificadores y conserva `Guardar` deshabilitado en el frontend.

## Botones conservados sin mutacion

La vista conserva Alta Piezas, Alta Piezas L., Cambia Prv, Comentarios, Etiquetas, Documenta, Imprimir, Piezas, Tiket > Factura, Traspaso, Reporte pedimento, Pedimento y Edita pzas.

Estas acciones secundarias se muestran con un aviso de sólo lectura.

## SQL real capturado

- Encabezado: `FDOC LEFT JOIN FCLI LEFT JOIN FPRV`, localizado por `DSEQ`.
- Partidas: `FAXINV LEFT JOIN FDOC LEFT JOIN FINV LEFT JOIN FLOTES`, por `FDOC.DSEQ`, orden `AISEQ`.
- Auxiliar: `FAX LEFT JOIN FDOC`, por `FDOC.DSEQ`, orden `ASEQ`.
- Clasificadores: nueve consultas sobre `FAG`, una por `AGT` de 1 a 9.

Documento de comprobacion utilizado: `RA10724` (`DSEQ=421564`, orden `OA06307`), con dos partidas.
