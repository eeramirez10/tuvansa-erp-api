import { describe, expect, it } from 'vitest';
import { buildCollectionCommissions, type CollectionInvoiceInput, type CollectionProduct, type CollectionAdjustment } from '../src/modules/sales/commissions/domain/entities/collection-commissions.js';

const options = { company: 'TEST', defaultFrom: '', defaultTo: '', branches: [{ code: '01', name: 'MEXICO', warehouses: ['01'] }], agents: [{ code: 'A01', name: 'TEST' }] };
const criteria = { from: '2026-10-01', to: '2026-10-31', branch: '01', agent: 'all' };
const settings = { bonusMode: 'additional' as const, agents: [{ code: 'A01', plan: 'fixed' as const, fixedRate: 10 }] };
const invoice: CollectionInvoiceInput = { id: 10, number: 'FE001', canceled: false, date: '2026-09-01', firstPaymentDate: '2026-10-05', lastPaymentDate: '2026-10-05',
  customerCode: 'TEST', customerName: 'TEST', agentCode: 'A01', agentName: 'TEST', warehouse: '01', currency: 1, companyId: 1,
  subtotal: '1000', payments: '-1000', returns: '0', freight: '0', newCustomer: '', customerStatusRaw: 'Recurrente', paymentCount: 1, invalidVatCount: 0 };
const product: CollectionProduct = { id: 1, invoiceId: 10, productId: 1, code: 'TEST', description: '', family: '', quantity: '1', billedQuantity: '1',
  price: '1000', unitCost: '600', applied: 0, movementType: 'FA', location: '', typeId: 1 };
const event: CollectionAdjustment = { movementId: 100, kind: 'cancellation', date: '2026-10-29', amount: '-800', movementType: 'K',
  sourceDocumentId: 10, sourceSubtotal: '1000', relatedInvoiceNumber: 'FE001' };
const adjusted = (extra: Partial<CollectionAdjustment> = {}, row: Partial<CollectionInvoiceInput> = {}): CollectionInvoiceInput =>
  ({ ...invoice, canceled: true, payments: '0', paymentCount: 0, firstPaymentDate: '2026-10-29', lastPaymentDate: '2026-10-29', ...row, adjustment: { ...event, ...extra } });
const report = (invoices: CollectionInvoiceInput[], products: CollectionProduct[] = []) => buildCollectionCommissions(options, criteria, { invoices, products, movements: [] }, '', settings);

