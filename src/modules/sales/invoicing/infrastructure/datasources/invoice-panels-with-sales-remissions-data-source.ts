import { customerCollectionReversalSql, customerCollectionReversalsAvailable } from '../../../../accounts-receivable/clients/infrastructure/datasources/customer-collection-reversal-reads.js';
import { readCustomerCollections } from '../../../../accounts-receivable/clients/infrastructure/datasources/postgres-customer-collections.js';
import type { SimulateSalesStamping } from '../../application/use-cases/simulate-sales-stamping.js';
import type { InvoicePanelsDataSource } from '../../domain/datasources/invoice-panels-data-source.js';
import type { InvoicePanelKey, InvoicePanelResult } from '../../domain/repositories/invoice-panels-repository.js';
import { readHistoricalSalesRemissionCancellations } from './historical-sales-remission-cancellation-reads.js';
import { readSalesRemissionInvoice } from './invoices-with-sales-remissions-data-source.js';
import { invoicePanelMetadata } from './legacy-mysql-invoice-panels-data-source.js';
import { isLocalSalesRemissionId } from './postgres-sales-remissions.js';

export class InvoicePanelsWithSalesRemissionsDataSource implements InvoicePanelsDataSource {
  constructor(
    private readonly legacy: InvoicePanelsDataSource,
    private readonly stamping: SimulateSalesStamping,
  ) {}

  async getPanel(id: number, key: InvoicePanelKey): Promise<InvoicePanelResult | null> {
    if (!isLocalSalesRemissionId(id)) {
      const panel = await this.legacy.getPanel(id, key);
      if (!panel || key !== 'auxiliary' || !/^FA\d/.test(panel.invoice.number)) return panel;
      const [cancellation] = await readHistoricalSalesRemissionCancellations({ invoiceIds: [id] });
      if (!cancellation) return panel;
      const { result, amount, number } = cancellation;
      const currentCredits = Number(panel.summary?.credits ?? 0);
      const currentBalance = Number(panel.summary?.balance ?? 0);
      return {
        ...panel, source: 'postgres', items: [...panel.items, {
          id: result.id, date: result.date, movementType: 'K', reference: number,
          charges: 0, credits: amount, amount: -amount, reason: result.reason,
        }],
        summary: { ...panel.summary, credits: Number((currentCredits + amount).toFixed(2)),
          balance: Number((currentBalance - amount).toFixed(2)) },
      };
    }
    const record = await readSalesRemissionInvoice(id);
    if (!record) return null;
    const { invoice, charge } = record;
    const base = { invoice: { id, number: invoice.number }, key, ...invoicePanelMetadata[key], readOnly: true };
    if (key === 'auxiliary') {
      const payments = await readCustomerCollections<(Record<string, unknown> & { id: number; date: string; charges: number; credits: number })[]>([], async (client) => {
        const hasReversals = await customerCollectionReversalsAvailable(client);
        const reversal = customerCollectionReversalSql(hasReversals);
        const scope = `FROM tuvansa.customer_collections collection ${reversal.join} WHERE collection.remission_id=$1 AND collection.company_id=1`;
        const { rows } = await client.query<Record<string, unknown> & { id: number; date: string; charges: number; credits: number }>(
          `SELECT collection.id::float8 AS id,collection.date::text,collection.movement_type AS "movementType",collection.number AS "collectionNumber",
                  coalesce(nullif(collection.reference,''),collection.number) AS reference,0 AS charges,collection.amount::float8 AS credits,
                  (-collection.amount)::float8 AS amount,collection.id::float8 AS "policyId",collection.policy_number AS "policyNumber",
                  ${reversal.reference} AS "collectionReversal",false AS "isCollectionReversal" ${scope}
           ${hasReversals ? `UNION ALL SELECT reversal.id::float8,reversal.date::text,'PA',reversal.number,concat('REV ',collection.policy_number),
                  collection.amount::float8,0,collection.amount::float8,reversal.id::float8,reversal.policy_number,NULL::jsonb,true
                  ${scope} AND reversal.id IS NOT NULL` : ''}
           ORDER BY date,id`, [id],
        );
        return rows;
      });
      const charges = charge > 0 ? [{
        id, date: invoice.dates.issuedAt, movementType: invoice.movementType, reference: invoice.orderNumber,
        charges: charge, credits: 0, amount: charge,
      }] : [];
      const cancellation = invoice.cancellation ? [{
        id: invoice.cancellation.id, date: invoice.cancellation.date, movementType: 'K', reference: invoice.number,
        charges: 0, credits: charge, amount: -charge, reason: invoice.cancellation.reason,
      }] : [];
      const items = [...charges, ...payments, ...cancellation].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.id - b.id);
      const credits = Number(items.reduce((total, item) => total + item.credits, 0).toFixed(2));
      const totalCharges = Number(items.reduce((total, item) => total + item.charges, 0).toFixed(2));
      return {
        ...base, available: true, source: 'postgres',
        items,
        summary: { charges: totalCharges, credits, balance: Number((totalCharges - credits).toFixed(2)) },
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
    if (key === 'lots') {
      const items = invoice.lines.flatMap(({ id, productCode, description, fulfilledQuantity, inventoryLayer }) => {
        if (!inventoryLayer) return [];
        const { id: layerId, ...fields } = inventoryLayer;
        return [{ ...fields, id, layerId, productCode, description, quantity: fulfilledQuantity }];
      });
      if (items.length) return {
        ...base, available: true, source: 'postgres', items,
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
