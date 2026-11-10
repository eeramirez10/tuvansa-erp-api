# Comisiones: cancelaciones, devoluciones y notas de crédito

Vigente desde el 2026-11-10. Amplía el reporte de Ventas y sustituye el alcance
anterior que sólo etiquetaba el estado actual de cancelación en los cobros PA.

## Procedencia y trazabilidad

SQL **derivado**, diseñado para el reporte solicitado y contrastado en lectura
contra FDOC/FAX/FAXINV/FINV y el catálogo FTIPMV. No es una captura de OMNIS.
No se activó general_log ni se modificaron datos o configuración del servidor.

| Vista | Texto visible | Referencia | Endpoint | Tablas |
| --- | --- | --- | --- | --- |
| Reporte Comisiones x Cobranza / Vista previa | Movimientos desde / hasta | Solicitud 2026-11-10; sin marcador de captura | GET /api/sales/reports/collection-commissions | FAX, FDOC, FCLI, FAG, FAXINV, FINV |
| Documento del reporte | CANCELADA, DEVOLUCIÓN, NOTA DE CRÉDITO, REVISAR | AFECHA y ASEQ del auxiliar | Mismo GET y POST /preview | FAX, FDOC |
| Liquidación y ajustes | Recalcular liquidación | Respuesta con cobros y ajustes firmados | POST /api/sales/reports/collection-commissions/preview | Mismo snapshot READ ONLY |
| Excel | Pago / ajuste, Devoluciones / NC | Misma respuesta vigente | Sin HTTP adicional | Sin SQL adicional |

## Selección y fecha contable

Todos los renglones usan el intervalo inclusivo de **FAX.AFECHA**. No se usa
DCANCELADA para inventar una fecha ni se imputa el pago histórico a otro mes.

- **Cobro:** agrega los PA del periodo por DSEQ, como antes. No agrega D/C a
  la factura: ahora son renglones separados, evitando contabilizarlos dos veces.
- **Cancelación:** K negativo de documento F con al menos un PA negativo
  registrado hasta la fecha del K. Esto evita descontar versiones nunca cobradas.
  Se muestra el importe propio de K, aunque difiera del pago anterior.
- **Devolución D / nota C:** movimiento negativo D*/C* del auxiliar, sobre
  documento F o D/C. No exige PA dentro del mes. Incluye documentos liquidados
  cuyo DESCXC actual sea cero; mantiene DESFACT=1 y filtros de sucursal/agente.
- **Reversión de un abono:** K positivo de documento D/C. Compensa la disminución
  original cuando se cancela una devolución o nota; no se convierte en otra resta.

FTIPMV confirma K=Cancelación, D*=Nota de devolución y C*=Nota de crédito,
con afectación de cuentas por cobrar de D/C=-1. La inclusión de K en comisiones
es una regla nueva solicitada por el usuario, no una tasa inferida del catálogo.

La consulta usa un CTE de eventos y devuelve **una fila por ASEQ**. Si el D/C
está aplicado al auxiliar de F, busca un documento de origen único por número,
compañía y cliente. Un abono propio del documento D/C tiene prioridad sobre
una segunda aplicación al auxiliar de una factura. Si no hay un origen único,
se conserva el importe conocido con aviso y costo no disponible.

El SQL parametrizado completo está en
`src/modules/sales/commissions/infrastructure/datasources/legacy-mysql-collection-commissions-data-source.ts`.
Se leen por separado cobros, ajustes, movimientos y partidas dentro del mismo
snapshot READ ONLY. Los límites de 10,000 renglones y 100,000 detalles rechazan
el exceso con 413; no truncan silenciosamente.

Se mantiene la exclusión completa de servicios FINV.ITIPO=4, incluidas mixtas,
tanto del propietario del auxiliar como del documento que aporta las partidas.
Se conservan los almacenes 01/15 de México y el mapeo de las demás sucursales.

## Importes, costo y comisión

Importe del ajuste **A = ACANT/(1+DPORCIVA/100)**, sin IVA y redondeado a centavos.
D/C y cancelación F conservan signo negativo; la reversión D/C es positiva.
`displayPaymentAmount` mantiene ese signo. `paymentAmount=-A` conserva la
convención financiera usada por la liquidación; no se afirma que el ajuste sea PA.
Los movimientos crudos conservan ATIPMV/ACANT originales y paymentCount=0.

Para el costo se usan únicamente las partidas históricas AICOSTO*AICANTF:

