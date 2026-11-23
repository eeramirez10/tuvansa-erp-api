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
