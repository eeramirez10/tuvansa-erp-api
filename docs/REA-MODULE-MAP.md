# Mapa de módulos, SQL y cobertura documental

Revisión de continuidad 2026-11-17. Se comprobó presencia de módulos, documentación, composición HTTP y herramientas; **no es una auditoría sentencia por sentencia ni certifica todos los botones de la versión nueva**. Los importes y permisos de otro respaldo deben revalidarse.

## Cómo encontrar la consulta implementada

1. Vista/control web en docs/endpoint-map.md del frontend; buscar su texto visible y endpoint.
2. Montaje del módulo en src/app.ts y ruta en presentation/http del módulo.
3. Controller/caso de uso → contrato de repository/datasource → composición del módulo.
4. SQL ejecutado en infrastructure/datasources; el repository sólo delega. Leer parámetros, proyección y mapeo, no sólo el texto SQL.
5. Documento en docs/modules/: localizar marcador, tablas y clasificación. Un datasource puede mezclar fragmentos adaptados y derivados; esa consulta no es por sí misma SQL literal capturada.
6. Comparar con la captura cruda local si está disponible. Si no se transfirió, conservar la referencia histórica y hacer una captura nueva cuando sea necesario, sin cambiar su procedencia por falta del archivo privado.

Búsquedas útiles desde la raíz backend:

```powershell
rg --files src/modules -g '*data-source*.ts'
rg -n 'router\.(get|post|patch|delete)|\.route\(' src/modules
rg -n 'capturada|adaptada|derivada|Marcador' docs/modules
rg -n 'SELECT|INSERT|UPDATE|DELETE|JOIN' src/modules -g '*data-source*.ts'
```

No ejecutar todas las solicitudes .http como smoke test: hay ejemplos históricos de escritura. Revisar primero la frontera HTTP, la composición y el destino real.

## Índice por módulo

Los directorios de código corresponden a src/modules/ del backend; el frontend usa src/features/. Las tablas de esta columna son referencias iniciales, no un inventario exhaustivo.

| Función | Código backend | Documento de entrada | Origen inicial / revisión necesaria |
| --- | --- | --- | --- |
| Clientes / Ctas. x Cobrar | accounts-receivable/clients | [clients](modules/accounts-receivable/clients.md), [SQL capturada histórica](modules/accounts-receivable/legacy-mysql-capture.md) | Cobranza PA parcial o total de remisiones web FAW en pesos, con depósito y póliza |
| Verifica fiscal / Ctrl | accounts-receivable/clients | [client-fiscal-verification](modules/accounts-receivable/client-fiscal-verification.md), [requisitos de integración](modules/accounts-receivable/fiscal-integration-requirements.md) | No confundir botón observado/contrato preparado con proveedor fiscal integrado; no inventar algoritmo externo |
| Inventarios P.T. / Productos | inventories/products | [products](modules/inventories/products.md), [botones/captura](modules/inventories/product-buttons-capture.md) | FINV, FINV2, FALM, FAXINV; documentos SQL de barra y botones separados; presencia de métodos de alta legacy no habilita escritura HTTP |
| Pedidos / Cotizaciones | sales/orders | [orders](modules/sales/orders.md), [alta y SQL](modules/sales/orders-create-sql-new-version.md), [alta API](modules/sales/orders-create-api.md) | FPENC/FPLIN y catálogos leídos; escritura actual en overlay PostgreSQL; no sincroniza a MySQL |
| Mantenimiento de Pedidos | sales/orders | [comportamientos](modules/sales/orders-behaviors-new-version.md), [comentarios](modules/sales/order-comments.md) | Autorización/asignación/edición, costos y monedas tienen reglas propias; verificar versiones recientes de los documentos |
| Datos Generales / Usuarios | general-data/users | [usuarios y permisos](modules/general-data/users.md) | Lectura de FUSERS y FHELP, gestión web en PostgreSQL y sesión para MPED5 |
| Facturación | sales/invoicing | [invoices](modules/sales/invoices.md), [captura](modules/sales/invoices-capture.md) | Remisión México FA desde pedido autorizado y asignado, con salida de Inventarios y cargo a CxC |
| Bancos | treasury/banking | [banking](modules/treasury/banking.md) | Alta, Cambio, Baja, traspasos, pagos de recepciones, depósitos de cobranza, Mayor, clasificadores, revisión y conciliación |
| Proveedores / Ctas. x Pagar | accounts-payable/suppliers | [suppliers](modules/accounts-payable/suppliers.md) | Catálogo, eventos, alta, cambio y baja de contactos, saldo de recepciones web y abonos PP parciales o totales |
| Órdenes de compra | purchasing/purchase-orders | [purchase-orders](modules/purchasing/purchase-orders.md) | Comparar controles, encabezado y partidas del nuevo runtime con el contrato existente |
| Recepciones | purchasing/purchase-receptions | [purchase-receptions](modules/purchasing/purchase-receptions.md) | Alta ligada a orden confirmada y Gastos múltiples GA con póliza y pago PP |
| Pólizas | accounting/policies | [policies](modules/accounting/policies.md) | Diferenciar periodo, aplicación y cierre; no reaplicar pólizas para probar un reporte |
| Estado de resultados | accounting/reports | [reporte](modules/accounting/income-statement.md), [México](modules/accounting/income-statement-mexico.md), [sucursales](modules/accounting/income-statement-branches.md) | Revisar año/base histórica y reglas del Excel de referencia; menús propios de Contabilidad |
| Inventario por familia | inventories/reports | [inventory-by-family](modules/inventories/inventory-by-family.md), [conciliación de costos](modules/inventories/inventory-cost-reconciliation-20261103.md) | FINV/FAXINV; reconstrucción por fecha, familia IFAMB, resguardos y AICOSTO/AICANT requieren conservar la regla específica |
| Ventas por familia | sales/reports | [sales-by-family](modules/sales/sales-by-family.md) | No reutilizar indiscriminadamente filtros de inventario/comisiones; respetar facturas y campos de importe documentados |
| Comisiones por cobranza | sales/commissions | [collection-commissions](modules/sales/collection-commissions.md), [ajustes](modules/sales/collection-commission-adjustments.md), [notas C](modules/sales/collection-credit-note-agents.md), [filtros](modules/sales/collection-commission-filters.md) | FAX.AFECHA/PA y ajustes K/D/C; costos históricos FAXINV/FINV; parte deriva de métodos PDF, no de un log SQL nuevo |

