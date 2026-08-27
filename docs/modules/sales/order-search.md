# Pedidos - buscador

## Ventana OMNIS

El icono de búsqueda abre la ventana `Búsqueda`. Su fila superior contiene los
criterios Pedido, Ped. Cliente, Cliente, Fecha, Vencimiento, Agente, Status,
Sucursal, Almacén, Autoriz. y `% surt`. La lista permite seleccionar con un clic
y abrir el pedido con doble clic o con `OK`. `Cancelar` sólo cierra la ventana.

La consulta observada al buscar `P010773` fue:

```sql
SELECT FPENC.PESEQ, PENUM, PENUMELLOS, CLICOD, PEFECHA, PEVENCE,
       PESPEDIDO, PEBRUTO, PEDESC, PESURT, PESUCURSAL, PEPAR9
FROM FPENC
LEFT JOIN FCLI ON FPENC.CLISEQ = FCLI.CLISEQ
WHERE PENUM >= 'P010773'
  AND PENUM <= CONCAT('P010773', CHAR(255))
  AND PESPEDIDO IN (1, 4)
ORDER BY PENUM, FPENC.PESEQ
LIMIT 32767;
```

La API conserva la búsqueda por prefijo mediante parámetros preparados y añade
paginación para no transferir decenas de miles de filas de una sola vez.

## Endpoint de sólo lectura

```text
GET /api/sales/orders
```

Parámetros específicos: `orderNumber`, `customerOrderNumber`, `customerCode`,
`orderedAt`, `dueAt`, `agent`, `status`, `branch`, `warehouse`, `authorization`
y `minimumFulfillmentPercentage`. También se conservan `q`, `from`, `to`,
`page` y `pageSize` para los consumidores existentes.

`Pedidos O.K.` envía `authorization=O.K.` y filtra `PEUSRAUT > 0`. Esta ruta no
ejecuta `INSERT`, `UPDATE` ni `DELETE`.
