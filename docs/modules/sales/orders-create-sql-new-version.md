# Pedidos: SQL de alta en la versión nueva

Captura del 2026-09-14 en la copia aislada local `tuvansa`, con creación autorizada. Complementa el [ejercicio visual anterior](orders-create-new-version.md): aquel creó P021062 sin general_log; esta repetición creó **P021063**, PESEQ 204819, partida PLSEQ 799554. No se modificó código de backend ni frontend.

## Evidencia y resultado

General log de MySQL 8.0.21, OMNIS PID 14040 / SES 12 / **thread_id 12**, correlacionado con su conexión local y el pedido observado en pantalla. Cada acción tiene START/END, hora UTC y desplazamientos de bytes en `markers.jsonl`. Los marcadores son del colector local, no sentencias atribuidas a OMNIS.

Evidencia local excluida de Git: `captures/sql/new-version/sales/orders-create-20260914-171356/`. Reporte con SQL literal completo: `captures/sql/new-version/sales/orders-create.md`. Incluye capturas anteriores/posteriores por navegación, log crudo, eventos filtrados, SQL funcional en orden y contexto separado. Prepare y Execute permanecen en el log; para contar ejecuciones no se duplica Prepare.

Resultado: cliente 000001, producto 01300958, almacén 01, cantidad 1 M, precio/subtotal 59.05, IVA 9.45 y total 68.50 PESOS. Referencia SQL140926, observación PRUEBA SQL NUEVO. Terminó como Pedido (PESPEDIDO=1), sin autorización, asignación, surtido ni factura activa. Sólo se encontró un encabezado posterior al máximo inicial 204818.

## Vista, botón, marcador y API

Todos los marcadores de esta tabla llevan prefijo `ORDERS_NEW_000001_`. Las sentencias del log son **capturadas**. Las lecturas de comprobación son **derivadas**, no SQL de OMNIS. No se generaron consultas **adaptadas** en este trabajo.

| Vista / botón visible | Sufijo del marcador | Endpoint relacionado | Tablas principales |
| --- | --- | --- | --- |
| Menú / Pedidos | 02-OPEN | Catálogos de apoyo al alta, equivalencia pendiente | FCIA, FALMCAT, FTIPMV |
| Pedidos / icono hoja Nuevo | 03-NEW | POST /api/sales/orders, preparación | FALMCAT |
| Captura de pedido / Almacén | 04-WAREHOUSE | POST /api/sales/orders, preparación | FTIPMV |
| Captura de pedido / Cliente | 05-CUSTOMER | POST /api/sales/orders, preparación | FCLI, FSUCURSALES, FTIPMV, FAG, FYG |
| Captura de pedido / Código | 07-PRODUCT | POST /api/sales/orders, preparación | FINV, FUNIDAD, FSKUS, FCAJAS, FINV2, FALM |
| Captura de pedido / Cantidad | 08-QUANTITY | POST /api/sales/orders, descuentos | FDESCTOS |
| Captura de pedido / OK | 11-SAVE_OPEN_COMMENTS | POST /api/sales/orders | FPENC, FPLIN, FCLI, FALM, FINV, FTIPMV |
| Comentarios del pedido / OK | 13-COMMENTS_OK | POST /api/sales/orders y panel de comentarios | FCOMENT, FPENC, FALM, FINV |
| ¿Continuo? / No | 14-CONTINUE_NO | Sin escritura observada | FPENC, FPLIN, FAG, FINV2 |
| Pedidos / Cotiz | 15-COTIZ_TO_ORDER | Operación de conversión por definir; consultar el panel no equivale a convertir | FPENC, FALM, FINV |

Referencia (06-REFERENCE), recorrido de campos (09-LINE_FIELDS), incorporación visual de partida (10-ADD_LINE) y observación (12-OBSERVATION) no emitieron SQL en sus intervalos. Escribirlos en la UI no equivale a persistirlos.

## Secuencia de persistencia confirmada

1. **OK de Captura** realiza nueve escrituras: inserta FPENC inicialmente con PESPEDIDO=1; actualiza CLIULTPED; incrementa ALMPEDIDO; inserta FPLIN; incrementa IPEDCLI y PEPZAS; guarda totales; incrementa FTIPMV.TINUM y actualiza PENUM/PECLINO. PECLINO observado: `15331.P021063`.
2. **OK de Comentarios** realiza cinco escrituras: inserta FCOMENT, actualiza PEOBS y PEPAR7, cambia PESPEDIDO a 4, resta uno de ALMPEDIDO y transfiere una unidad de IPEDCLI a IPEDCOTIZ.
3. **Cotiz**, desde esa cotización, realiza tres escrituras: cambia PESPEDIDO a 1, incrementa ALMPEDIDO y transfiere una unidad de IPEDCOTIZ a IPEDCLI.

