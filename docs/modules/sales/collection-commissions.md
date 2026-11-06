# Reporte Comisiones x Cobranza

Actualizado el 2026-11-06. Pertenece a **Ventas**, por indicación expresa del usuario:
**Reportes de Ventas → Comisiones → Reporte Comisiones x Cobranza**.
Disponible desde Pedidos, Facturación y su ruta `/ventas/reportes/comisiones-por-cobranza`.
El enlace anterior de Contabilidad redirige conservando query/hash; Contabilidad
ya no incluye esta opción y conserva los otros tres reportes financieros.

## Evidencia y procedencia

UNO.pdf (1 página), DOS.pdf (2), TRES.pdf (1) y CUATRO.pdf (1) son exportaciones
de métodos de PROSCAI.MREPESP01 proporcionadas por el usuario. Se leyeron completos
y se inspeccionaron visualmente. No son logs MySQL: el SQL es **derivado de código
proporcionado**, no capturado de OMNIS. No se activó general_log.

UNO elige 211 desglosado / 212 totalizado. DOS contiene 211, TRES contiene 213
y CUATRO contiene **214_Calcula_Costo_de__Facturas**. Este último completa costo,
costo real, utilidad, margen y LM. El resumen por agente es una suma derivada
de documentos; no se afirma reproducir el método 212 no proporcionado.
No hay una tasa de comisión a pagar al agente en estos métodos: el reporte
reproduce sus 18 columnas y no inventa una liquidación adicional.

| Vista | Botón visible | Referencia / marcador | Procedencia | Endpoint | Tablas |
| --- | --- | --- | --- | --- | --- |
| Reportes de Ventas / Comisiones | Reporte Comisiones x Cobranza | Métodos 211/213/214; sin marcador MySQL | Derivada | GET /api/sales/reports/collection-commissions/options | FALMCAT, FAG, FCIA |
| Reporte Comisiones x Cobranza | Vista previa | Código de los cuatro PDF; sin captura nueva | Derivada | GET /api/sales/reports/collection-commissions | FAX, FDOC, FCLI, FAG, FAXINV, FINV |
| Reporte Comisiones x Cobranza | Resumen por agente / Descargar Excel | Presentación de respuesta vigente | Derivada/presentación | Sin HTTP adicional | Sin SQL adicional |

## Selección de documentos y pagos (211/213)

- Intervalo inclusivo por **FAX.AFECHA**, nunca por FDOC.DFECHA: `>=from` y
  `<día siguiente de to`. Incluye pagos parciales y facturas de otros meses.
- Requiere al menos un **ATIPMV=PA** dentro del rango. Movimientos D* del mismo
  intervalo aportan devoluciones; devoluciones sin PA no generan documento.
  Este HAVING precisa el alcance solicitado frente a 213.
- DCANCELADA=0, excluye AF y limita a DESFACT=1 con folio F. No añade filtros
  DSTATUSCFD=3, DEST=0, AMES=1 o POS de otros reportes. Por solicitud posterior
  se excluye completa cualquier factura con al menos una partida de servicio
  **FINV.ITIPO=4**, incluidas las mixtas. No se limita a productos ITIPO=1.
  Se usa la clasificación actual de FINV, sin inferir servicios por folio,
  descripción, costo cero o movimiento. Un tipo desconocido no se inventa como servicio.
- Pago original `P=SUM(PA.ACANT/(1+DPORCIVA/100))`; devoluciones D* se suman
  por separado sin IVA. Conserva signos, precisión decimal y movimientos originales.
  IVA inválido produce null, nunca un importe falso cero.
- Subtotal `S=DBRUTO`; pago firmado de cálculo `Q=-S` si `ABS(P)>S`, de otro modo `Q=P`.
  El pago original se conserva en `payments`. Total=S+devoluciones firmadas;
  flete=DCOSTOFLETE y cliente nuevo=marca actual CLITARJETA=Nuevo.
- **Presentación:** `displayPaymentAmount=ABS(Q)`. Pantalla, Excel, subtotales
  de agente y total general usan la suma de esos valores positivos por factura;
  no ABS de la suma neta. `paymentAmount`, `payments`, `totals.payment` y
  `agents[].payment` conservan signos para cálculo/auditoría. Los resúmenes
  agregan `displayPayment`. Un importe desconocido sigue siendo null.
  La hoja Movimientos FAX conserva importes originales firmados. Costo prorrateado,
  utilidad y margen siguen usando P/Q firmados, sin alterarse por el cambio visual.
- Una fila por DSEQ evita colisiones de folios. FECHA PAGO y DÍAS usan el último PA
  del intervalo; conserva primera fecha, cantidad de pagos y cada fecha/importe.
  Corrige la AFECHA arbitraria del GROUP BY DNUM del procedimiento.
- Agente DPAR1 relacionado con FAG.AGTNUM, restringido a AGT=1 y agrupado antes
  del join para evitar duplicar pagos. Cliente FDOC.CLISEQ: coincide con FAX.CLISEQ
  en los PA elegibles inspeccionados de agosto.
