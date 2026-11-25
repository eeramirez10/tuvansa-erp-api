# Cuentas por pagar — Catálogo de proveedores

Catálogo, consultas y mantenimiento de la ficha **Cuentas x Pagar / Catálogo de proveedores** de Omnis 7.

## Pantalla principal y barra

| Elemento OMNIS | Endpoint |
| --- | --- |
| Abrir catálogo / primer registro | `GET /api/accounts-payable/suppliers/first` |
| Flecha izquierda | `GET /api/accounts-payable/suppliers/:supplierId/previous` |
| Buscador | `GET /api/accounts-payable/suppliers?q=...&status=all` |
| Flecha derecha | `GET /api/accounts-payable/suppliers/:supplierId/next` |
| Ficha del proveedor | `GET /api/accounts-payable/suppliers/:supplierId` |

La consulta inicial observada en OMNIS carga los identificadores con `SELECT PRVSEQ FROM FPRV ORDER BY PRVCOD, PRVSEQ` y después lee la ficha completa de `FPRV`. La API conserva ese orden y usa `PRVSEQ` como identificador estable.

## Alta, Cambio y Baja

| Control | Endpoint | Procedencia y tablas |
| --- | --- | --- |
| Alta | `GET /create`, `POST /` | Derivada de `MPRV/21` y `/27`. Defaults de `FCIA`; unicidad en `FPRV` y `supplier_catalog` |
| Cambio | `GET /:id/edit`, `PATCH /:id` | Derivada de `MPRV/23` y `/27`. `FPRV`, `FCIA`, `FBENC`, `supplier_catalog` |
| Baja | `DELETE /:id` | Derivada de `MPRV/22`. Dependencias en `FDOC`, `FAX`, `FAXINV`, `FPENC`, `FPLIN`, `FCANU2` y las tablas web de RW, GA, PP y órdenes |

La ficha se edita en la misma vista. El alta propone moneda y lista 1,
tolerancia de compra 10 y la cuenta `FCIA.CIACTAPRV`. Con Contabilidad activa,
se verifica que la cuenta informada sea una cuenta sin subcuentas. La
configuración de la compañía determina si puede quedar en blanco. El cambio
normaliza una lista fuera de 1–5 a 1 y exige la revisión vigente de la ficha.
Estas reglas provienen de los procedimientos de la biblioteca German pruebas
exportados el 23 de noviembre de 2026.

PostgreSQL guarda las altas, modificaciones y bajas de la web. Se usa un
identificador estable. Los importes de un proveedor heredado conservan su
origen en FPRV y se integran con las recepciones y pagos locales. La baja
requiere confirmación y excluye al proveedor de la ficha, el buscador y las
flechas. Si ya existen documentos o referencias, la API bloquea la baja y el
cambio de código. El código de un proveedor dado de baja queda reservado.

## Acciones

| Botón OMNIS | Endpoint GET | Fuente real |
| --- | --- | --- |
| Bloquear | `/:id/actions/block-status` | `FPRV.PRVBAJA` (estado solamente; no modifica) |
| Clasificar | `/:id/actions/classifications?position=1..9` | `FPRV.PRVPAR1..9`, opciones de `FAG` y selección web |
| % Descuentos | `/:id/actions/discounts` | `FPRV.PRVDESC1`, `FPRV.PRVDESC2` |
| Eventos | `/:id/actions/events` | `FEVENTOS` por `PRVSEQ` |
| Varios | `/:id/actions/various` | campos bancarios, fiscales y varios ya almacenados en `FPRV` |
| Contactos | `/:id/actions/contacts` | `FCONTACTOS` por `CONTKEY = PRVCOD` |

`Foto` se omitió por decisión del proyecto.

| Vista | Botón | Evidencia German | Procedencia | Endpoint | Tablas |
| --- | --- | --- | --- | --- | --- |
| Catálogo de proveedores | Clasificar | `EPRV#1/39`, `EPRV#9C/239–240`, `20261125-suppliers-class` | Lectura MySQL adaptada | `GET /:id/actions/classifications?position=1..9` | `FPRV`, `FAG` |
| Selección de parámetros | Guardar todos | `20261125-EPRV9C-PROCEDURES`, acceso `EPRV#9C/33` y llamada `MBASE/69` | Escritura PostgreSQL derivada | `PATCH /:id/actions/classifications` | `tuvansa.supplier_catalog` |

