# Inventarios P.T. → Consultas → Documentos

El panel abre **Consulta de movimientos de inventario** y su ventana
**Búsqueda** empieza vacía. El documento buscado se selecciona por sus
propios filtros, independientemente del producto que se estaba consultando.

| Control de Omnis 7 | Endpoint | Tablas | Procedencia |
| --- | --- | --- | --- |
| Búsqueda | `GET /api/inventories/movements` | FDOC, FCLI, FPRV | Derivada de `EINV#24/243` → `EMOVSINVFIND/100`; reglas en `/131` y lista en `/133` |
| Abrir el documento | `GET /api/inventories/movements/:id` | FDOC, FAXINV, FINV, FCLI, FPRV | Adaptación basada en el procedimiento `EINV#24/240` |
| Cancelar | `DELETE /api/inventories/movements/:id` | `tuvansa.inventory_movement_documents` y los saldos de apertura de PostgreSQL | Derivada de `EINV#24/41`, `MFACT/112` y `MCPAR03/21` |

El marcador histórico [INV_QUERY_DOCUMENTOS_RETRY](product-buttons-capture.md#inv_query_documentos_retry)
registra la apertura de `EINV#24` y consultas de sesión y configuración.
Los SELECT de la API se implementaron con los campos de la ventana y su
procedimiento. El marcador histórico no contiene los SELECT de Búsqueda.

La búsqueda acepta `document`, `date` en formato ISO, `reference`,
`reference2`, `warehouse`, `supplier`, `customer`, `page` y `pageSize`. Los
filtros de texto son por prefijo y la fecha es exacta. La búsqueda vacía
entrega cero resultados. La lista se limita a 1000 filas con `DESINV=1` y
ordena por el primer filtro activo de fecha, referencia, REF2, proveedor o
cliente. El listado usa el folio como orden predeterminado y desempata por
`DSEQ`.

El detalle usa el `DSEQ` seleccionado y presenta las líneas por `AISEQ`.
Conserva la cantidad firmada de `AICANT` y el costo unitario de `AICOSTO`.
El costo total es la suma de los costos por cantidad. `piecesText` conserva
el valor de origen de `AIPZAS`; `pieces` representa su valor numérico.

La API usa `FDOC.DITIPMV` para exponer el tipo de movimiento del encabezado.

## Prueba de cancelación en Omnis 7

En la biblioteca German de pruebas, el documento `EI1000` (`DSEQ=65047`)
tenía una partida del producto `01300935` con entrada de 2, costo unitario
de 5,777.0850 y costo total de 11,554.17. **Cancelar** pidió confirmación,
mostró **Eliminando movimientos** y terminó en **El documento ha sido
eliminado**. Al aceptar el mensaje, la ventana quedó vacía. Al volver a
buscar el folio, se pudo abrir el mismo encabezado con la partida de tipo
`K`, sin cantidad y con costo cero.

El procedimiento `EINV#24/41` comprueba `DESINV` y `DESFACT`, confirma con
el usuario y recorre las partidas del folio. `MFACT/112` revierte
`FINV.ISTKACT` y `FINV.ISTKPZS`, llama a `MCPAR03/21` y marca el auxiliar
`FAXINV` con `AITIPMV='K'`, cantidad, costo y precio en cero y, para la
compañía probada, piezas en blanco. `MCPAR03/21` deriva la actualización
de almacén a `INICIO/51` cuando corresponde. Otros flujos aplican efectos
en lotes, capas de costo o tránsito. Esta descripción proviene de la
prueba visual y de los procedimientos de la biblioteca. Los comandos de
PostgreSQL son una implementación derivada.

## PostgreSQL

La anulación revierte en una transacción las cantidades y piezas del
producto y, si la apertura lleva saldos por almacén, sus cantidades. Conserva
la versión original y el detalle con partidas `K`. El folio se mantiene en
la búsqueda para consulta histórica y su detalle indica que ya está anulado.
El primer `DELETE` y sus reintentos devuelven `204`. Un documento que carece
de los saldos o de las reglas necesarias se rechaza con `409` antes de
afectar el inventario. Las partidas con lotes, los efectos de capas y los
flujos de tránsito requieren validación adicional. El `GET` de detalle
indica cuándo el botón puede usarse mediante `cancellationAvailable` y
`cancellationReason`.

El valor predeterminado de `INVENTORY_MOVEMENTS_SOURCE` es `mysql` y habilita
la consulta en PROSCAI. El cambio a `postgres` usa los documentos y saldos
cargados en `NEON_DATABASE_URL`. Prepara una apertura conciliada antes del
cambio. El siguiente comando instala la migración `003_inventory_movements`
y carga la apertura una sola vez.

```powershell
pnpm exec tsx scripts/stage-postgres-inventory-movements.ts --snapshot archivo-de-apertura.json
```

El archivo contiene `policy` con `warehouseTracking`, `layerEffects` y
`transitEffects`, `documents` con `header`, `lines` y `totals` del detalle,
`products` con `productId`, `quantity` y `pieces`, y `warehouses` con
`productId`, `warehouse` y `quantity`. Los saldos usan cadenas decimales.
Si una regla se desconoce, usa `null` y el sistema bloqueará la anulación.
El selector afecta únicamente esta ventana. El catálogo y las consultas
de existencias de otros módulos conservan sus fuentes actuales.
