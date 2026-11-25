import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { normalizeOrderWarehouse } from '../../../orders/domain/entities/order-warehouse.js';
import type {
  InvoiceFromOrderInput, InvoiceFromOrderReferences, InvoiceFromOrderStorage,
} from '../../domain/datasources/invoice-from-order-data-source.js';
import { invoiceOrderLines, invoiceOrderReason, postInvoiceFromOrder } from '../../domain/entities/invoice-from-order.js';

const mexicoDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });

export class CreateInvoiceFromOrder {
  constructor(
    private readonly storage: InvoiceFromOrderStorage,
    private readonly references: InvoiceFromOrderReferences,
  ) {}

  private writable() {
    if (!this.storage.writable()) {
      throw new ApplicationError('La remisión de pedidos requiere PostgreSQL.', 'SALES_REMISSION_POSTGRES_UNAVAILABLE', 503);
    }
  }

  private async source(number: string) {
    const current = await this.storage.order(number);
    if (!current) throw new NotFoundError('Pedido local para remisión');
    return current;
  }

  async prepare(companyId: number, orderNumber: string) {
    this.writable();
    const { order, revision } = await this.source(orderNumber);
    let reason = invoiceOrderReason(order);
    let lines: ReturnType<typeof invoiceOrderLines> = [];
    let fiscalStart: string | null = null;
    let fiscalEnd: string | null = null;
    if (!reason) {
      const context = await this.references.context(companyId, order);
      fiscalStart = context.fiscalStart || null;
      fiscalEnd = context.fiscalEnd || null;
      lines = context.reason ? [] : invoiceOrderLines(order, context);
      reason = context.reason ?? (lines.length ? null : 'No hay partidas asignadas en su unidad base para la remisión estándar.');
    }
    const today = mexicoDate.format(new Date());
    return {
      orderId: order.id, number: order.number, customer: order.customer,
      warehouse: normalizeOrderWarehouse(order.warehouse), revision, canWrite: reason === null, reason,
      fiscalStart, fiscalEnd,
      defaults: { issuedAt: fiscalStart && fiscalEnd && today >= fiscalStart && today <= fiscalEnd ? today : null }, lines,
    };
  }

  async save(companyId: number, userId: number, raw: InvoiceFromOrderInput) {
    this.writable();
    const input = {
      ...raw,
      requestKey: raw.requestKey.toLowerCase(),
      lines: [...raw.lines].sort((a, b) => a.orderLineId - b.orderLineId),
    };
    const fingerprint = createHash('sha256').update(JSON.stringify({
      companyId, userId, orderNumber: input.orderNumber, revision: input.revision, issuedAt: input.issuedAt,
      lines: input.lines.map(({ orderLineId, quantity }) => ({ orderLineId, quantity })),
    })).digest('hex');
    const previous = await this.storage.findRequest(companyId, input.requestKey, fingerprint);
    if (previous) return previous;
    const { order } = await this.source(input.orderNumber);
    return this.storage.commit({
      companyId, userId, requestKey: input.requestKey, fingerprint,
      orderId: order.id, orderNumber: order.number, revision: input.revision,
      post: async (current, localReceivableBalance = 0) => {
        const context = await this.references.context(companyId, current);
        return postInvoiceFromOrder(current, context, input, companyId, userId, localReceivableBalance);
      },
    });
  }
}
