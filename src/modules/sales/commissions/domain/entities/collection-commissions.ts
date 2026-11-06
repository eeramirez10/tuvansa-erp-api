export type CollectionCriteria = { from: string; to: string; branch: string; agent: string };
export type CollectionOptions = { company: string; defaultFrom: string; defaultTo: string;
  branches: Array<{ code: string; name: string; warehouses: string[] }>;
  agents: Array<{ code: string; name: string }> };
export type CollectionInvoiceInput = { id: number; number: string; date: string; firstPaymentDate: string; lastPaymentDate: string;
  customerCode: string; customerName: string; agentCode: string; agentName: string; warehouse: string; currency: number;
  subtotal: string; payments: string | null; returns: string | null; freight: string; newCustomer: string;
  paymentCount: number; invalidVatCount: number };
export type CollectionMovement = { id: number; invoiceId: number; date: string; type: string; amount: string; vatRate: string;
  withoutVat: string | null; reference: string };
export type CollectionProduct = { id: number; invoiceId: number; productId: number; code: string; description: string;
  family: string; quantity: string; billedQuantity: string; price: string; unitCost: string; applied: number };
export type CollectionInputs = { invoices: CollectionInvoiceInput[]; movements: CollectionMovement[]; products: CollectionProduct[] };
export type CollectionInvoice = CollectionInvoiceInput & { branch: string; days: number; subtotalAmount: number; paymentAmount: number | null;
  returnAmount: number | null; totalAmount: number | null; freightAmount: number; paymentCapped: boolean;
  cost: null; realCost: null; profit: null; margin: null; lm: null; lmAmount: null; commissionAmount: null };

// Exact decimal-to-cent conversion; source SQL preserves eight places for VAT removal.
export function collectionCents(value: string): number {
  if (!/^-?\d+(?:\.\d{1,8})?$/.test(value)) throw new Error('Invalid collection decimal');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  const raw = BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, '0'));
  const cents = (raw + 500_000n) / 1_000_000n * (value.startsWith('-') ? -1n : 1n);
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Collection amount exceeds supported precision');
  return Number(cents);
}
export function buildCollectionCommissions(options: CollectionOptions, criteria: CollectionCriteria, input: CollectionInputs, generatedAt: string) {
  const invoices: CollectionInvoice[] = input.invoices.map(row => {
    const subtotal = collectionCents(row.subtotal), returns = row.returns === null ? null : collectionCents(row.returns);
    const payment = row.payments === null ? null : collectionCents(row.payments);
    const capped = payment !== null && Math.abs(payment) > subtotal;
    return { ...row, branch: options.branches.find(b => b.warehouses.includes(row.warehouse))?.code ?? 'unassigned',
      days: Math.round((Date.parse(row.lastPaymentDate) - Date.parse(row.date)) / 86_400_000),
      subtotalAmount: subtotal / 100, paymentAmount: payment === null ? null : (capped ? -subtotal : payment) / 100,
      returnAmount: returns === null ? null : returns / 100, totalAmount: returns === null ? null : (subtotal + returns) / 100,
      freightAmount: collectionCents(row.freight) / 100, paymentCapped: capped,
      cost: null, realCost: null, profit: null, margin: null, lm: null, lmAmount: null, commissionAmount: null };
  });
  const summarize = (rows: CollectionInvoice[]) => ({ invoices: rows.length, payments: rows.reduce((sum, r) => sum + r.paymentCount, 0),
    subtotal: rows.reduce((sum, r) => sum + Math.round(r.subtotalAmount * 100), 0) / 100,
    payment: rows.some(r => r.paymentAmount === null) ? null : rows.reduce((sum, r) => sum + Math.round(r.paymentAmount! * 100), 0) / 100,
    returns: rows.some(r => r.returnAmount === null) ? null : rows.reduce((sum, r) => sum + Math.round(r.returnAmount! * 100), 0) / 100,
    total: rows.some(r => r.totalAmount === null) ? null : rows.reduce((sum, r) => sum + Math.round(r.totalAmount! * 100), 0) / 100,
    freight: rows.reduce((sum, r) => sum + Math.round(r.freightAmount * 100), 0) / 100 });
  const agents = [...new Set(invoices.map(r => r.agentCode))].map(code => {
    const rows = invoices.filter(r => r.agentCode === code);
    return { code, name: rows[0]!.agentName, ...summarize(rows) };
  });
  return { title: 'Comisiones por cobranza', company: options.company, criteria, generatedAt, source: 'derivada' as const,
    status: 'preliminary' as const, calculationReady: false, invoices, movements: input.movements, products: input.products,
    agents, totals: summarize(invoices), empty: invoices.length === 0,
    notes: [
      'PRELIMINAR: falta el método 214_Calcula_Costo_de__Facturas y la regla del importe de comisión. Costo, costo real, utilidad, %, LM, LM_VALOR y comisión están pendientes; no se sustituyen por cero.',
      'Periodo inclusivo aplicado a FAX.AFECHA, no a FDOC.DFECHA. Incluye facturas con uno o más pagos PA en el periodo, aunque sean parciales o de facturas de otros meses.',
      'Referencia: métodos 211 y 213 de los PDF proporcionados. Pagos PA y devoluciones de tipo D se suman por separado sin IVA: ACANT/(1+DPORCIVA/100). Conserva los signos originales.',
      'Pago presentado limitado al negativo del subtotal DBRUTO cuando su valor absoluto supera ese subtotal, según el método 211. Los movimientos conservan los importes sin limitar.',
      'Una fila por DSEQ. Fecha pago y días usan el último PA del periodo; también se conserva la primera fecha y cada movimiento. No se usa una fecha arbitraria de GROUP BY DNUM.',
      'Facturas DESFACT=1 con folio F, DCANCELADA=0; excluye AF. No se hereda DSTATUSCFD=3 del reporte de ventas por familia. Devoluciones sin PA del periodo no generan una fila.',
      'México usa los almacenes 01 y 15 del método 213. Las demás sucursales se amplían con el catálogo FALMCAT; sin atribuir movimientos por el nombre del almacén.',
      'FAG se limita a AGT=1 y se agrupa por código para evitar multiplicar pagos. Las partidas FAXINV/FINV se leen aparte: no multiplican la cobranza ni se usan aún para inventar el costo del método faltante.',
      'Cliente nuevo conserva la marca actual CLITARJETA=Nuevo. Importes sin conversión adicional de moneda, descuentos ni IVA; no se afirma moneda base no verificada.',
    ] };
}
export type CollectionCommissions = ReturnType<typeof buildCollectionCommissions>;
