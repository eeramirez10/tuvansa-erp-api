import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PurchaseOrderConversionInput, PurchaseOrderConversionStorage } from '../../domain/datasources/purchase-order-conversion-data-source.js';
import type { PurchaseOrderCreateStorage } from '../../domain/datasources/purchase-order-create-data-source.js';
import type { PurchaseOrderEditLegacyDataSource, PurchaseOrderEditStorage } from '../../domain/datasources/purchase-order-edit-data-source.js';
import { purchaseOrderStockDifference } from '../../domain/entities/purchase-order-edit.js';
import type { PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';
import { loadPurchaseOrderWriteContext } from './load-purchase-order-write-context.js';

export class ConvertPurchaseOrder {
  constructor(
    private readonly legacy: PurchaseOrderEditLegacyDataSource,
    private readonly storage: PurchaseOrderEditStorage & PurchaseOrderConversionStorage,
    private readonly creation: PurchaseOrderCreateStorage,
    private readonly orders: PurchaseOrdersRepository,
  ) {}

  private async context(id: number) {
    const context = await loadPurchaseOrderWriteContext(id, this.legacy, this.storage, this.creation);
    const { documentKind, rules, stored, version } = context;
    let reason = '';
    if (documentKind === 'unknown') reason = 'El documento no es un pedido ni una cotización.';
    else if (rules.companyId !== rules.activeCompanyId) reason = 'El documento pertenece a otra compañía.';
    else if (stored && stored.legacyVersion !== version) reason = 'El documento de origen cambió.';
    else if (!this.storage.writable()) reason = 'Cotiz requiere PostgreSQL.';
    return { ...context, reason };
  }

  async get(id: number) {
    const { base, stored, version, documentKind, reason } = await this.context(id);
    return {
      id, number: base.number, revision: stored?.revision ?? 0, legacyVersion: version,
      documentKind, canWrite: !reason, reason,
    };
  }

  async execute(id: number, input: PurchaseOrderConversionInput) {
    const { base, stored, version, documentKind, lines, reason } = await this.context(id);
    if (reason) {
      throw new ApplicationError(reason, 'PURCHASE_ORDER_CONVERSION_NOT_ALLOWED', this.storage.writable() ? 409 : 503);
    }
    if (documentKind !== input.target) {
      if (input.revision !== (stored?.revision ?? 0) || input.legacyVersion !== version) {
        throw new ConflictError('El documento cambió. Vuelve a abrir Cotiz.', 'PURCHASE_ORDER_CONVERSION_STALE');
      }
      await this.storage.saveConversion({
        id, number: base.number, revision: input.revision, legacyVersion: version,
        lines, totals: stored?.totals ?? base.totals, amountInWords: stored?.amountInWords ?? null,
        documentKind: input.target,
      }, purchaseOrderStockDifference(base, lines, input.target));
    }
    const updated = await this.orders.findById(id);
    if (!updated) throw new NotFoundError('Orden de compra');
    return updated.toPrimitives();
  }
}