El doble clic pasa la opción del grupo a **Seleccionados**. Guardar todos envía
los nueve `AGTNUM`, la revisión de la ficha y un UUID. Se valida `AGTIPO IN (0,2)`,
el grupo `AGT` y la longitud del campo para cada código cambiado. Los valores
históricos ausentes del catálogo se conservan cuando siguen seleccionados.
PostgreSQL guarda los nueve valores en la misma transacción del catálogo.
Las órdenes nuevas consultan los clasificadores efectivos al elegir proveedor
y aplican la herencia de `EOC#1`.

Chromium confirmó dos selecciones de grupos distintos en un solo guardado.
La API devolvió las dos asignaciones y la baja del proveedor temporal ocultó
su ficha y sus clasificadores. La prueba HTTP cubrió revisión vencida,
reintento, dos solicitudes simultáneas y fallo antes de confirmar.
Evidencia `ev_fbe6ed97c47764511b9a9fb106ecc193cc99413978c19a6b9b4a400be907a72a`.

### Eventos y contactos

| Vista | Botón | Evidencia German | Endpoint bajo `/:id/actions` | Tablas |
| --- | --- | --- | --- | --- |
| Eventos | Nuevo, Cambiar, Eliminar | `20261125-EPRV20-PROCEDURES`, `EPRV#1/45 → EPRV#20/9–11,240` | `POST /events`, `PATCH /events/:activityId`, `DELETE /events/:activityId` | `FEVENTOS`, `FPRV.PRVEVENTOS`, `tuvansa.supplier_catalog` |
| Contactos | Alta, Baja | `20261125-EPRV44-PROCEDURES`, permisos `PRV#44/11` y `PRV#44/12` | `POST /contacts`, `DELETE /contacts/:activityId` | `FCONTACTOS`, `tuvansa.supplier_catalog` |
| Contactos | Cambio | `EPRV#44/13` llama a `MBASE/69('FSUCURSALES', …)` | Pendiente de confirmar un cambio sobre el contacto | `FSUCURSALES` en el procedimiento |

Las lecturas se adaptan a los procedimientos. Eventos usa `PRVSEQ` y el
generador vacío de la sesión sin identificación. Contactos usa el código de
origen del proveedor y `CONTES=1`. Se guardan las ediciones web con una
bitácora derivada en PostgreSQL, manteniendo `EVSEQ` y `CONTSEQ` para las
filas de origen. Las altas reciben UUID. Cada cambio o baja valida revisión
y pertenencia y el reintento con el mismo UUID recupera el resultado.
El último evento retirado quita el asterisco de la ficha en la vista web.

En Chromium se creó, cambió y eliminó un evento y se dio de alta y baja un
contacto temporal. Evidencia `ev_4c23d33f9ff03e0ef31ae603d3b7c41a6c9a63fb1e4bc104ed83d9f4f2c7d3cb`
y `ev_084fa42d56c028c1c9e95aefac00a72fd6a6df7082d2357e9263ae33e4d13d0f`.
La prueba HTTP forzó un fallo antes de confirmar y verificó el contenido y
el indicador después del rollback. Dos solicitudes sobre la misma revisión
produjeron un guardado y un conflicto.

### Varios

| Vista | Botón | Evidencia German | Procedencia | Endpoint | Tablas |
| --- | --- | --- | --- | --- | --- |
| Enviar a | Varios / Cambio / OK | `20261125-eprv-varios-change-ready`, `EPRV2#1/31`, acceso `EPRV2#1/27` | Lectura adaptada y guardado derivado | `GET` y `PATCH /:id/actions/various` | `FPRV`, `FCIA`, `tuvansa.supplier_catalog` |

German entra en captura y al confirmar actualiza los campos y
`PRVFECHACAMBIO`. El editor web guarda datos bancarios, plazos y tolerancia,
IVA y retenciones, valores diarios, los doce campos varios y los códigos de
Informativa SAT. Proyecta tolerancia, IVA, retenciones e Intercia en los
parámetros efectivos que ya consumen Compras y Pagos. La correspondencia entre
las opciones de ID Banamex y los valores `PRVBMXID` 3 y 4 quedó pendiente de
verificar.

