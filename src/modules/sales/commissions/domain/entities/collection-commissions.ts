import { collectionCustomerBonus } from './collection-customer-bonus.js';
import { buildCollectionSettlement, type SettlementSettings } from './collection-settlement.js';

export type CollectionCriteria = { from: string; to: string; branch: string; agent: string; customerId?: number | undefined };
export type CollectionOptions = { company: string; defaultFrom: string; defaultTo: string;
  branches: Array<{ code: string; name: string; warehouses: string[] }>;
  agents: Array<{ code: string; name: string }> };
export type CollectionAgentAssignment = 'document' | 'latest-invoice' | 'customer-catalog';
export type CollectionAdjustment = { movementId: number; kind: 'cancellation' | 'return' | 'credit-note' | 'adjustment-reversal';
  date: string; amount: string | null; movementType: string; sourceDocumentId: number | null;
  sourceSubtotal: string | null; relatedInvoiceNumber: string | null };
export type CollectionInvoiceInput = { id: number; number: string; canceled: boolean; date: string; firstPaymentDate: string; lastPaymentDate: string;
  customerCode: string; customerName: string; agentCode: string; agentName: string; warehouse: string; currency: number; companyId: number;
  subtotal: string; payments: string | null; returns: string | null; freight: string; newCustomer: string; customerStatusRaw: string;
  paymentCount: number; invalidVatCount: number; adjustment?: CollectionAdjustment;
  agentAttribution?: { originalCode: string; originalName: string; source: CollectionAgentAssignment } };
export type CollectionMovement = { id: number; invoiceId: number; date: string; type: string; amount: string; vatRate: string;
  withoutVat: string | null; reference: string };
export type CollectionProduct = { id: number; invoiceId: number; productId: number; code: string; description: string;
  family: string; quantity: string; billedQuantity: string; price: string; unitCost: string; applied: number; movementType: string; location: string; typeId: number | null };
export type CollectionInputs = { invoices: CollectionInvoiceInput[]; movements: CollectionMovement[]; products: CollectionProduct[] };
export type CollectionInvoice = CollectionInvoiceInput & ReturnType<typeof collectionCustomerBonus> & { branch: string; days: number; subtotalAmount: number | null; paymentAmount: number | null;
  rowKey: string; kind: 'collection' | CollectionAdjustment['kind']; eventDate: string; sourceMovementId: number | null;
  relatedInvoiceNumber: string | null; reviewRequired: boolean; reviewReasons: string[];
  originalAgentCode: string; originalAgentName: string; agentAssignment: CollectionAgentAssignment; agentReassigned: boolean;
  returnAmount: number | null; creditNoteAmount: number | null; totalAmount: number | null; freightAmount: number; paymentCapped: boolean; displayPaymentAmount: number | null;
  cost: number | null; realCost: number | null; profit: number | null; signedProfit: number | null; margin: number | null;
  lm: number | null; lmAmount: number | null; costMovementType: string | null; costStatus: 'complete' | 'unavailable'; commissionAmount: null };

