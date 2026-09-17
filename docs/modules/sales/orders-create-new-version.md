# Pedidos: ejercicio de alta desde Nuevo

Seguimiento: la [repetición con SQL real de P021063](orders-create-sql-new-version.md) confirma las escrituras y corrige el vínculo de FCOMENT a `1000000000 + PESEQ`. Este documento conserva la evidencia histórica del primer ejercicio sin general_log.

Fecha: 2026-09-14. Ejercicio solicitado y autorizado en la copia aislada local `tuvansa`. Se utilizó OMNIS SES 37, almacén 01, conservando su posición y tamaño. No se modificaron backend ni frontend. Rama de documentación: `capture/sales-orders-create-new-version`.

## Resultado

Se conservó el pedido de pruebas **P021062**, PESEQ **204818**, cliente **000001**, referencia **PRUEBA140926**. Una partida del producto **01300958**, ISEQ **13288**, cantidad **1 M**, precio **59.05**, subtotal **59.05**, IVA **9.45** y total **68.50**. La moneda visible es PESOS. Fecha 14/09/2026 y almacén 01.

La lectura final confirmó PESPEDIDO=1, PEUSRAUT=0, PLSURT=0 y PLASIGNADO=0; no hay factura con DREFER=P021062 y DEST=0. El pedido permanece abierto en la UI. No se eliminó el registro de pruebas.

## Flujo observado

1. La pantalla inicial de Pedidos estaba vacía, con acciones deshabilitadas. El icono **hoja / Nuevo** de la barra abrió **Captura de pedido** y una lista **Almacén**.
2. Se eligió **01 — SUC. MEXICO**. Otras opciones visibles: 11 NO CALIDAD MEX, 12 RESGUARDO MTY, 13 RESGUARDO VER y 99 TRANSITO MEX.
3. Tipo inicial **P — PEDIDO MEX**. Al capturar cliente 000001 y salir del campo, cargó el nombre, agente 202, número P021062 e IVA 16 %. Fecha, Desde y Vence mostraron 14/09/2026.
4. Campos visibles de encabezado: Tipo, Cliente, Agente y porcentaje, Número, Desde, Pedido del cliente, Fecha, Vence, Depto, Inicial y Puntos Cli. Se escribió PRUEBA140926 en Pedido del cliente.
5. La fila de entrada muestra Código, Descripción, Cantidad, UM, Precio, Dto, Importe, Sucursal y Pzas.; debajo muestra disponibilidad. El producto elegido cargó descripción, unidad M y precio 59.05000 automáticamente.
6. Se capturó cantidad 1. Al recorrer la fila con Tab hasta salir de Pzas., la partida pasó a la lista inferior y el campo Código quedó listo para otra. Se calcularon cantidad 1, peso 16.08, subtotal 59.05, IVA 9.45 y Gran Total 68.50. Flete, seguros, descuentos y anticipo permanecieron en cero.
7. **OK** abrió **Comentarios del pedido**. Incluye referencia, fechas, descuentos 1–3, tipo de cambio, departamento, cajas, volumen, peso, sucursal, moneda de cobro, plazo, comisión, No acepta entregas parciales, tienda que vende, almacén, transporte, Pedido Cliente, Entregar en, Contacto y Obs.; además de campos de texto inferiores y datos de captura/asignación/empaque/autorización. Plazo 30, tienda 302 y almacén 01 vinieron cargados.
8. Se escribió una observación de prueba. La UI limitó el texto y la lectura final confirmó **PRUEBA CODEX - ALTA DES** en PEOBS. No se asume que conservó todo el texto solicitado.
9. **OK** en Comentarios llevó al aviso **¿Continuo?**. Yes abrió otra selección de almacén para una nueva captura. Para salir, se eligió almacén 01 y se pulsó **Cancelar** en la captura vacía. No se guardó un segundo registro.
10. Se buscó P021062 con la lupa. La búsqueda y ficha lo mostraron inicialmente como **Cotización (4)**, pese a Tipo P en la captura.
11. Un clic en **Cotiz** cambió inmediatamente la ficha a **Pedido (1)**, sin confirmación visible. Se verificó PESPEDIDO=1 mediante lectura posterior. No se pulsó Autorizar, Asignar todo ni ninguna operación de facturación.

## Diferencias y puntos a capturar en SQL