El PATCH valida revisión y UUID en la transacción del proveedor. La prueba
HTTP cubre reintento, revisión vencida, dos solicitudes y rollback, además de
un cambio posterior en la ficha. En Chromium se guardaron siete días de
entrega en un proveedor temporal y la ficha volvió a consulta.
Evidencia `ev_2ec5e78cb47890169581647b9120242185ac3ffd32710869d82410d901074581`.

## Consultas

| Botón OMNIS | Endpoint GET | Tablas principales / filtros capturados |
| --- | --- | --- |
| Saldo | `/:id/balance` | `FDOC`, `DEST=0`, `DMULTICIA=1`, `DESCXC=2` |
| Movimientos | `/:id/movements` | `FAX + FDOC`, `AMES=1`, `DEST=0`, `DMULTICIA=1` |
| Facturas | `/:id/invoices` | `FDOC`, `DESFACT IN (2,3)`, `DEST=0` |
| Productos ordenados CT | `/:id/products/ordered` | `FPLIN + FINV + FPENC`, `PESPEDIDO<>5` |
| Fill · Rate | `/:id/fill-rate` | `FPENC` por proveedor |
| Productos cotizados | `/:id/products/quoted` | `FPLIN + FINV + FPENC`, `PESPEDIDO=5` |
| Productos comprados CT | `/:id/products/purchased` | `FAXINV + FINV + FDOC`, agrupado por producto |
| Productos comprados desg. | `/:id/products/purchased-detail` | `FAXINV + FINV + FDOC` |
| Historial de precios | `/:id/products/price-history` | `FAXINV + FINV + FDOC`, `AICANTF>1` |
| Gastos comprados | `/:id/expenses/purchased` | `FBANMOV + FBENC` |
| Compras anuales | `/:id/purchases/annual` | `FAXINV + FDOC + FINV`, agrupado por producto/año/mes |
| Compras anuales resumen | `/:id/purchases/annual-summary` | `FDOC`, compras netas agrupadas por año/mes |
| W.I.P. CT | `/:id/work-in-progress` | OMNIS abrió la tabla sin emitir SQL para el caso capturado; la API lo documenta y devuelve lista vacía |

Todas las rutas anteriores se montan bajo `/api/accounts-payable/suppliers`.

El saldo local de una recepción se obtiene restando de su cargo original los pagos vigentes de `supplier_payments`. **Saldo** conserva ambos importes y muestra los documentos web con pendiente positivo. **Movimientos** conserva el cargo de origen y muestra cada abono **PP** con su folio de cheque o transferencia y su póliza. La correspondencia del abono proviene de `EPRV#25/120`.

El selector de cuenta y el registro PP usan el catálogo efectivo de Bancos.
Incluyen cuentas de German y cuentas web habilitadas para pagos en pesos.
En MySQL 5.1, la ficha convierte a `DATE` las fechas de alta, baja, última
compra y último pago después de sustituir los centinelas por nulos.

**Movimientos → Revertir PP** consulta y registra en `GET/POST /api/accounts-payable/suppliers/:supplierId/payments/:paymentId/reversal`. Requiere motivo, confirmación y fecha dentro del periodo abierto. La contrapartida **RP** reabre el documento por el importe exacto del PP elegido. Los demás pagos conservan su efecto. Movimientos conserva el abono PP y muestra el cargo RP vinculado a su póliza de reversión.

La consulta de un PP conciliado devuelve `originalReconciliation` con ID y fecha del corte. El POST requiere el mismo `expectedReconciliationId` y una fecha igual o posterior al último corte de la cuenta. Un cambio de conciliación obliga a consultar y confirmar de nuevo. La corrección de un PP conciliado genera un cargo bancario independiente que se puede incluir en un corte posterior.

## Correspondencia visual

- La ficha conserva los bloques **Catálogo de proveedores**, **Condiciones** y **Acumulados**.
- Acciones queda a la izquierda y Consultas a la derecha, como en OMNIS.
- Los modales usan tablas compactas, scroll XY, totales y la misma fila de botones inferiores. Esos botones internos permanecen deshabilitados hasta abordar sus operaciones específicas.
- La base usada por OMNIS durante la captura era de pruebas; la API se ejecuta contra la conexión configurada en `.env`.
La prueba de un PP conciliado sobre una recepción parcial verificó el
saldo del proveedor, el vínculo a la póliza y el corte independiente
del cargo RP. Los importes y el regreso de la orden al pendiente están
en [Recepciones](../purchasing/purchase-receptions.md#recepción-parcial-pago-y-reversión).