Los documentos de tipos XA/P, Duplicar, selección de productos y Cancún creados recientemente pueden estar sólo locales hasta publicarse. Comprobar su presencia y el commit antes de usarlos como capacidad disponible en otro servidor:

- `docs/modules/sales/orders-movement-types.md` (local, pendiente de publicación).
- `docs/modules/sales/orders-product-selection.md` (local, pendiente de publicación).
- `docs/modules/sales/orders-xa-duplicate-p-20261111.md` (local, pendiente de publicación).
- `docs/modules/sales/collection-commissions-cancun.md` (local, pendiente de publicación): participación 0/50/100 aún sin regla confirmada.

## Qué está documentado y qué falta

| Área | Evidencia disponible | Límite de esta revisión |
| --- | --- | --- |
| Arquitectura y rutas | AGENTS, README, src/app.ts, módulos y tests | Revisar composición activa; hay código heredado de escritura que no se usa por HTTP |
| Captura SQL | Handoff, docs por módulo, scripts versionados; runbook nuevo | No todos los botones tienen el mismo nivel de captura; varios ejercicios y automatizaciones antiguas están únicamente en captures/ |
| SQL literal | Documentos con extractos/marcadores y referencias a crudos | Los logs privados no viajan por Git; no se verificó íntegramente cada literal contra sus archivos originales en esta tarea |
| SQL implementado | Datasources y tests | Puede ser adaptado o derivado; no prueba por sí solo una emisión de OMNIS |
| Frontend | endpoint-map y documentos de pantallas/reportes | Contrastar contra la nueva versión y permisos de usuario; no todos los módulos están completos |
| Escritura | NEON-WRITE-DATABASE y postgresWriteBoundary | Pedidos, órdenes de compra, recepciones, pagos, remisiones FA, cobranza y conciliación web escriben en PostgreSQL. El GET inicial de Pedidos puede aplicar migraciones en Neon |
| Estado reciente | Documentos nuevos y working tree | Un clon no recibe modificaciones sin commit/push; no se debe afirmar que esos cambios ya están publicados |
| Fuentes externas | PDFs/Excel/métodos del usuario | Archivos del escritorio no viajan con Git. Un PDF de resultados no define necesariamente todas sus reglas |

## Acciones internas de TUVANSA México pendientes de confirmación

