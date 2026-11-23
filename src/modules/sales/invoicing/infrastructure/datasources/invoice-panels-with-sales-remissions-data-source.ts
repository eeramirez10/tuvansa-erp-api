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
      const payments = await readCustomerCollections<(Record<string, unknown> & { credits: number })[]>([], async (client) => {
        const { rows } = await client.query<Record<string, unknown> & { credits: number }>(
          `SELECT id::float8 AS id, date::text, movement_type AS "movementType", number AS "collectionNumber",
                  coalesce(nullif(reference,''), number) AS reference, 0 AS charges, amount::float8 AS credits,
                  (-amount)::float8 AS amount, id::float8 AS "policyId", policy_number AS "policyNumber"
           FROM tuvansa.customer_collections WHERE remission_id = $1 AND company_id = 1 ORDER BY date,id`, [id],
        );
        return rows;
      });
      const charges = charge > 0 ? [{
        id, date: invoice.dates.issuedAt, movementType: invoice.movementType, reference: invoice.orderNumber,
        charges: charge, credits: 0, amount: charge,
      }] : [];
      const credits = Number(payments.reduce((total, item) => total + item.credits, 0).toFixed(2));
      return {
        ...base, available: true, source: 'postgres',
        items: [...charges, ...payments],
        summary: { charges: charge, credits, balance: Number((charge - credits).toFixed(2)) },
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
import { readCustomerCollections } from '../../../../accounts-receivable/clients/infrastructure/datasources/postgres-customer-collections.js';