- La evidencia anterior de `orders-capture.md` corresponde a **Duplicar**. Este ejercicio cubre **Nuevo**, con selección inicial de almacén, fila de captura, Comentarios y continuación de altas.
- En este caso Nuevo produjo inicialmente una cotización. No generalizarlo a todas las configuraciones: hay que capturar qué regla establece PESPEDIDO=4. La conversión observada por Cotiz termina en 1.
- La API actual ya tiene POST `/api/sales/orders`; no se afirma equivalencia completa con este flujo nuevo sin su SQL literal.
- La lectura con `FCOMENT.COMSEQFACT = 10000000 + PESEQ` encontró cero filas para este registro. La observación sí quedó en FPENC.PEOBS. Esto difiere del alta por Duplicar documentada anteriormente y requiere investigar el vínculo real de comentarios; no se generaron filas manualmente para igualar la documentación.
- No se verificó el comportamiento de No en ¿Continuo?, ni de errores de guardado, cancelación de una captura con partidas o asignación automática.

## Procedencia y trazabilidad

**No se activó general_log. No hay SQL nuevo clasificado como capturada o adaptada en este ejercicio.** Los marcadores son de UI y no intervalos de una captura SQL. Las consultas de comprobación son **derivadas**; sólo establecen el estado observado antes/después, no la secuencia literal de escrituras de OMNIS.

| Vista | Control | Marcador UI | Endpoint existente relacionado | Tablas comprobadas | Evidencia |
|---|---|---|---|---|---|
| Pedidos | Hoja / Nuevo | 03-new | POST /api/sales/orders | FPENC, FPLIN | Visual y lecturas derivadas |
| Captura de pedido | Almacén / Cliente / Producto | 04-warehouse, 05-customer, 07-product | POST /api/sales/orders | FCLI, FINV | Visual y lecturas derivadas |
| Captura de pedido | OK | 11-save | POST /api/sales/orders | FPENC, FPLIN | Visual |
| Comentarios del pedido | OK | 13-comments-ok | POST /api/sales/orders | FPENC; comprobación de FCOMENT | Visual y lecturas derivadas |
| ¿Continuo? | Yes | 14-confirm-save | Flujo de UI | Sin SQL observado | Visual; abre otra captura |
| Captura vacía siguiente | Cancelar | 17-cancel-empty | Flujo de UI | FPENC | Sólo una nueva alta del cliente en la comprobación |
| Pedidos | Cotiz | 21-quote-conversion | GET /api/sales/orders/:orderId/actions/quote-conversion es sólo el panel actual | FPENC.PESPEDIDO | Conversión visual; escritura no capturada |

Lecturas de comprobación parametrizadas, **derivadas**:

```sql
SELECT PESEQ, PENUM, CLISEQ, PENUMELLOS, PESPEDIDO, PEFECHA, PEALMACEN,
       PESTATUS, PEPZAS, PEBRUTO, PEDESC, PEIVA, PECANT, PEOBS, PEUSRAUT
FROM fpenc WHERE PENUM = ?;
SELECT PESEQ, ISEQ, PLCANT, PLPRECI, PLUNIDAD, PLSURT, PLASIGNADO
FROM fplin WHERE PESEQ = ?;
SELECT COMSEQ FROM fcoment WHERE COMSEQFACT = ?;
SELECT COUNT(*) AS count FROM fdoc WHERE DREFER = ? AND DEST = 0;
```

Comparaciones adicionales: FINV.IPEDCLI aumentó en 1 para el producto; FTIPMV.TINUM aumentó en 1 para TISEQ=2; FCLI.CLIULTPED quedó en 2026-09-14. Se encontró una sola alta del cliente con PESEQ mayor que el máximo inicial 204817.

## Evidencia local

`captures/ui/new-version/orders-create/` contiene capturas anteriores y posteriores a cada paso, `ui-markers.jsonl`, `baseline.json`, `saved-order.json` y `final-verification.json`. Los archivos están excluidos de Git. `21-quote-conversion.png` muestra el estado final Pedido (1).

Se ejecutó `SHOW GLOBAL VARIABLES LIKE 'general_log'` al inicio y al final: **OFF**. No hubo reinicios de MySQL. No se cambió código ejecutable, por lo que no fue necesario repetir lint/build/tests para este ejercicio de UI y documentación.
