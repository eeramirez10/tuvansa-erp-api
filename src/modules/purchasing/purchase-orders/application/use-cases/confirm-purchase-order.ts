import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PurchaseOrderConfirmationInput, PurchaseOrderConfirmationStorage } from '../../domain/datasources/purchase-order-confirmation-data-source.js';
import type { PurchaseOrderCreateStorage } from '../../domain/datasources/purchase-order-create-data-source.js';
import type { PurchaseOrderEditLegacyDataSource, PurchaseOrderEditStorage } from '../../domain/datasources/purchase-order-edit-data-source.js';
import { assignPurchaseOrderLines } from '../../domain/entities/purchase-order-confirmation.js';
import type { PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';
import { loadPurchaseOrderWriteContext } from './load-purchase-order-write-context.js';

export class ConfirmPurchaseOrder {
  constructor(
    private readonly legacy: PurchaseOrderEditLegacyDataSource,
    private readonly storage: PurchaseOrderEditStorage & PurchaseOrderConfirmationStorage,
    private readonly creation: PurchaseOrderCreateStorage,
    private readonly orders: PurchaseOrdersRepository,
  ) {}

  private async context(id: number) {
    const context = await loadPurchaseOrderWriteContext(id, this.legacy, this.storage, this.creation);
    const { documentKind, rules, stored, version } = context;
    let reason = '';
    if (documentKind !== 'order') reason = 'La confirmación sólo está disponible para órdenes de compra.';
    else if (rules.companyId !== rules.activeCompanyId) reason = 'La orden pertenece a otra compañía.';
    else if (stored && stored.legacyVersion !== version) reason = 'La orden de origen cambió después de la edición en PostgreSQL.';
    else if (!this.storage.writable()) reason = 'La confirmación de órdenes requiere PostgreSQL.';
    return { ...context, reason };
  }

  async get(id: number) {
    const { base, stored, version, reason, lines } = await this.context(id);
    return {
      id, number: base.number, revision: stored?.revision ?? 0, legacyVersion: version, canWrite: reason === '', reason,
      hasAssignments: lines.some((line) => line.assigned !== 0),
    };
  }

  async execute(id: number, input: PurchaseOrderConfirmationInput) {
    const { base, stored, version, lines, reason } = await this.context(id);
    const revision = stored?.revision ?? 0;
    if (input.revision !== revision || input.legacyVersion !== version) {
      throw new ConflictError('La orden cambió. Vuelve a abrir la confirmación.', 'PURCHASE_ORDER_CONFIRMATION_STALE');
    }
    if (reason) throw new ApplicationError(reason, 'PURCHASE_ORDER_CONFIRMATION_NOT_ALLOWED', this.storage.writable() ? 409 : 503);
    const update = assignPurchaseOrderLines(lines, base.lines, input.mode);
    if (update) {
      const totals = { ...(stored?.totals ?? base.totals), assigned: update.assigned };
      await this.storage.saveConfirmation({
        id, number: base.number, revision, legacyVersion: version, lines: update.lines, totals,
        amountInWords: stored?.amountInWords ?? null,
      }, update.stock, base.classifications, update.marker);
    }
    const order = await this.orders.findById(id);
    if (!order) throw new NotFoundError('Orden de compra');
    return order.toPrimitives();
  }
}
