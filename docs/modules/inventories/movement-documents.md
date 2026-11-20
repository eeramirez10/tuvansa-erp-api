# Inventarios P.T. → Consultas → Documentos

El panel abre **Consulta de movimientos de inventario** y su ventana
**Búsqueda** empieza vacía. El documento buscado se selecciona por sus
propios filtros, independientemente del producto que se estaba consultando.

| Control de Omnis 7 | Endpoint | Tablas | Procedencia |
| --- | --- | --- | --- |
| Búsqueda | `GET /api/inventories/movements` | FDOC, FCLI, FPRV | Derivada de `EINV#24/243` → `EMOVSINVFIND/100`; reglas en `/131` y lista en `/133` |
| Abrir el documento | `GET /api/inventories/movements/:id` | FDOC, FAXINV, FINV, FCLI, FPRV | Adaptación basada en el procedimiento `EINV#24/240` |

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

En la ventana probada de Omnis, EI1000 mostró una entrada con cantidad 2,
un costo unitario de 5,777.0850 y costo total de 11,554.17. La API usa el
campo físico `FDOC.DITIPMV` para exponer el tipo de movimiento mostrado por
Omnis.
