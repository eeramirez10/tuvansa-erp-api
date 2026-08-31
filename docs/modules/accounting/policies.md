# Contabilidad - Polizas

Modulo de solo lectura capturado desde la ventana **Polizas** de OMNIS. Ruta base:

`/api/accounting/policies`

## Pantalla principal y barra

| Vista o boton OMNIS | Endpoint | Fuente real |
|---|---|---|
| Poliza y movimientos | `GET /:policyId` | `FPOLIZA`; movimientos `FBANMOV + FBENC` |
| Buscar | `GET /` | `FPOLIZA` |
| Abrir por numero | `GET /by-number/:number` | `FPOLIZA` |
| Flecha anterior | `GET /:id/previous` | `PONUM < numero`, orden descendente |
| Flecha siguiente | `GET /:id/next` | `PONUM > numero`, orden ascendente |

El criterio real capturado para la vista es:

```sql
POEST = 0 AND POCIA = 1
```

El buscador reproduce **Poliza, Fecha, Aplic., Familia de Poliza y Cheque**. OMNIS usa busqueda por prefijo de `PONUM` y ordena por `PONUM, POSEQ`.

## Movimiento contable

| Columna de la pantalla | Campo real |
|---|---|
| Codigo | `FBENC.BCOD` |
| Cuenta | `FBENC.BNOMBRE` |
| Cargos | `FBANMOV.BAIMPOR` |
| Abonos | `FBANMOV.BAIMPORNEG` |
| C.C. | `FBANMOV.BACENCOS` |
| Refer. | `FBANMOV.BABENEF` |
| T.C. | `FBANMOV.BATIPOC` |

Los totales se calculan sumando cargos y abonos. `difference` permite comprobar que la poliza este balanceada.

## Accion de lectura verificada

| Boton OMNIS | Endpoint | Fuente real |
|---|---|---|
| Clasificar | `GET /:id/actions/classifications` | Valores `POPAR1/POPAR2`; catalogo `FAG`, `AGT=4`, `AGTIPO=3` |

## Acciones conservadas sin escritura

Comentarios, Duplicar, Duplicar pasivo, Imprimir, Aplicar y Des-Aplicar aparecen en la interfaz. No se publican endpoints de mutacion porque esta etapa solamente permite lectura.

La poliza `312608-0438` (`POSEQ=598128`) se utilizo para comprobar encabezado, dos movimientos y balance de cargos/abonos.
