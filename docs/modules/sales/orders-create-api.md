# Alta de pedidos desde la captura de PROSCAI

**Actualización 2026-09-15:** la persistencia se sustituyó por [PostgreSQL/Neon](../../NEON-WRITE-DATABASE.md). Este documento conserva el diseño previo de escritura MySQL como referencia. La URL local quedó configurada y se validó una alta real en Neon; ya no se requieren permisos de escritura MySQL. El folio nuevo tiene prefijo NP y las cantidades se registran localmente.

Implementación del 2026-09-14. Evidencia: [SQL de Nuevo](orders-create-sql-new-version.md), producto 01300958 y cliente 000001. El formulario nuevo usa **POST `/api/sales/orders/capture`**. El POST anterior `/api/sales/orders` conserva su contrato heredado y no es equivalente a esta alta.

## Contrato y procedencia

| Vista | Etiqueta visible | Marcador ORDERS_NEW_000001_ | Procedencia | Endpoint | Tablas | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| Pedidos | Hoja / Nuevo | 03-NEW, 04-WAREHOUSE | Derivada de los catálogos capturados | GET /api/sales/orders/capture/options | FALMCAT, FTIPMV, FAG | Lectura verificada |
| Captura | Cliente | 05-CUSTOMER | Adaptada; JOIN de agente derivado | GET /api/sales/orders/capture/customers/:code | FCLI, FSUCURSALES, FAG | Lectura verificada |
| Captura | Código, Cantidad | 07-PRODUCT, 08-QUANTITY | Adaptada; precio/IVA/disponible derivados y contrastados | GET /api/sales/orders/capture/products/:code | FINV, FUNIDAD, FALM, FTIPMV, FDESCTOS | Lectura verificada |
| Captura | OK | 11-SAVE_OPEN_COMMENTS | Estado de formulario; escritura aplazada | Sin HTTP de escritura | — | Abre Comentarios |
| Comentarios | OK | 11-SAVE_OPEN_COMMENTS, 13-COMMENTS_OK | Adaptada; transacción/folio/cálculos derivados | POST /api/sales/orders/capture | FPENC, FPLIN, FCLI, FINV, FALM, FTIPMV, FCOMENT | Diseño MySQL histórico; alta real actual validada en Neon |
| ¿Continuo? | Sí / No | 14-CONTINUE_NO | Estado de interfaz | Sin escritura adicional | — | Sí inicia otra captura, No abre el alta guardada |
| Pedidos | Cotiz | 15-COTIZ_TO_ORDER | Adaptada; bloqueo/idempotencia derivados | POST /api/sales/orders/:orderId/actions/quote-conversion | FPENC, FPLIN, FINV, FALM | Implementado |
| Pedidos | Comentarios | 13-COMMENTS_OK | Adaptada; compatibilidad con vínculo anterior derivada | GET /api/sales/orders/:orderId/actions/comments | FCOMENT, FPENC | Prefiere base 1 000 000 000; acepta base anterior |

La procedencia **capturada** corresponde sólo a los literales guardados en el reporte de evidencia. Las consultas parametrizadas implementadas son adaptadas o derivadas según la tabla; nunca se presentan como SQL literal de OMNIS.

GET options devuelve `{data:{warehouses,types,agents}}`; cada tipo incluye `nextNumber` orientativo y porcentaje de IVA. Los agentes exponen código interno y código visible (1202 / 202 en el caso). No hay identidad de sesión OMNIS en la API: el listado de almacenes conserva tipo y multicompañía, pero **no replica permisos CATUSUARIOS**. No confundirlo con autorización por usuario.

GET customer devuelve cliente, agente, plazo, tienda, clasificación y sucursales activas. GET product requiere `warehouse`, `typeCode=P` y `customerCode`; devuelve unidad, precio ILISTA1, moneda, impuesto, peso, volumen y disponibilidad. `available=ALMCANT-ALMASIGNADO` es una definición derivada; no se afirma que coincida con el cuadro Disp de OMNIS, que mostró cero en el ejercicio. La búsqueda implementada es por ICOD exacto; EAN, SKU y series quedan pendientes.

POST capture recibe códigos de cliente/productos, almacén, tipo P, fechas, referencia, agente, plazo, tienda, departamento, inicial, observación y hasta 500 partidas. Cada partida contiene código, cantidad positiva (3 decimales), precio (5 decimales) y descuento manual (2 decimales, 0–100). No admite folio, IDs internos ni totales del cliente HTTP. Devuelve **201 `{data: Order}`**, con el mismo DTO del catálogo. Ejemplos: [requests HTTP](../../../http/sales-orders-capture.http).

## Persistencia y límites operativos