No se debe generalizar la transición automática a cotización a todas las configuraciones: se confirmó en este caso. La captura no prueba la regla interna que decide el tipo. El botón No terminó el ciclo sin crear otro encabezado.

El vínculo **capturado y comprobado** de comentarios es `COMSEQFACT = 1000000000 + PESEQ`: 1000204819 para P021063. OMNIS también insertó COMDNUM y COMLETRA. La búsqueda con base 10000000 del ejercicio anterior era incorrecta para este alta.

## Consultas, filtros y totales

- Almacenes: FALMCAT con filtros de tipo, compañía, multicompañía y usuarios; orden CATTIPO/CATSEQ. Tipo de movimiento por TICLA='P'.
- Cliente por CLICOD, sucursales con LEFT JOIN FCLI por CLISEQ; inicialmente SUCBAJA='1900-12-31', orden CLISEQ/SUCSEQ. Agente por AGTNUM y parámetros especiales en FYG.
- Producto: busca sucesivamente IEAN, FSKUS.SKUSKU, FCAJAS.CAJSERIE y FINV.ICOD. FINV se une a FUNIDAD por USEQ; FINV2 por I2KEY y existencias FALM por ALMKEY. No convertir los espacios de ALMKEY en una concatenación sin verificar el formato.
- Descuentos: cuatro búsquedas en FDESCTOS por DESKEY para cliente/producto, cliente/clasificación, comodín/producto y cliente/comodín, orden DESSEQ. Los LIMIT observados no equivalen a paginación diseñada para HTTP.
- Detalle: FPLIN LEFT JOIN FPENC por PESEQ y FINV por ISEQ, filtro FPENC.PESEQ y orden FPENC.PESEQ/FPLIN.PLSEQ. Las recargas de ficha también unen FCLI y FPRV por sus claves.
- **No se capturó SUM()**. OMNIS consultó PLCANT, PLPRECI, PLDESC, IPORCIVA e IPORCIEPES de las partidas y después ejecutó `UPDATE fpenc SET PEPZAS=1,PEBRUTO=59.05,PEDESC=0,PEIVA=9.45,PEIEPES=0,PECANT=68.5 WHERE PESEQ=204819`. El cálculo en cliente se infiere de esa secuencia; no se inventa una consulta SQL de sumatoria.

## Comparación con documentación y API existentes

El flujo visual coincide con el ejercicio anterior: selección de almacén, encabezado, renglón, Comentarios y conversión Cotiz. Esta vez se eligió No en ¿Continuo?; no fue necesario iniciar/cancelar otra captura. La documentación previa de Duplicar no sustituye esta evidencia de Nuevo.

El datasource actual crea FCOMENT con base **10_000_000**, y su panel consulta esa misma base. Difiere de la base **1_000_000_000** capturada. También deben revisarse los acumulados FALM, el contador FTIPMV, la composición PECLINO, los campos de comentarios y la transición 1→4→1 antes de declarar equivalente POST /api/sales/orders. Estas diferencias quedan documentadas; no se corrigió la API durante la captura.

## Cierre y límites

Se restauró `C:\ProgramData\MySQL\MySQL Server 8.0\proscai_my.ini`; SHA-256 original/restaurado: `9193373D6A7BD039DD0517FDB7A1F4A833AC65294A5DDBCCB2903D3FFB7617A2`. El archivo principal my.ini permaneció sin cambios. MySQL80 quedó **Running** y se ejecutó `SHOW GLOBAL VARIABLES LIKE 'general_log';`, resultado **OFF**, comprobado nuevamente a las 23:26:26 UTC. OMNIS no se cerró; su sesión puede necesitar reconexión después del reinicio de restauración.

IPEDCLI pasó de 1571.42 a 1572.42 y TINUM de 21062 a 21063. Los valores finales ALMPEDIDO=1966.87 e IPEDCOTIZ=309840 están registrados; no había lectura basal de esos dos campos, por lo que sus cambios netos se deducen de las sentencias, no de una comparación de snapshots.

No se capturaron errores, concurrencia, cancelación con partidas ni rollback. Los pedidos de prueba permanecen guardados. Validación documental y de evidencia; no se ejecutaron lint/build/test porque no se modificó código de aplicación.
