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

## Pólizas de recepciones web

| Consulta | Origen de la póliza web |
| --- | --- |
| Detalle y apertura por número | `purchase_receptions.accounting` en PostgreSQL |
| Búsqueda y navegación | Pólizas de recepción junto con el historial `FPOLIZA` |
| Clasificar | Catálogo de consulta `FAG` |

La póliza se guarda en la misma transacción que la recepción, el movimiento de inventario y el cargo al proveedor. La ficha muestra el folio de recepción en **Cheque**, la familia **COMPRAS** y los cargos y abonos guardados. La aplicación automática corresponde a `MRECEP/127 → MPASIVOS/99`. Los nombres de cuenta se consultan en `FBENC`.

Las pólizas **PAGOS PR.** de `supplier_payments` se consultan por las mismas rutas. El abono va a la cuenta bancaria y el cargo va a la cuenta del proveedor con el folio de la recepción. **Cheque** muestra el folio local de cheque o transferencia. La familia, el sentido de los movimientos y el estado aplicado corresponden a `EPRV#25/120`.

## Reportes de la versión nueva

La captura de Contabilidad → Reportes → Estado de resultados se documenta en [income-statement.md](income-statement.md). La lectura usa FCCBENC + FBENC y está disponible en GET /api/accounting/reports/income-statement, con parámetros en GET /api/accounting/reports/income-statement/options y vista imprimible en el frontend.
