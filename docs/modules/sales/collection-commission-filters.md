# Filtros de cliente y agente en comisiones

Actualización 2026-11-11. Amplía el Reporte Comisiones x Cobranza de Ventas sin
cambiar los filtros existentes de movimientos desde/hasta, sucursal y agente.

| Vista | Etiqueta visible | Referencia / marcador | Procedencia | Endpoint | Tablas |
| --- | --- | --- | --- | --- | --- |
| Reporte Comisiones x Cobranza | Cliente / Vista previa | Solicitud 2026-11-11; sin captura OMNIS nueva | Derivada | GET /api/sales/reports/collection-commissions | FAX, FDOC, FCLI, FAG, FAXINV, FINV |
| Seleccionar cliente para comisiones | Código o nombre del cliente / Seleccionar | Reutiliza búsqueda existente de clientes | Sin SQL nuevo de búsqueda | GET /api/accounts-receivable/clients?q=...&status=all&page=1&pageSize=25 | FCLI |
| Liquidación y ajustes | Recalcular liquidación | Mismos filtros del reporte | Derivada, READ ONLY | POST /api/sales/reports/collection-commissions/preview | Mismas tablas del reporte |
| Excel | Descargar Excel | Exporta respuesta filtrada | Sin SQL adicional | Exportación local | Sin consultas nuevas |

## Contrato

Se agrega `customerId` opcional: entero positivo seguro, identidad **FCLI.CLISEQ**.
GET acepta su representación decimal en query; POST preview lo conserva dentro
de criteria. Omitirlo significa todos los clientes. No se agregan valores por
defecto a peticiones anteriores. Un identificador válido sin documentos devuelve
el resultado vacío normal. Cero, negativos, fracciones, booleanos, arrays,
objetos, enteros no seguros y expresiones SQL se rechazan antes del datasource.

El usuario busca por código o nombre en el catálogo existente (incluye clientes
inactivos para consultar sus movimientos históricos), y elige uno. La consulta
del reporte usa su ID exacto; no agrupa clientes por nombres ni coincidencias.
La búsqueda está paginada a 25 resultados, con estado de carga/error/reintento.

Todos los filtros se combinan con AND. El datasource incorpora
`AND d.CLISEQ=?` parametrizado tanto en los PA como en el CTE de eventos D/C/K,
antes de leer partidas. Mantiene el snapshot READ ONLY y la exclusión de servicios.
No restringe a los agentes del documento al seleccionar las notas: su agente se
resuelve por cliente/compañía como en [notas C por vendedor](collection-credit-note-agents.md)
y después se aplica Agente. Una nota reasignada sigue apareciendo al combinar
su cliente con el vendedor efectivo. No cambia importes/costos de cada evento.

## Presentación y alcance

Cliente y Agente son independientes: cualquiera puede quedar en todos, o ambos
pueden seleccionarse. Limpiar cliente conserva fecha, sucursal y agente.
Cambiar un filtro bloquea la exportación anterior hasta regenerar la vista.
Las claves de consulta y POST preview incluyen customerId. Detalle, resumen,
subtotales y liquidación se recalculan sobre el resultado filtrado completo,
sin depender de la página de pantalla. La ventana de búsqueda permanece delante
del reporte y sus eventos no cambian el foco de la ventana padre.

El Excel conserva el formato y añade el alcance de agente/cliente al encabezado
de cada hoja; el nombre del archivo incluye los filtros elegidos. Los totales,
costos, incentivos y liquidación corresponden **sólo a la selección**: con cliente
filtrado, el tabulador no representa la cobranza mensual global del vendedor.
Para esa cobranza debe consultarse el agente con todos los clientes.

## Validación

Pruebas verifican parametrización en ambos conjuntos, combinación con agente y
sucursal/todas, validación GET/POST y conservación de la reasignación de notas C.
La API real concilia ocho combinaciones de dos clientes con cuatro agentes
contra el conjunto sin filtro; incluye combinaciones vacías y sólo notas sin PA.
Navegador verifica búsqueda por código/nombre, selección exacta, regeneración,
limpieza, restauración, liquidación y descargas. Tres Excel se concilian por
fila/agente/total y sus fórmulas se evalúan independientemente, sin Excel nativo.
Evidencia privada bajo captures, `commission-customer-20261111`, fuera de Git.
general_log permanece OFF; no se modifican datos, usuarios ni configuración MySQL.
Validaciones finales: backend lint/build/test (**257 pruebas**), frontend
lint/typecheck/build. El buscador también verifica error/reintento, paginación y
Escape sin cerrar el reporte principal.
