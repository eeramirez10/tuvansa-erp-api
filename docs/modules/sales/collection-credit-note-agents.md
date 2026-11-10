# Notas de crédito por vendedor

Actualización 2026-11-10 del Reporte Comisiones x Cobranza de Ventas.
Complementa [los ajustes por fecha del auxiliar](collection-commission-adjustments.md).
SQL **derivado**: regla solicitada por el usuario, contrastada mediante lecturas
de la base. No es SQL capturado de OMNIS. No modifica clientes, agentes ni documentos.

| Vista | Etiqueta visible | Referencia / marcador | Endpoint | Tablas |
| --- | --- | --- | --- | --- |
| Reporte Comisiones x Cobranza | Vista previa / Agente | Solicitud 2026-11-10, sin captura nueva | GET /api/sales/reports/collection-commissions | FAX, FDOC, FCLI, FAG, FAXINV, FINV |
| Detalle y resumen | Notas de crédito / Reasignada por cliente | Misma respuesta | Mismo GET y POST /preview | Mismas tablas, snapshot READ ONLY |
| Excel, hoja individual | Notas de crédito | Sin SQL adicional | Exportación local | Sin tablas adicionales |

## Asignación

Una nota C, aun sin PA del periodo, aparece una sola vez en el vendedor resuelto
para su cliente. También se asigna allí su reversión K positiva. No se reparten
ni repiten importes entre varios vendedores del mismo cliente.

1. Se busca la última factura F del **mismo CLISEQ y DMULTICIA**, con DESFACT=1,
   DCANCELADA=0 y DBRUTO>0, fechada hasta el día final inclusivo del reporte.
   Su DPAR1 debe existir en FAG con AGT=1 y código no vacío. Se ordena por DFECHA
   descendente y DSEQ descendente como desempate. No exige un PA ni una factura
   dentro del mes seleccionado.
2. Si no existe esa factura, se usa FCLI.CLIPAR1, validado contra FAG AGT=1.
3. Si tampoco existe, se conserva el agente del documento de origen y se
   marca la asignación para revisión. La nota no se elimina por esta carencia.

La prioridad de facturación es una **regla de atribución del reporte**, no una
afirmación sobre bajas laborales. En la muestra, CLIPAR1 todavía coincide con
agentes antiguos mientras las últimas facturas ya usan otros. No se infiere
vigencia del vendedor por su nombre ni por la ausencia de cobros en un mes.
El catálogo de cliente representa su estado actual, no un historial de cartera.
Si varios agentes facturan al cliente, se elige sólo el último según el orden
anterior. Se conserva el origen para que esa atribución pueda revisarse.

La identidad usa CLISEQ; no compara nombres parecidos ni códigos de clientes
distintos. La compañía evita trasladar notas entre sucursales de compañías
diferentes. El filtro de almacenes sigue tomando el documento del auxiliar;
**el filtro Agente se aplica después de resolver la asignación**. El reporte
individual coincide con las filas del mismo agente en el reporte de todos.
PA, devoluciones D y cancelaciones F mantienen su agente documental anterior.

## Columnas y contrato

- `creditNoteAmount`: notas C negativas y sus reversiones positivas; cero para
  otros tipos. Un importe desconocido sigue siendo null.
- `returnAmount`: sólo devoluciones D y sus reversiones, con sus signos.
- `agents[].creditNotes` / `totals.creditNotes`: suma exacta en centavos, o null
  si falta algún importe de la columna. `returns` ya no incorpora notas C.
- `subtotalAmount + returnAmount + creditNoteAmount = totalAmount` cuando los
  importes son conocidos. Las reversiones compensan la columna original.
- `originalAgentCode`, `originalAgentName`, `agentAssignment`
  (`latest-invoice`, `customer-catalog`, `document`) y `agentReassigned` permiten
  auditar la asignación. El agente efectivo sigue en agentCode/agentName.

Pantalla, resumen y Excel separan **Devoluciones** y **Notas de crédito**.
La hoja individual pasa de quince a **dieciséis columnas**; Ventas por agente
tiene diecisiete. Se conserva el resumen de tres renglones por vendedor y el
bloque azul de catorce filas. Fórmulas, subtotales, porcentaje, bono del 1% y
área de impresión se desplazan con la columna. El folio incluye una nota con
el agente original, el asignado y la razón. La pantalla identifica las reasignadas.

No cambia la fecha FAX.AFECHA, importe, IVA, costo histórico, prorrateo, servicio
excluido, deduplicación ni utilidad de cada evento. La comisión se calcula en
el grupo del agente efectivo con su plan seleccionado, sin inventar tasas.

## Verificación

México octubre: CA0003358/CA0003359 pasan 1277→1223; CA0003360 pasa 1202→1231;
CA0003361, su reversión y CA0003362 pasan 1254→1231. La pareja cancelada compensa
su importe en el mismo agente. Total neto de notas sin IVA: −138,983.80.
Septiembre: −7,865.47. Ambos periodos conservan 80/129 eventos respectivamente
y los importes, fechas, costos, utilidades y bonos de cada evento previo.

Se comprobaron filtros individuales contra todos, columna separada, agrupación,
revisión, liquidación y cinco descargas. Cinco Excel conciliados por documento,
agente y total, incluyendo fórmulas evaluadas independientemente (no Excel nativo).
Backend: lint/build/test, **253 pruebas**; frontend: lint/typecheck/build.
Evidencia privada en captures bajo `credit-agent-20261110`, excluida de Git.
general_log permaneció OFF; sólo se ejecutaron lecturas.