- Requiere InnoDB en las siete tablas de escritura. Verifica motores antes de empezar y devuelve 409 si no puede garantizar rollback.
- Bloquea FTIPMV mediante FOR UPDATE, calcula el folio desde TINUM/TICEROS/TICLA y verifica colisiones. El bloqueo serializa las altas de esta API; no se ha probado concurrencia con la numeración interna de OMNIS.
- Revalida cliente, agente, almacén, productos y registros FALM antes de escribir. El folio, las partidas y acumulados se guardan en una sola transacción. La lectura de la respuesta usa la misma conexión antes de COMMIT.
- El producto del caso usa **IPORCIVA=0**, un código que selecciona **FTIPMV.TIIVA0=16**. No se interpreta como 0 %. Se soportan códigos 0–2 y se rechazan códigos desconocidos. El caso 1 × 59.05 produce IVA 9.45 y total 68.50. Dos partidas con cantidades 1 y 2 producen subtotal 177.15, IVA 28.34 y total 205.49 según la fórmula derivada de la API.
- Se limita a precio de lista 1 en PESOS (IMONEDA1=2), sin IEPS. Las cuatro claves de FDESCTOS se consultan; si hay reglas comerciales, se rechaza el alta con un motivo explícito hasta validar su aplicación, vigencia y prioridad. No se ignoran silenciosamente ni se inventa su fórmula. Sí se admite descuento manual por partida.
- Guarda FCOMENT con `1000000000 + PESEQ`, COMDNUM y total en letras; PECLINO conserva `clienteId.folio`. No suplanta el usuario 73 de OMNIS: PEUSRALTA conserva su valor por defecto hasta integrar identidad ERP.
- `documentKind=quote` es el valor predeterminado y el usado por la UI. Reproduce el estado final observado después de Comentarios (4), moviendo el acumulado de pedidos a cotizaciones. `documentKind=order` permite guardar el estado neto de pedido (1) sin realizar la ida/vuelta intermedia: es una adaptación deliberada.
- POST Cotiz sólo convierte 4→1 sin partidas asignadas/surtidas ni autorización. Repetir para un pedido ya convertido no duplica acumulados. La conversión inversa no forma parte del endpoint.
- El número de la pantalla es orientativo; se asigna definitivamente al guardar. No hay reintentos automáticos de creación ni claves de idempotencia persistidas: ante pérdida de respuesta, consultar el catálogo antes de reenviar. La conversión sí es idempotente por estado.

## Diferencia deliberada del flujo

En OMNIS el primer OK ya inserta el pedido. En el frontend el primer OK abre Comentarios conservando el borrador; el OK final persiste todo. Cancelar Comentarios vuelve a la captura y cerrar solicita descartar el borrador. Así, cancelar antes del guardado no deja registros intermedios.

Se replica el alta ejercitada, con campos, orden de columnas, totales y Comentarios. Los controles secundarios sin escritura validada (descuentos globales, flete, seguros, entrega, sucursal por partida, transporte y campos adicionales) están de sólo lectura; no se envían valores ficticios. El mantenimiento antiguo de pedidos (editar/borrar) no forma parte de esta implementación y no debe asumirse equivalente a la contabilidad de inventario del alta nueva.

## Validación

Lecturas verificadas contra la copia local: almacenes, agente visible 202/interno 1202, cliente 000001, producto 01300958, precio 59.05 e IVA 16 %. SQL funcional capturado anteriormente; **esta implementación no activó general_log**.

El intento histórico de alta en MySQL no llegó a INSERT porque la cuenta carecía de permisos para `SELECT ... FOR UPDATE` sobre FTIPMV; dejó MAX(PESEQ)=204819 y devolvió **503 ORDER_CAPTURE_WRITE_UNAVAILABLE**. No se otorgaron permisos ni se crearon usuarios. El datasource actual de Neon no usa ese bloqueo: el 2026-09-15 se verificó por HTTP y PostgreSQL el alta, lectura, edición, Cotiz y baja lógica de **NP5000000000**. Véase la [verificación de Neon](../../NEON-WRITE-DATABASE.md).

Pruebas automatizadas: validación HTTP/fechas/partidas; importes; contador bloqueado y colisiones; motores; rollback después de escribir encabezado; múltiples partidas; vínculo de comentarios; lectura dentro de la transacción; conversión sin duplicar acumulados; rechazo de partidas asignadas y error de permisos sin datos sensibles. Backend: `pnpm lint`, `pnpm build`, `pnpm test`.

Navegador: carga real, dos partidas y total 205.49, Comentarios, rechazo real de escritura conservando los campos; éxito, ¿Continuo? y Cotiz comprobados **con respuestas HTTP simuladas**, sin otro pedido real. Evidencia local: `captures/ui/new-version/orders-web/`. Frontend: `pnpm lint`, `pnpm typecheck`, `pnpm build`. No hay pruebas nuevas sobre OMNIS ni reinicios de MySQL.
