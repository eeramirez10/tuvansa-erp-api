# Recepciones de orden de compra

Modulo de solo lectura capturado desde la ventana **Recepciones** de OMNIS. Ruta base:

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

## Acciones de lectura verificadas

| Boton OMNIS | Endpoint | Fuente real |
|---|---|---|
| Auxiliar | `GET /:id/actions/auxiliary` | `FAX LEFT JOIN FDOC`, por `DSEQ`, orden `ASEQ` |
| Clasificar | `GET /:id/actions/classifications` | `DPAR1..DPAR9`; catalogos `FAG`, `AGT 1..9`, `AGTIPO IN (0,2)` |

El modal **Auxiliar del documento** presenta Fecha, T.M., Referencia, Cargos y Abonos, mas el total inferior. **Clasificar** presenta nueve clasificadores y conserva `Guardar` deshabilitado en el frontend.

## Botones conservados sin mutacion

La vista conserva Alta Piezas, Alta Piezas L., Cambia Prv, Comentarios, Etiquetas, Documenta, Imprimir, Piezas, Tiket > Factura, Traspaso, Reporte pedimento, Pedimento y Edita pzas.

No existen endpoints `POST`, `PUT`, `PATCH` ni `DELETE` para este modulo. Esos botones permanecen visibles y abren un aviso de solo lectura hasta la fase de escritura de la nueva base.

## SQL real capturado

- Encabezado: `FDOC LEFT JOIN FCLI LEFT JOIN FPRV`, localizado por `DSEQ`.
- Partidas: `FAXINV LEFT JOIN FDOC LEFT JOIN FINV LEFT JOIN FLOTES`, por `FDOC.DSEQ`, orden `AISEQ`.
- Auxiliar: `FAX LEFT JOIN FDOC`, por `FDOC.DSEQ`, orden `ASEQ`.
- Clasificadores: nueve consultas sobre `FAG`, una por `AGT` de 1 a 9.

Documento de comprobacion utilizado: `RA10724` (`DSEQ=421564`, orden `OA06307`), con dos partidas.