- México usa exactamente almacenes 01/15 del método 213. Otros usan
  FALMCAT.CATMULTICIA; todas incluye almacenes no asignados (`unassigned`).
- No convierte moneda ni invierte descuentos. Conserva DMONEDA; no afirma
  una moneda base consolidada sin verificarla. No une FPENC: PEPLAZO no interviene
  en las operaciones activas de 211/214.

## Costo y utilidad (214 de CUATRO.pdf)

Para cada factura se seleccionan sus partidas FAXINV relacionadas por DSEQ con
FDOC y por ISEQ con FINV. El movimiento de costo depende de FDOC.DMULTICIA:
1=FA, 2=FB, 3=FC, 4=FD, 5=FZ, 6=FV, 7=FX. El PDF especifica 1/5/7; las otras
compañías se verificaron en partidas de facturas cobradas del origen. No filtra AIMES.

```sql
-- DERIVADA del código proporcionado, parámetros internos validados.
SELECT a.DSEQ,
       SUM(a.AICOSTO*a.AICANTF) AS costo,
       SUM(IF(i.ILUGAR='XXX',1,0)) AS lm,
       SUM(IF(i.ILUGAR='XXX',a.AICANTF*a.AIPRECIO*0.01,0)) AS lm_valor
FROM FAXINV a
LEFT JOIN FINV i ON i.ISEQ=a.ISEQ
WHERE a.DSEQ=? AND a.AITIPMV=?
GROUP BY a.DSEQ;
```

La API lee las partidas por lotes y realiza el mismo cálculo decimal en dominio:

- **Costo C** = SUM(AICOSTO*AICANTF), redondeado a centavos como #31D2/#20D2.
- Costo prorrateado firmado **R = C*P/S**; usa **P original**, no Q limitado.
- **Costo real = ABS(R)**; **utilidad = ABS(Q-R)**; **%=((Q-R)/Q)*100**.
- **LM** cuenta partidas con ILUGAR=XXX, no unidades; **LM_VALOR** es 1% de
  SUM(AICANTF*AIPRECIO) sólo de esas partidas. Los ceros reales se conservan.
- El 3% está en código comentado; el código activo no lo aplica.
- Cantidades y costos/precios se multiplican con enteros de precisión fija;
  redondeo a dos decimales, mitad alejándose de cero, antes del prorrateo y al final.
- Sin partida del movimiento requerido, compañía desconocida, IVA inválido o
  subtotal cero, los cálculos indefinidos son null y `costStatus=unavailable`.
  Un costo válido de cero sí se calcula. No arrastra valores de otra factura.
  Pago cero deja margen null por divisor cero, sin NaN/Infinity.

`status=complete|incomplete` y `calculationReady` reflejan disponibilidad de costos.
Los subtotales de agente y generales no presentan sumas parciales como completas:
si falta un valor, su total es null. `unavailableCosts` cuenta documentos afectados.
`commissionAmount` permanece null: no existe tasa de pago adicional en los PDF.

## Contrato, arquitectura y límites

Feature separada `src/modules/sales/commissions`: dominio, casos de uso, contratos,
infraestructura y HTTP. Sólo infrastructure/datasources contiene SQL; repository
delega. Parámetros enlazados. Pagos y partidas se leen separados para evitar
multiplicar importes, en una transacción **READ ONLY con snapshot**.

GET options devuelve compañía, siete sucursales, almacenes, agentes y fechas desde
el primer día del mes actual hasta hoy en México. GET reporte acepta fechas ISO
1901..2100, máximo 366 días, branch=01..07|all y agent=código|all; defaults 01/all.
Valida catálogos, rechaza filtros extra/duplicados. Cache-Control no-store.
Límites: 10,000 facturas y 100,000 filas por detalle; exceder devuelve 413, sin
truncar silenciosamente. Consultas con límite de ejecución de 30 segundos.
Requests reproducibles en `http/sales/collection-commissions.http`.

## Presentación y Excel

Ventana ERP compartida shadcn/Base UI: fechas de pago, sucursal, agente, Vista
previa, Resumen por agente, paginación 100 documentos, scroll X/Y, Cancelar/Escape.
Detalle agrupado por agente con sus documentos y subtotal; continúa la cabecera
al cambiar de página y muestra el subtotal completo al terminar el grupo.
Cambio de filtros bloquea exportación anterior hasta regenerar. Maneja carga,
error/reintento, vacío y rango inválido.

ExcelJS diferido: **Comisiones, Resumen agentes, Movimientos FAX, Partidas origen,
Criterios**. Comisiones conserva las 18 columnas de 211: AGENTE, CLIENTE, FECHA
DOCTO, FECHA PAGO, FACTURA, DÍAS, SUBTOTAL, DEVOLUCIONES, TOTAL, PAGO, COSTO,
COSTO REAL, UTILIDAD, %, FLETES, CLIENTE NUEVO, LM, LM_VALOR. Agrupa documentos por
agente, con subtotales y total general mediante fórmulas y resultados guardados.
El total suma sólo subtotales, sin contar documentos dos veces. Fechas e importes
numéricos; null queda vacío. Partidas incluye AITIPMV, ILUGAR, compañía y si participa
en el costo. Exporta todas las filas, independientemente de la página visible.

