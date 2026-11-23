import type { SimulateSalesStamping } from '../../application/use-cases/simulate-sales-stamping.js';
import type { InvoicePanelsDataSource } from '../../domain/datasources/invoice-panels-data-source.js';
import type { InvoicePanelKey, InvoicePanelResult } from '../../domain/repositories/invoice-panels-repository.js';
import { readSalesRemissionInvoice } from './invoices-with-sales-remissions-data-source.js';
import { invoicePanelMetadata } from './legacy-mysql-invoice-panels-data-source.js';
import { isLocalSalesRemissionId } from './postgres-sales-remissions.js';

export class InvoicePanelsWithSalesRemissionsDataSource implements InvoicePanelsDataSource {
  constructor(
    private readonly legacy: InvoicePanelsDataSource,
    private readonly stamping: SimulateSalesStamping,
  ) {}

  async getPanel(id: number, key: InvoicePanelKey): Promise<InvoicePanelResult | null> {
    if (!isLocalSalesRemissionId(id)) return this.legacy.getPanel(id, key);
    const record = await readSalesRemissionInvoice(id);
    if (!record) return null;
    const { invoice, charge } = record;
    const base = { invoice: { id, number: invoice.number }, key, ...invoicePanelMetadata[key], readOnly: true };
    if (key === 'auxiliary') {
      return {
        ...base, available: true, source: 'postgres',
        items: charge > 0 ? [{
          id, date: invoice.dates.issuedAt, movementType: invoice.movementType, reference: invoice.orderNumber,
          charges: charge, credits: 0, amount: charge,
        }] : [],
        summary: { charges: charge, credits: 0, balance: charge },
      };
    }
    if (key === 'ct') {
      const items = invoice.lines.map(({ id, productCode, description, quantity, fulfilledQuantity, unit, price, branch, pieces }) => ({
        id, productCode, product: description, ordered: quantity, fulfilled: fulfilledQuantity, unit, price, branch, pieces,
      }));
      return {
        ...base, available: true, source: 'postgres', items,
        summary: { ordered: invoice.totals.quantity, fulfilled: invoice.totals.fulfilledQuantity },
      };
    }
    if (key === 'seal') {
      const { status, cfdStatus, folio, canceled } = invoice;
      const stampingSimulation = await this.stamping.inspect(invoice);
      return {
        ...base, available: Boolean(stampingSimulation), source: 'postgres', items: [{ status, cfdStatus, folio, canceled }],
        ...(stampingSimulation
          ? { stampingSimulation, readOnly: Boolean(stampingSimulation.result) }
          : { summary: { mutationEnabled: false }, reason: 'La remisión FA se emite sin timbrado fiscal.' }),
      };
    }
    return {
      ...base, available: false, source: 'static', items: [], reason: 'La acción no está habilitada para las remisiones web.',
    };
  }
}