// Exact decimal-to-cent conversion; source SQL preserves eight places for VAT removal.
export function collectionCents(value: string): number {
  if (!/^-?\d+(?:\.\d{1,8})?$/.test(value)) throw new Error('Invalid collection decimal');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const raw = BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  const cents = (raw + 500_000n) / 1_000_000n * (value.startsWith('-') ? -1n : 1n);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Collection amount exceeds supported precision');
  return Number(cents);
}
// Eight-place fixed point for quantity (3) * historical unit cost/price (5).
function fixed(value: string): bigint {
  if (!/^-?\d+(?:\.\d{1,8})?$/.test(value)) throw new Error('Invalid collection decimal');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  return (BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0'))) * (value.startsWith('-') ? -1n : 1n);
}
function rounded(numerator: bigint, denominator: bigint): number {
  const negative = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator, d = denominator < 0n ? -denominator : denominator;
  if (!d) throw new Error('Invalid collection divisor');
  const result = ((n + d / 2n) / d) * (negative ? -1n : 1n);
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Collection amount exceeds supported precision');
  return Number(result);
}
const saleMovementTypes: Record<number, string> = { 1: 'FA', 2: 'FB', 3: 'FC', 4: 'FD', 5: 'FZ', 6: 'FV', 7: 'FX' };
export function buildCollectionCommissions(options: CollectionOptions, criteria: CollectionCriteria, input: CollectionInputs, generatedAt: string, settings?: SettlementSettings) {
  const products = new Map<number, CollectionProduct[]>();
  for (const product of input.products) { const rows = products.get(product.invoiceId) ?? []; rows.push(product); products.set(product.invoiceId, rows); }
  // Any service line excludes the whole document, including mixed invoices.
  const serviceInvoices = new Set(input.products.filter(p => p.typeId === 4).map(p => p.invoiceId));
  const seen = new Set<string>();
  const invoices = input.invoices.filter(row => !serviceInvoices.has(row.id) && !serviceInvoices.has(row.adjustment?.sourceDocumentId ?? row.id))
    .filter(row => {
      const key = row.adjustment ? `movement:${row.adjustment.movementId}` : `collection:${row.id}`;
      if (seen.has(key)) return false; seen.add(key); return true;
    }).map<CollectionInvoice>(row => {
    const attribution = { originalAgentCode: row.agentAttribution?.originalCode ?? row.agentCode,
      originalAgentName: row.agentAttribution?.originalName ?? row.agentName,
      agentAssignment: row.agentAttribution?.source ?? 'document' as CollectionAgentAssignment,
      agentReassigned: row.agentAttribution !== undefined && row.agentAttribution.originalCode !== row.agentCode };
    if (row.adjustment) {
      const event = row.adjustment;
      const amount = event.amount === null ? null : collectionCents(event.amount);
      const denominator = event.sourceSubtotal === null ? null : Math.abs(collectionCents(event.sourceSubtotal));
      const costMovementType = event.kind === 'cancellation' ? saleMovementTypes[row.companyId] ?? null
        : event.kind === 'adjustment-reversal' ? row.number.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? null : event.movementType;
      const lines = (products.get(event.sourceDocumentId ?? -1) ?? []).filter(p => p.movementType === costMovementType);
      const sourceCost = lines.length ? rounded(lines.reduce((sum, p) => sum + fixed(p.unitCost) * fixed(p.billedQuantity), 0n), 100_000_000_000_000n) : null;
      const proportional = sourceCost === null || amount === null || !denominator ? null
        : rounded(BigInt(Math.abs(sourceCost)) * BigInt(amount), BigInt(denominator));
      const profit = proportional === null || amount === null ? null : amount - proportional;
      const lmLines = lines.filter(p => p.location === 'XXX');
      const sourceLm = !lines.length ? null : rounded(lmLines.reduce((sum, p) => sum + fixed(p.price) * fixed(p.billedQuantity), 0n), 10_000_000_000_000_000n);
      const lmAmount = sourceLm === null || amount === null || !denominator ? null
        : rounded(BigInt(Math.abs(sourceLm)) * BigInt(amount), BigInt(denominator));
      const reviewReasons = ['Ajuste del auxiliar: revisar contra las comisiones del documento original.'];
      if (proportional === null) reviewReasons.push('No existe base histórica suficiente para calcular el costo y la utilidad del ajuste.');
      if (event.sourceDocumentId === null) reviewReasons.push('No se identificó un documento de origen único para las partidas.');
      if (event.relatedInvoiceNumber === null) reviewReasons.push('Revisar la factura relacionada y el agente al que corresponde el abono.');
      if (attribution.agentReassigned) reviewReasons.push(`Nota de crédito del agente ${attribution.originalAgentCode || 'sin código'} (${attribution.originalAgentName}) asignada a ${row.agentCode} (${row.agentName}) por ${attribution.agentAssignment === 'latest-invoice' ? 'la última factura vigente del mismo cliente y compañía hasta el cierre del reporte' : 'el catálogo actual del cliente'}.`);
      const isCredit = event.kind === 'credit-note' || (event.kind === 'adjustment-reversal' && row.number.startsWith('C'));
      const isReturn = event.kind === 'return' || (event.kind === 'adjustment-reversal' && row.number.startsWith('D'));
      if (isCredit && attribution.agentAssignment === 'document') reviewReasons.push('Sin factura vigente ni agente válido en el catálogo del cliente: se conserva el agente original; revisar asignación.');
      return { ...row, ...attribution, ...collectionCustomerBonus(row.customerStatusRaw, amount === null ? null : -amount),
        rowKey: `movement:${event.movementId}`, kind: event.kind, eventDate: event.date, sourceMovementId: event.movementId,
        relatedInvoiceNumber: event.relatedInvoiceNumber, reviewRequired: true, reviewReasons,
        branch: options.branches.find(b => b.warehouses.includes(row.warehouse))?.code ?? 'unassigned',
        days: Math.round((Date.parse(event.date) - Date.parse(row.date)) / 86_400_000),
        // The legacy paymentAmount has the inverse financial sign. The visible
        // adjustment keeps the actual debit/credit sign; never apply ABS here.
        subtotalAmount: isCredit || isReturn ? 0 : amount === null ? null : amount / 100,
        paymentAmount: amount === null ? null : amount === 0 ? 0 : -amount / 100,
        displayPaymentAmount: amount === null ? null : amount / 100,
        returnAmount: isReturn ? amount === null ? null : amount / 100 : 0,
        creditNoteAmount: isCredit ? amount === null ? null : amount / 100 : 0,
        totalAmount: amount === null ? null : amount / 100, freightAmount: 0, paymentCapped: false,
        cost: proportional === null ? null : proportional / 100, realCost: proportional === null ? null : proportional / 100,
        profit: profit === null ? null : profit / 100, signedProfit: profit === null ? null : -profit / 100,
        margin: profit === null || !amount ? null : rounded(BigInt(profit) * 10_000n, BigInt(amount)) / 100,
        lm: lines.length && amount !== null ? Math.sign(amount) * lmLines.length : null,
        lmAmount: lmAmount === null ? null : lmAmount / 100, costMovementType,
        costStatus: proportional === null ? 'unavailable' : 'complete', commissionAmount: null };
    }
    const subtotal = collectionCents(row.subtotal), returns = row.returns === null ? null : collectionCents(row.returns);
    const payment = row.payments === null ? null : collectionCents(row.payments);
    // Cancellation may zero DBRUTO after collection. A known PA must not become
    // a fictitious zero payment; an unavailable original cost remains unknown.
    const capped = payment !== null && Math.abs(payment) > subtotal && !(row.canceled && subtotal === 0);
    const presented = payment === null ? null : capped ? -subtotal : payment;
    const costMovementType = saleMovementTypes[row.companyId] ?? null;
    const lines = (products.get(row.id) ?? []).filter(p => p.movementType === costMovementType);
    // Method 214: no AIMES restriction, current cost, or commented 3% surcharge.
    const cost = lines.length ? rounded(lines.reduce((sum, p) => sum + fixed(p.unitCost) * fixed(p.billedQuantity), 0n), 100_000_000_000_000n) : null;
    const proportional = cost === null || payment === null || subtotal === 0 ? null : rounded(BigInt(cost) * BigInt(payment), BigInt(subtotal));
    const signedProfit = proportional === null || presented === null ? null : presented - proportional;
    const lmLines = lines.filter(p => p.location === 'XXX');
    const lmAmount = !lines.length ? null : rounded(lmLines.reduce((sum, p) => sum + fixed(p.price) * fixed(p.billedQuantity), 0n), 10_000_000_000_000_000n);
    return { ...row, ...attribution, ...collectionCustomerBonus(row.customerStatusRaw, presented),
      rowKey: `collection:${row.id}`, kind: 'collection', eventDate: row.lastPaymentDate, sourceMovementId: null,
      relatedInvoiceNumber: null, reviewRequired: false, reviewReasons: [],
      branch: options.branches.find(b => b.warehouses.includes(row.warehouse))?.code ?? 'unassigned',
      days: Math.round((Date.parse(row.lastPaymentDate) - Date.parse(row.date)) / 86_400_000),
      subtotalAmount: subtotal / 100, paymentAmount: payment === null ? null : (capped ? -subtotal : payment) / 100,
      displayPaymentAmount: presented === null ? null : Math.abs(presented) / 100,
      returnAmount: returns === null ? null : returns / 100, creditNoteAmount: 0, totalAmount: returns === null ? null : (subtotal + returns) / 100,
      freightAmount: collectionCents(row.freight) / 100, paymentCapped: capped,
      cost: cost === null ? null : cost / 100, realCost: proportional === null ? null : Math.abs(proportional) / 100,
      profit: signedProfit === null ? null : Math.abs(signedProfit) / 100, signedProfit: signedProfit === null ? null : signedProfit / 100,
      margin: signedProfit === null || !presented ? null : rounded(BigInt(signedProfit) * 10_000n, BigInt(presented)) / 100,
      lm: lines.length ? lmLines.length : null, lmAmount: lmAmount === null ? null : lmAmount / 100, costMovementType,
      costStatus: proportional === null ? 'unavailable' : 'complete', commissionAmount: null };
  }).sort((a, b) => a.agentCode.localeCompare(b.agentCode) || a.date.localeCompare(b.date) || a.number.localeCompare(b.number)
    || a.eventDate.localeCompare(b.eventDate) || a.rowKey.localeCompare(b.rowKey));
  const sum = (rows: CollectionInvoice[], key: 'cost' | 'realCost' | 'profit' | 'signedProfit' | 'lmAmount' | 'customerBonusBase' | 'customerBonus') => rows.some(r => r[key] === null) ? null : rows.reduce((total, r) => total + Math.round(r[key]! * 100), 0) / 100;
  const summarize = (rows: CollectionInvoice[]) => ({ invoices: rows.length, payments: rows.reduce((sum, r) => sum + r.paymentCount, 0),
    subtotal: rows.some(r => r.subtotalAmount === null) ? null : rows.reduce((sum, r) => sum + Math.round(r.subtotalAmount! * 100), 0) / 100,
    payment: rows.some(r => r.paymentAmount === null) ? null : rows.reduce((sum, r) => sum + Math.round(r.paymentAmount! * 100), 0) / 100,
    displayPayment: rows.some(r => r.displayPaymentAmount === null) ? null : rows.reduce((sum, r) => sum + Math.round(r.displayPaymentAmount! * 100), 0) / 100,
    returns: rows.some(r => r.returnAmount === null) ? null : rows.reduce((sum, r) => sum + Math.round(r.returnAmount! * 100), 0) / 100,
    creditNotes: rows.some(r => r.creditNoteAmount === null) ? null : rows.reduce((sum, r) => sum + Math.round(r.creditNoteAmount! * 100), 0) / 100,
    total: rows.some(r => r.totalAmount === null) ? null : rows.reduce((sum, r) => sum + Math.round(r.totalAmount! * 100), 0) / 100,
    freight: rows.reduce((sum, r) => sum + Math.round(r.freightAmount * 100), 0) / 100,
    cost: sum(rows, 'cost'), realCost: sum(rows, 'realCost'), profit: sum(rows, 'profit'), lmAmount: sum(rows, 'lmAmount'),
    customerBonusBase: sum(rows, 'customerBonusBase'), customerBonus: rows.some(r => r.customerBonusBase === null) ? null :
      rounded(BigInt(rows.reduce((total, r) => total + Math.round(r.customerBonusBase! * 100), 0)), 100n) / 100,
    customerBonusInvoices: rows.filter(r => r.customerBonusEligible).length, unclassifiedInvoices: rows.filter(r => r.customerStatus === 'Sin clasificar').length,
    lm: rows.some(r => r.lm === null) ? null : rows.reduce((sum, r) => sum + r.lm!, 0),
    unavailableCosts: rows.filter(r => r.costStatus === 'unavailable').length });
  const agents = [...new Set(invoices.map(r => r.agentCode))].map(code => {
    const rows = invoices.filter(r => r.agentCode === code);
    return { code, name: rows[0]!.agentName, ...summarize(rows) };
  });
  const totals = summarize(invoices);
  totals.customerBonus = agents.some(a => a.customerBonus === null) ? null : agents.reduce((total, a) => total + Math.round(a.customerBonus! * 100), 0) / 100;
  const documentIds = new Set(invoices.flatMap(r => [r.id, ...(r.adjustment?.sourceDocumentId ? [r.adjustment.sourceDocumentId] : [])]));
  return { title: 'Comisiones por cobranza', company: options.company,
    branchName: criteria.branch === 'all' ? 'Todas las sucursales' : options.branches.find(b => b.code === criteria.branch)?.name ?? criteria.branch,
    criteria, generatedAt, source: 'derivada' as const,
    status: invoices.some(r => r.costStatus === 'unavailable') ? 'incomplete' as const : 'complete' as const,
    calculationReady: invoices.every(r => r.costStatus === 'complete'), invoices,
    movements: input.movements.filter(row => documentIds.has(row.invoiceId) && !serviceInvoices.has(row.invoiceId)),
    products: input.products.filter(row => documentIds.has(row.invoiceId) && !serviceInvoices.has(row.invoiceId)),
    agents, totals, empty: invoices.length === 0,
    settlement: buildCollectionSettlement(invoices, criteria, settings),
    notes: [
      'Cobros PA: costo según el método 214 de CUATRO.pdf, SUM(AICOSTO*AICANTF), sin incremento del 3% (código comentado). Costo real=ABS(costo*pago PA sin IVA original/DBRUTO). El prorrateo usa el pago original, no el pago limitado presentado.',
      'Cobros PA: utilidad=ABS(pago firmado limitado-costo prorrateado con signo). %=utilidad con signo/pago firmado limitado*100. LM cuenta partidas con FINV.ILUGAR=XXX; LM_VALOR suma AICANTF*AIPRECIO*0.01 de esas partidas. Redondeo monetario a dos decimales; divisores cero o partidas ausentes se indican como no disponibles.',
      'Movimiento de costo por compañía FDOC.DMULTICIA: 1=FA, 2=FB, 3=FC, 4=FD, 5=FZ, 6=FV, 7=FX. No se filtra AIMES. 1/5/7 están explícitos en el método 214; los demás se verificaron en las partidas de las facturas cobradas.',
      'Periodo inclusivo aplicado a FAX.AFECHA. Incluye cobros PA y, por fecha propia, cancelaciones K con cobro previo, devoluciones D y notas C, aunque no exista PA en el periodo del ajuste. Las reversiones K de documentos D/C compensan el abono original.',
      'Los cobros PA siguen los métodos 211/213 proporcionados. D/C/K son ajustes derivados solicitados para este reporte: ACANT/(1+DPORCIVA/100), por ASEQ y con signo. No se afirma que esta ampliación sea SQL capturado de OMNIS.',
      'Cobros PA: pago de cálculo limitado al negativo de DBRUTO si lo supera. Excepción derivada: canceladas con DBRUTO=0 conservan el PA original sin IVA, pues el cero posterior no identifica el subtotal anterior. Costo/utilidad quedan no disponibles si falta histórico. Sólo PA se presenta en valor absoluto; los ajustes conservan signo y reducen los totales.',
      'Por solicitud del usuario se excluye completa cualquier factura con una partida de servicio (FINV.ITIPO=4), también las mixtas. No aporta pagos, costos, documentos ni partidas a los totales o al Excel. Se utiliza la clasificación actual del catálogo.',
      'Una fila por DSEQ para cobros PA y una por ASEQ para ajustes, con rowKey independiente. Fecha pago/ajuste usa último PA o AFECHA del ajuste. Referencia a devolución/nota y factura relacionada evita confundir el documento que aporta el costo.',
      'La cancelación K se resta por su importe sin IVA en el mes de AFECHA, no por el importe del pago anterior ni por el estado DCANCELADA. Los ajustes negativos conservan su signo en pago, costo y utilidad. REVISAR señala conciliación histórica; no sustituye costos desconocidos por cero.',
      'México usa los almacenes 01 y 15 del método 213. Las demás sucursales se amplían con el catálogo FALMCAT; sin atribuir movimientos por el nombre del almacén.',
      'Notas C y sus reversiones se asignan al agente de la última factura vigente del mismo CLISEQ y compañía hasta el fin del reporte; en ausencia de ésta se usa CLIPAR1 válido en FAG (AGT=1), y como último recurso el agente original con aviso. Se conserva la atribución original y el filtro de agente se aplica después de resolverla. No cambia al agente de PA, devoluciones D ni cancelaciones F.',
      'FAG se limita a AGT=1 y se agrupa por código para evitar multiplicar pagos. Las partidas FAXINV/FINV se leen aparte: no multiplican la cobranza. Documentos agrupados por agente con subtotales. Devoluciones y notas de crédito tienen columnas separadas; sus reversiones compensan en la misma columna.',
      'Bono de clientes: 1% del importe cobrado sin IVA para marcas actuales FCLI.CLITARJETA=Nuevo o Viejo_Reactivado. Para cálculo se invierte el signo del pago firmado, como en el Excel; los PA de signo opuesto compensan, no se vuelven ingresos por ABS. Detalle a cuatro decimales y redondeo por agente. Recurrente/Inactivo no generan bono; Sin clasificar queda pendiente.',
      'La rutina CLIENTES NUEVO.pdf clasifica usando CURDATE() y actualiza FCLI.CLITARJETA/CLILOCALIZ. El reporte sólo lee la marca guardada; no ejecuta esa rutina ni reconstruye una marca histórica a la fecha del pago.',
      'Liquidación basada en el Excel proporcionado: requiere elegir modalidad del 1% y confirmar planes pendientes. El tabulador mensual exige margen neto mayor a 16%. Los perfiles del ejemplo sólo se precargan para septiembre 2026 de México; no se extrapolan.',
      'Costo manual, flete y gratificaciones son ajustes del reporte, separados del origen; no escriben al ERP. El Excel presenta detalle por agente y fecha, resumen de tres renglones por agente y hojas individuales de dieciséis columnas con resumen compacto, marca nuevo y su 1% pagado.',
      'Importes sin conversión adicional de moneda, descuentos ni IVA; no se afirma moneda base no verificada.',
    ] };
}
export type CollectionCommissions = ReturnType<typeof buildCollectionCommissions>;