## Validación previa al filtro de servicios (2026-11-06)

Agosto 2026: México 78 facturas / 86 PA, pago presentado sin IVA -8,339,491.31;
todas 995 / 1,068 PA, pago -57,903,236.15. La cobranza coincide con la versión
preliminar. Incluye 58/517 facturas anteriores al mes, 41/251 parciales y 6/54
con múltiples pagos para México/todas respectivamente.

Una factura FE0064185 de México sólo tiene partida de movimiento FE, no FA.
Su costo se deja no disponible: no se usa un cero ni otro movimiento por suposición.
Por ello los totales de costo de México/todas están incompletos. Los 994 documentos
calculables de todas concilian con SUM SQL independiente y Decimal: costo conocido
58,369,451.29; costo real conocido 42,585,972.88; utilidad conocida 15,513,537.32.
Son **sumas parciales de auditoría**, no totales completos del reporte.
Agente 1501: 38 documentos, costos completos; costo 4,741,350.77, costo real
1,701,088.35, utilidad 394,888.80, pago -2,053,743.45.

Pruebas de dominio/HTTP/datasource cubren 211/214, pago original vs limitado,
redondeo, compañías, LM por partida, costo cero/ausente, IVA inválido, filtros,
snapshot y errores. Navegador con API real verifica menú/rutas, agrupación,
filtros, descarga, paginación, scroll, error/reintento, vacío, rango inválido y Escape.
Tres Excel contrastados contra API, subtotales y fórmulas sin doble conteo.

Evidencia privada bajo `captures/commission-reference-20261106/`,
`captures/sql/new-version/sales/collection-commissions-costs-20261106/` y
`captures/ui/new-version/collection-commissions-costs-20261106/`.
La evidencia preliminar anterior se conserva por separado. general_log OFF;
MySQL80 Running. Sólo lecturas, sin reinicios ni cambios de configuración.

Verificaciones de la versión anterior: `pnpm lint`, `pnpm build` y `pnpm test` del backend
aprobados (**206 pruebas**, 20 de este reporte); frontend `pnpm lint`,
`pnpm typecheck` y `pnpm build` aprobados. Validación XML independiente de
110/380/20 fórmulas de los tres libros, incluyendo ceros y subtotales.

## Exclusión de servicios y presentación positiva (2026-11-06)

Cambio derivado solicitado por el usuario, no capturado ni atribuido a los PDF.
El datasource aplica antes de agregar pagos y limitar filas:

```sql
AND NOT EXISTS (
  SELECT 1 FROM FAXINV serviceLine
  JOIN FINV serviceProduct ON serviceProduct.ISEQ=serviceLine.ISEQ
  WHERE serviceLine.DSEQ=d.DSEQ AND serviceProduct.ITIPO=?
)
-- Parámetro fijo 4: servicio. No depende del cliente HTTP.
```

El dominio también descarta el documento completo si recibe alguna partida
`typeId=4`, para conservar la regla al reemplazar el datasource. Elimina igualmente
sus pagos, productos y aportaciones a agentes/totales; ningún servicio queda en
hojas de auditoría. Partidas origen agrega ITIPO. No filtra sólo la partida de
servicio ni utiliza un join que multiplique la cobranza.

Lectura independiente de la muestra anterior: 12 facturas con servicios,
4 sólo de servicios y 8 mixtas. Resultado de agosto después de excluirlas:

| Alcance | Facturas | PA | Pago positivo presentado | Costo | Costo real | Utilidad |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| México 01/15 | 74 | 82 | 5,321,234.60 | 2,809,123.18 | 2,253,422.11 | 3,067,812.49 |
| Todas | 983 | 1,055 | 54,272,789.20 | 55,681,931.50 | 39,898,453.14 | 14,495,780.20 |
| Agente 1501, todas | 38 | 43 | 2,074,562.43 | 4,741,350.77 | 1,701,088.35 | 394,888.80 |

FE0064185 también se excluye por su clasificación de servicio; ya no provoca
costo incompleto en esta muestra. Se contrastó cada documento conservado con
la versión anterior: costos/utilidad/margen y pagos firmados no cambian. Pago
neto firmado de todas=-54,189,338.60: difiere del total positivo porque este suma
valores absolutos por factura, incluidas facturas con PA neto de signo contrario.

Backend lint/build/test aprobados (**208 pruebas**, 22 del reporte): servicios,
mixtas, exclusión de movimientos/totales, tipos desconocidos, presentación positiva
con signos opuestos, null y preservación de costo/utilidad. Frontend lint/typecheck/build
y navegador con API real aprobados; tres Excel contrastados con la respuesta.
Evidencia privada `captures/sql/new-version/sales/collection-commissions-services-20261106/`
y `captures/ui/new-version/collection-commissions-services-20261106/`.
general_log permanece OFF; no se modificó MySQL.