describe('Ajustes de comisiones por fecha del auxiliar', () => {
  it('presenta cancelación en octubre en negativo, por el importe menor de K y sin recontar el pago de septiembre', () => {
    const result = report([adjusted({ amount: '-20860.83620690', sourceSubtotal: '20860.83620690' }, { number: 'FE0064831', subtotal: '0' })]);
    expect(result.invoices[0]).toMatchObject({ rowKey: 'movement:100', kind: 'cancellation', eventDate: '2026-10-29', reviewRequired: true,
      paymentCount: 0, displayPaymentAmount: -20860.84, paymentAmount: 20860.84, totalAmount: -20860.84, cost: null, profit: null });
    expect(result.totals).toMatchObject({ payments: 0, displayPayment: -20860.84 });
    expect(result.settlement.agents[0]).toMatchObject({ payment: -20860.84, regularCommission: null });
  });
  it('disminuye costo, utilidad y comisión, manteniendo separado el PA y la cancelación del mismo documento', () => {
    const result = report([invoice, adjusted()], [product]);
    expect(new Set(result.invoices.map(r => r.rowKey)).size).toBe(2);
    expect(result.invoices.find(r => r.kind === 'cancellation')).toMatchObject({ displayPaymentAmount: -800, cost: -480, realCost: -480, profit: -320, margin: 40 });
    expect(result.settlement.agents[0]).toMatchObject({ payment: 200, cost: 120, netProfit: 80, regularCommission: 8 });
  });
  it('incluye devolución sin PA y toma las partidas del documento D, no las de la factura propietaria del auxiliar', () => {
    const result = report([adjusted({ kind: 'return', movementType: 'DA', sourceDocumentId: 20, sourceSubtotal: '-100', amount: '-100' }, { number: 'DA001', canceled: false })],
      [product, { ...product, id: 2, invoiceId: 20, movementType: 'DA', billedQuantity: '-2', unitCost: '30' }]);
    expect(result.invoices[0]).toMatchObject({ kind: 'return', subtotalAmount: 0, returnAmount: -100, totalAmount: -100, displayPaymentAmount: -100, cost: -60, realCost: -60, profit: -40 });
    expect(result.settlement.agents[0]).toMatchObject({ netProfit: -40, regularCommission: -4 });
  });
  it('incluye notas C sin cobro del periodo y conserva el costo registrado, sin suponer costo cero', () => {
    const result = report([adjusted({ kind: 'credit-note', movementType: 'CA', amount: '-100', sourceSubtotal: '-100' }, { number: 'CA001', canceled: false })],
      [{ ...product, movementType: 'CA', billedQuantity: '-1', unitCost: '1.71' }]);
    expect(result.invoices[0]).toMatchObject({ returnAmount: 0, creditNoteAmount: -100, displayPaymentAmount: -100, cost: -1.71, profit: -98.29 });
    expect(result.totals).toMatchObject({ returns: 0, creditNotes: -100 });
    expect(result.settlement.agents[0]?.regularCommission).toBe(-9.83);
  });
  it('la cancelación de una nota C compensa el abono original con un movimiento positivo', () => {
    const credit = adjusted({ kind: 'credit-note', movementType: 'CA', amount: '-100', sourceSubtotal: '-100' }, { number: 'CA001' });
    const reversal = adjusted({ kind: 'adjustment-reversal', movementId: 101, amount: '100', sourceSubtotal: '-100' }, { number: 'CA001' });
    const result = report([credit, reversal], [{ ...product, movementType: 'CA', billedQuantity: '-1', unitCost: '60' }]);
    expect(result.invoices.find(r => r.kind === 'adjustment-reversal')).toMatchObject({ subtotalAmount: 0, returnAmount: 0, creditNoteAmount: 100, displayPaymentAmount: 100, cost: 60, profit: 40 });
    expect(result.totals).toMatchObject({ subtotal: 0, returns: 0, creditNotes: 0, total: 0 });
    expect(result.totals.displayPayment).toBe(0); expect(result.settlement.agents[0]?.regularCommission).toBe(0);
  });
  it('prorratea el costo si un D se aplica parcialmente y no duplica un mismo ASEQ', () => {
    const row = adjusted({ kind: 'return', amount: '-50', movementType: 'DA', sourceDocumentId: 20, sourceSubtotal: '-100' }, { number: 'DA001' });
    const result = report([row, row], [{ ...product, invoiceId: 20, movementType: 'DA', billedQuantity: '-1', unitCost: '60' }]);
    expect(result.invoices).toHaveLength(1); expect(result.invoices[0]).toMatchObject({ cost: -30, profit: -20 });
  });
  it('admite prefijos genéricos C/D además de series de dos letras al revertir un abono', () => {
    const result = report([adjusted({ kind: 'adjustment-reversal', amount: '100', sourceSubtotal: '-100' }, { number: 'C001' })],
      [{ ...product, movementType: 'C', billedQuantity: '-1', unitCost: '60' }]);
    expect(result.invoices[0]).toMatchObject({ costMovementType: 'C', cost: 60, profit: 40 });
  });
  it('ajusta el 1% de clientes nuevos y LM con signo negativo y conserva el redondeo', () => {
    const result = report([adjusted({}, { customerStatusRaw: 'Nuevo' })], [{ ...product, location: 'XXX' }]);
    expect(result.invoices[0]).toMatchObject({ customerBonusBase: -800, customerBonus: -8, lmAmount: -8 });
    expect(result.settlement.agents[0]).toMatchObject({ regularCommission: -32, customerBonus: -8, lmBonus: -8, totalCommission: -48 });
  });
  it('un servicio en el documento D excluye el ajuste completo y sus datos de auditoría', () => {
    const result = report([adjusted({ kind: 'return', sourceDocumentId: 20 })], [product, { ...product, invoiceId: 20, typeId: 4 }]);
    expect(result.empty).toBe(true); expect(result.products).toEqual([]);
  });
  it('integra la nota del agente anterior en el vendedor resuelto y conserva su origen sin duplicar el abono', () => {
    const credit = adjusted({ kind: 'credit-note', movementType: 'CA', amount: '-100', sourceSubtotal: '-100' },
      { number: 'CA001', canceled: false, agentAttribution: { originalCode: 'OLD', originalName: 'ANTERIOR', source: 'latest-invoice' } });
    const result = report([invoice, credit, credit], [product, { ...product, id: 2, movementType: 'CA', billedQuantity: '-1', unitCost: '60' }]);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]).toMatchObject({ code: 'A01', invoices: 2, returns: 0, creditNotes: -100, displayPayment: 900, realCost: 540, profit: 360 });
    const note = result.invoices.find(r => r.kind === 'credit-note')!;
    expect(note).toMatchObject({ agentCode: 'A01', originalAgentCode: 'OLD', originalAgentName: 'ANTERIOR', agentAssignment: 'latest-invoice', agentReassigned: true });
    expect(note.reviewReasons.join(' ')).toContain('última factura vigente');
    expect(result.settlement.agents[0]).toMatchObject({ code: 'A01', payment: 900, netProfit: 360, regularCommission: 36 });
  });
  it('documenta la alternativa del catálogo y conserva las notas sin agente resoluble para revisión', () => {
    const rows = [adjusted({ kind: 'credit-note', movementType: 'CA', amount: '-100' },
      { number: 'CA001', agentAttribution: { originalCode: 'OLD', originalName: 'ANTERIOR', source: 'customer-catalog' } }),
    adjusted({ kind: 'credit-note', movementId: 101, movementType: 'CA', amount: '-50' }, { number: 'CA002', agentCode: 'OLD', agentName: 'ANTERIOR' })];
    const result = report(rows);
    expect(result.invoices.find(r => r.number === 'CA001')?.reviewReasons.join(' ')).toContain('catálogo actual del cliente');
    expect(result.invoices.find(r => r.number === 'CA002')).toMatchObject({ agentCode: 'OLD', originalAgentCode: 'OLD', agentAssignment: 'document', agentReassigned: false, creditNoteAmount: -50 });
    expect(result.invoices.find(r => r.number === 'CA002')?.reviewReasons.join(' ')).toContain('se conserva el agente original');
    expect(result.totals.creditNotes).toBe(-150);
  });
  it('las devoluciones y sus reversiones compensan sólo Devoluciones; notas sin importe no fabrican un total conocido', () => {
    const result = report([adjusted({ kind: 'return', movementType: 'DA', amount: '-100' }, { number: 'DA001' }),
      adjusted({ kind: 'adjustment-reversal', movementId: 101, amount: '100' }, { number: 'DA001' })]);
    expect(result.totals).toMatchObject({ subtotal: 0, returns: 0, creditNotes: 0, total: 0 });
    expect(result.invoices.map(r => r.returnAmount)).toEqual([-100,100]);
    const unknown = report([adjusted({ kind: 'credit-note', movementType: 'CA', amount: null }, { number: 'CA001' })]);
    expect(unknown.invoices[0]).toMatchObject({ returnAmount: 0, creditNoteAmount: null });
    expect(unknown.totals.creditNotes).toBeNull(); expect(unknown.agents[0]?.creditNotes).toBeNull();
  });
  it('no fabrica ceros si el movimiento carece de IVA/base/costo válido', () => {
    const result = report([adjusted({ amount: null, sourceSubtotal: null, sourceDocumentId: null }, { invalidVatCount: 1 })]);
    expect(result.invoices[0]).toMatchObject({ subtotalAmount: null, displayPaymentAmount: null, cost: null, profit: null, reviewRequired: true });
    expect(result.totals.subtotal).toBeNull();
    expect(result.totals.displayPayment).toBeNull(); expect(result.settlement.agents[0]?.regularCommission).toBeNull();
  });
});