Revisión del 25 de noviembre de 2026. Los ensayos de captura, cancelación,
conciliación y reversión se realizaron con datos temporales en PostgreSQL
de pruebas. Las páginas de cada módulo registran sus efectos y los casos
confirmados en German.

El corte original del plan de cierre registró **15 de 21 flujos operativos (71%)** y
**13 de 21 cerrados con evidencia (62%)**. La corrección de **Remisión México**
verificó el ejercicio fiscal y el flujo de surtido parcial a factura pendiente
de timbrar con un solo cargo en Chromium y PostgreSQL 17.12 local. [Facturación](modules/sales/invoices.md#remisión-méxico-desde-pedido)

Las pruebas HTTP de **Agrupar**, **FP** y **Eliminar** (RA histórico y RW
web) usaron PostgreSQL 17 local con dos sesiones concurrentes observadas
en `pg_locks`. Cada carrera produjo una operación exitosa y un conflicto
`409`. También se verificaron las repeticiones idempotentes y la reversión
de escrituras al forzar errores.

El alcance vigente para TUVANSA México excluye los flujos de color y
talla, incluidos los controles y consultas CT asociados, así como cajas
y empaque. En el buscador de Pedidos también se excluyen **Foto** y
**Matriz de fotos**. Estas exclusiones aplican a implementación y verificación.

| Módulo | Controles pendientes | Evidencia o dato que falta |
| --- | --- | --- |
| Bancos | Conciliar → Imprimir Cheque | **FP** guarda `POPOSTFECHA` de una póliza histórica y la muestra en Conciliar, Auxiliar y Pólizas. **Detalle** consulta el auxiliar de la partida por `FAX.BASEQ`. Los respaldos de 2018 y 2019 contienen la misma partida mexicana con `BREPORTE`, importe cero y sin número de cheque. Falta una partida de cheque con formato aplicable a México. [Bancos](modules/treasury/banking.md#acciones-al-pie-de-conciliar) |
| Pólizas | Duplicar pasivo | **Guardar** admite `POPAR1` del grupo 4 de `FAG` validado por German. Los respaldos examinados no contienen una póliza activa `PASIVO*` de México o Monterrey. Falta una copia con familia y proveedor para comprobar el redondeo y el cargo. [Pólizas](modules/accounting/policies.md) |
| Clientes | Datos fiscales → Act. | Las sesiones de México revisadas, incluida la consulta de un cliente activo, no mostraron **Verifica fiscal**. Se requiere acceso a **Act.** para comprobar su efecto sobre el catálogo local. [Verifica fiscal](modules/accounts-receivable/client-fiscal-verification.md) |
| Compras | Editar recepción | **Eliminar** comparte la reversión de **Cancelar recepción**. La prueba con `RA09214` verificó la orden, el inventario, el saldo y la póliza. German no ofrece la edición general de Recepciones en `MCONTROL/7`. [Recepciones](modules/purchasing/purchase-receptions.md) |
| Inventarios | Distribución de Imprimir EI, SI y TR en German | Se cotejaron los renglones, almacenes, signos y totales de tres fichas. German devolvió `E101201` al cargar `QTUVANSA007` para EI y TR. La comparación de la salida impresa de `QTUVANSA002` para SI sigue pendiente. [Documentos de inventario](modules/inventories/movement-documents.md) |
| Pedidos | Otras expresiones de Familias | **Familias** admite la igualdad por código comprobada con `MEMFILQUERY`. Faltan casos de uso para otras expresiones. [Pedidos](modules/sales/orders-behaviors-new-version.md) |
| Facturación | Traspaso y Liquidación camión | Los respaldos consultados carecen de tipo `TITRASPASOS` habilitado y destino `TZ` para el flujo. Liquidación requiere un archivo tabulado de ruta y folios de entrega y devolución relacionados. [Facturación](modules/sales/invoices.md) |

## Precedencia práctica

AGENTS y solicitud actual → documento específico vigente del módulo → composición/código/tests actuales → capturas verificadas de su versión. Los historiales explican decisiones, pero pueden contener párrafos superados. Registrar discrepancias, no borrar evidencias anteriores ni ocultarlas cambiando etiquetas de procedencia.

Para una función nueva completar [REA-WORK-RECORD](REA-WORK-RECORD.md). No declarar “todo documentado” hasta comprobar cada botón/consulta que realmente vaya a utilizarse en el nuevo servidor.