- Cancelación F: movimiento de venta correspondiente a la compañía original.
- D/C: movimiento D*/C* del documento que origina el abono; no toma por error
  las partidas completas de la factura propietaria del auxiliar.
- La base es DBRUTO del documento de origen. Si fue borrado al cancelar, puede
  recuperarse del movimiento original del auxiliar, cuando existe.
- Costo del ajuste = ABS(costo histórico) × A / ABS(base original), con redondeo
  a centavos. Prorratea aplicaciones parciales y conserva el signo del ajuste.
  Costo y costo real representan el costo atribuible a ese evento.
- Utilidad del ajuste = A − costo del ajuste, sin ABS. Se agrega a los cobros,
  disminuyendo la utilidad neta y la comisión según el plan elegido del agente.

No usa costo actual, listas ni promedios para sustituir datos perdidos. Si falta
la base o las partidas, costo/utilidad/comisión afectados quedan pendientes,
sin tratar lo desconocido como cero. La marca actual de clientes nuevos/recuperados
y LM también conservan el signo de la disminución. No reconstruye tasas ni
clasificaciones históricas de pagos de comisiones no registrados en esta API.

El Excel de referencia sirve para conciliación. Sus importes pueden diferir del
origen actual; no se incrustan costos particulares del archivo en el código.

## Caso solicitado

FE0064831 conserva PA del **2026-09-23**, 26,320.43 con IVA, 22,690.03 sin IVA.
El auxiliar registra **K el 2026-10-29**, −24,198.57 con IVA, **−20,860.84 sin IVA**.

Septiembre contiene únicamente su renglón de cobro. Octubre contiene el ajuste
negativo, con **CANCELADA / REVISAR**, sin repetir el PA de septiembre.
La base actual conserva sólo una partida K con cantidades/costos cero, por lo
que no se inventa el costo de venta desaparecido. El importe negativo es visible;
el cálculo completo de su utilidad requiere conciliar el costo histórico.

## Contrato y presentación

`invoices[]` conserva el nombre HTTP, pero contiene cobros y ajustes. Agrega:
`rowKey` (`collection:DSEQ` o `movement:ASEQ`), `kind`, `eventDate`,
`sourceMovementId`, `relatedInvoiceNumber`, `reviewRequired`, `reviewReasons`.
`id` sigue siendo el documento propietario del auxiliar; no es una clave única
de renglón. El cliente usa rowKey para permitir cobro y cancelación del mismo F.

Tipos: collection, cancellation, return, credit-note, adjustment-reversal.
`totals.invoices` y el resumen cuentan renglones; `payments` cuenta sólo PA.
Devoluciones/NC muestran subtotal cero, abono negativo y total negativo;
cancelaciones/reversiones muestran su importe firmado en subtotal y total.
Se conservan subtotales por agente y fórmulas de comisión sobre utilidad neta.

Pantalla usa Badge/Alert de shadcn, fondo ámbar y **REVISAR**. Excel conserva
las quince columnas, tres filas por agente y bloque azul de catorce filas;
agrega el letrero en la misma celda del documento y una nota de conciliación.
Fecha pago / ajuste y Pago / ajuste describen correctamente ambos tipos.

## Verificación

Fixtures prueban fechas, importe menor, signos, costo proporcional, comisión
negativa, D/C sin PA, origen de partidas, reversión de una nota, prefijos C/D
genéricos, deduplicación de ASEQ, servicios y datos no disponibles.
La base real confirma el caso solicitado, devoluciones y notas de México.
La consulta de todas las sucursales devuelve renglones únicos y sin servicios.
Evidencia privada bajo `captures/sql/new-version/sales/commission-adjustments-20261110/`
y `captures/ui/new-version/commission-adjustments-20261110/`, fuera de Git.

Validaciones finales: backend `pnpm lint`, `pnpm build`, `pnpm test` (**249 pruebas**);
frontend `pnpm lint`, `pnpm typecheck`, `pnpm build`. México: septiembre 80
renglones (70 cobros y 10 ajustes), octubre 129 (120 cobros y 9 ajustes).
Todas las sucursales en octubre: 1,048 renglones, 24 ajustes, claves únicas y
sin productos de servicio. Decimal independiente concilia los 19 ajustes de
México contra sus movimientos de origen, base y costo. Cinco Excel contrastados
con API/XML y evaluador de fórmulas: 13 hojas en septiembre, 17 en octubre,
siempre quince columnas individuales y resumen de tres filas por agente.
No se afirma recálculo nativo de Excel. Los porcentajes fijos de las simulaciones
no se guardan como configuración ni como autorización global del usuario.
