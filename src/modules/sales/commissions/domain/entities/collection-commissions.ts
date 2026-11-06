export type CollectionCriteria = { from: string; to: string; branch: string; agent: string };
export type CollectionOptions = { company: string; defaultFrom: string; defaultTo: string;
  branches: Array<{ code: string; name: string; warehouses: string[] }>;
  agents: Array<{ code: string; name: string }> };
export type CollectionInvoiceInput = { id: number; number: string; date: string; firstPaymentDate: string; lastPaymentDate: string;
  customerCode: string; customerName: string; agentCode: string; agentName: string; warehouse: string; currency: number; companyId: number;
  subtotal: string; payments: string | null; returns: string | null; freight: string; newCustomer: string;
  paymentCount: number; invalidVatCount: number };
export type CollectionMovement = { id: number; invoiceId: number; date: string; type: string; amount: string; vatRate: string;
  withoutVat: string | null; reference: string };
export type CollectionProduct = { id: number; invoiceId: number; productId: number; code: string; description: string;
  family: string; quantity: string; billedQuantity: string; price: string; unitCost: string; applied: number; movementType: string; location: string; typeId: number | null };
export type CollectionInputs = { invoices: CollectionInvoiceInput[]; movements: CollectionMovement[]; products: CollectionProduct[] };
export type CollectionInvoice = CollectionInvoiceInput & { branch: string; days: number; subtotalAmount: number; paymentAmount: number | null;
  returnAmount: number | null; totalAmount: number | null; freightAmount: number; paymentCapped: boolean; displayPaymentAmount: number | null;
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
export function buildCollectionCommissions(options: CollectionOptions, criteria: CollectionCriteria, input: CollectionInputs, generatedAt: string) {
  const products = new Map<number, CollectionProduct[]>();
  for (const product of input.products) { const rows = products.get(product.invoiceId) ?? []; rows.push(product); products.set(product.invoiceId, rows); }
  // Any service line excludes the whole document, including mixed invoices.
  const serviceInvoices = new Set(input.products.filter(p => p.typeId === 4).map(p => p.invoiceId));
  const invoices = input.invoices.filter(row => !serviceInvoices.has(row.id)).map<CollectionInvoice>(row => {
    const subtotal = collectionCents(row.subtotal), returns = row.returns === null ? null : collectionCents(row.returns);
    const payment = row.payments === null ? null : collectionCents(row.payments);
    const capped = payment !== null && Math.abs(payment) > subtotal;
    const presented = payment === null ? null : capped ? -subtotal : payment;
    const costMovementType = saleMovementTypes[row.companyId] ?? null;
    const lines = (products.get(row.id) ?? []).filter(p => p.movementType === costMovementType);
    // Method 214: no AIMES restriction, current cost, or commented 3% surcharge.
    const cost = lines.length ? rounded(lines.reduce((sum, p) => sum + fixed(p.unitCost) * fixed(p.billedQuantity), 0n), 100_000_000_000_000n) : null;
    const proportional = cost === null || payment === null || subtotal === 0 ? null : rounded(BigInt(cost) * BigInt(payment), BigInt(subtotal));
    const signedProfit = proportional === null || presented === null ? null : presented - proportional;
    const lmLines = lines.filter(p => p.location === 'XXX');
    const lmAmount = !lines.length ? null : rounded(lmLines.reduce((sum, p) => sum + fixed(p.price) * fixed(p.billedQuantity), 0n), 10_000_000_000_000_000n);
    return { ...row, branch: options.branches.find(b => b.warehouses.includes(row.warehouse))?.code ?? 'unassigned',
      days: Math.round((Date.parse(row.lastPaymentDate) - Date.parse(row.date)) / 86_400_000),
      subtotalAmount: subtotal / 100, paymentAmount: payment === null ? null : (capped ? -subtotal : payment) / 100,
      displayPaymentAmount: presented === null ? null : Math.abs(presented) / 100,
      returnAmount: returns === null ? null : returns / 100, totalAmount: returns === null ? null : (subtotal + returns) / 100,
      freightAmount: collectionCents(row.freight) / 100, paymentCapped: capped,
      cost: cost === null ? null : cost / 100, realCost: proportional === null ? null : Math.abs(proportional) / 100,
      profit: signedProfit === null ? null : Math.abs(signedProfit) / 100, signedProfit: signedProfit === null ? null : signedProfit / 100,
      margin: signedProfit === null || !presented ? null : rounded(BigInt(signedProfit) * 10_000n, BigInt(presented)) / 100,
      lm: lines.length ? lmLines.length : null, lmAmount: lmAmount === null ? null : lmAmount / 100, costMovementType,
      costStatus: proportional === null ? 'unavailable' : 'complete', commissionAmount: null };
  }).sort((a, b) => a.agentCode.localeCompare(b.agentCode) || a.number.localeCompare(b.number) || a.id - b.id);
  const sum = (rows: CollectionInvoice[], key: 'cost' | 'realCost' | 'profit' | 'signedProfit' | 'lmAmount') => rows.some(r => r[key] === null) ? null : rows.reduce((total, r) => total + Math.round(r[key]! * 100), 0) / 100;
  const summarize = (rows: CollectionInvoice[]) => ({ invoices: rows.length, payments: rows.reduce((sum, r) => sum + r.paymentCount, 0),
    subtotal: rows.reduce((sum, r) => sum + Math.round(r.subtotalAmount * 100), 0) / 100,
    payment: rows.some(r => r.paymentAmount === null) ? null : rows.reduce((sum, r) => sum + Math.round(r.paymentAmount! * 100), 0) / 100,
    displayPayment: rows.some(r => r.displayPaymentAmount === null) ? null : rows.reduce((sum, r) => sum + Math.round(r.displayPaymentAmount! * 100), 0) / 100,
    returns: rows.some(r => r.returnAmount === null) ? null : rows.reduce((sum, r) => sum + Math.round(r.returnAmount! * 100), 0) / 100,
    total: rows.some(r => r.totalAmount === null) ? null : rows.reduce((sum, r) => sum + Math.round(r.totalAmount! * 100), 0) / 100,
    freight: rows.reduce((sum, r) => sum + Math.round(r.freightAmount * 100), 0) / 100,
    cost: sum(rows, 'cost'), realCost: sum(rows, 'realCost'), profit: sum(rows, 'profit'), lmAmount: sum(rows, 'lmAmount'),
    lm: rows.some(r => r.lm === null) ? null : rows.reduce((sum, r) => sum + r.lm!, 0),
    unavailableCosts: rows.filter(r => r.costStatus === 'unavailable').length });
  const agents = [...new Set(invoices.map(r => r.agentCode))].map(code => {
    const rows = invoices.filter(r => r.agentCode === code);
    return { code, name: rows[0]!.agentName, ...summarize(rows) };
  });
  return { title: 'Comisiones por cobranza', company: options.company, criteria, generatedAt, source: 'derivada' as const,
    status: invoices.some(r => r.costStatus === 'unavailable') ? 'incomplete' as const : 'complete' as const,
    calculationReady: invoices.every(r => r.costStatus === 'complete'), invoices,
    movements: input.movements.filter(row => !serviceInvoices.has(row.invoiceId)), products: input.products.filter(row => !serviceInvoices.has(row.invoiceId)),
    agents, totals: summarize(invoices), empty: invoices.length === 0,
    notes: [
      'Costo según el método 214 de CUATRO.pdf: SUM(AICOSTO*AICANTF), sin incremento del 3% (código comentado). Costo real=ABS(costo*pago PA sin IVA original/DBRUTO). El prorrateo usa el pago original, no el pago limitado presentado.',
      'Utilidad=ABS(pago firmado limitado-costo prorrateado con signo). %=utilidad con signo/pago firmado limitado*100. LM cuenta partidas con FINV.ILUGAR=XXX; LM_VALOR suma AICANTF*AIPRECIO*0.01 de esas partidas. Redondeo monetario a dos decimales; divisores cero o partidas ausentes se indican como no disponibles.',
      'Movimiento de costo por compañía FDOC.DMULTICIA: 1=FA, 2=FB, 3=FC, 4=FD, 5=FZ, 6=FV, 7=FX. No se filtra AIMES. 1/5/7 están explícitos en el método 214; los demás se verificaron en las partidas de las facturas cobradas.',
      'Periodo inclusivo aplicado a FAX.AFECHA, no a FDOC.DFECHA. Incluye facturas con uno o más pagos PA en el periodo, aunque sean parciales o de facturas de otros meses.',
      'Referencia: métodos 211 y 213 de los PDF proporcionados. Pagos PA y devoluciones de tipo D se suman por separado sin IVA: ACANT/(1+DPORCIVA/100). Conserva los signos originales.',
      'Pago de cálculo limitado al negativo del subtotal DBRUTO cuando su valor absoluto supera ese subtotal, según el método 211. Para presentación se muestra su valor absoluto; subtotales y total suman esos valores positivos por documento. El cálculo y los movimientos conservan sus signos originales.',
      'Por solicitud del usuario se excluye completa cualquier factura con una partida de servicio (FINV.ITIPO=4), también las mixtas. No aporta pagos, costos, documentos ni partidas a los totales o al Excel. Se utiliza la clasificación actual del catálogo.',
      'Una fila por DSEQ. Fecha pago y días usan el último PA del periodo; también se conserva la primera fecha y cada movimiento. No se usa una fecha arbitraria de GROUP BY DNUM.',
      'Facturas DESFACT=1 con folio F, DCANCELADA=0; excluye AF. No se hereda DSTATUSCFD=3 del reporte de ventas por familia. Devoluciones sin PA del periodo no generan una fila.',
      'México usa los almacenes 01 y 15 del método 213. Las demás sucursales se amplían con el catálogo FALMCAT; sin atribuir movimientos por el nombre del almacén.',
      'FAG se limita a AGT=1 y se agrupa por código para evitar multiplicar pagos. Las partidas FAXINV/FINV se leen aparte: no multiplican la cobranza. Documentos agrupados por agente con subtotales.',
      'Los métodos proporcionados definen el reporte de costo y utilidad sobre cobranza, no una tasa de pago al agente. No se inventa un importe de comisión adicional.',
      'Cliente nuevo conserva la marca actual CLITARJETA=Nuevo. Importes sin conversión adicional de moneda, descuentos ni IVA; no se afirma moneda base no verificada.',
    ] };
}
export type CollectionCommissions = ReturnType<typeof buildCollectionCommissions>;
