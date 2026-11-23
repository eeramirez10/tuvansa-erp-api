import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PurchaseOrderCreateStorage } from '../../domain/datasources/purchase-order-create-data-source.js';
import type { PurchaseOrderEditLegacyDataSource, PurchaseOrderEditStorage } from '../../domain/datasources/purchase-order-edit-data-source.js';
import type { PurchaseOrderRemovalStorage, PurchaseOrderRemoveInput } from '../../domain/datasources/purchase-order-removal-data-source.js';
import { stockAfterPurchaseOrderRemoval } from '../../domain/entities/purchase-order-edit.js';
import type { PurchaseOrderIdentity, PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';
import { loadPurchaseOrderWriteContext } from './load-purchase-order-write-context.js';

export class RemovePurchaseOrder {
  constructor(
    private readonly legacy: PurchaseOrderEditLegacyDataSource,
    private readonly storage: PurchaseOrderEditStorage & PurchaseOrderRemovalStorage,
    private readonly creation: PurchaseOrderCreateStorage,
    private readonly orders: PurchaseOrdersRepository,
  ) {}

  private async context(id: number) {
    const context = await loadPurchaseOrderWriteContext(id, this.legacy, this.storage, this.creation);
    const { base, rules, stored, lines, version } = context;
    let reason = '';
    if (base.documentKind !== 'order') reason = 'La baja sólo está disponible para órdenes de compra.';
    else if (rules.companyId !== rules.activeCompanyId) reason = 'La orden pertenece a otra compañía.';
    else if (stored && stored.legacyVersion !== version) {
      reason = 'La orden de origen cambió después de la edición en PostgreSQL.';
    } else if (lines.some((line) => line.assigned !== 0)) {
      reason = 'El pedido tiene partidas confirmadas. Desconfírmalas antes de darlo de baja.';
    } else if (!this.storage.writable()) reason = 'La baja de órdenes requiere PostgreSQL.';
    return { ...context, reason };
  }

  async get(id: number) {
    const { base, stored, version, reason } = await this.context(id);
    return {
      id, number: base.number, supplier: base.supplier, revision: stored?.revision ?? 0, legacyVersion: version,
      canRemove: reason === '', reason,
    };
  }

  async execute(id: number, input: PurchaseOrderRemoveInput) {
    const identity = { id, number: input.number };
    const context = await this.context(id).catch(async (error: unknown) => {
      if (error instanceof NotFoundError && (await this.storage.findRemoved([id])).some(({ number }) => number === input.number)) return null;
      throw error;
    });
    if (!context) return this.result(identity);
    const { base, stored, version, reason } = context;
    if (input.number !== base.number || input.revision !== (stored?.revision ?? 0) || input.legacyVersion !== version) {
      throw new ConflictError('La orden cambió. Vuelve a abrir la baja y revisa sus datos.', 'PURCHASE_ORDER_REMOVAL_STALE');
    }
    if (reason) throw new ApplicationError(reason, 'PURCHASE_ORDER_REMOVAL_NOT_ALLOWED', this.storage.writable() ? 409 : 503);
    const snapshot = stored ?? { ...identity, revision: 0, legacyVersion: version, lines: base.lines, totals: base.totals, amountInWords: '' };
    await this.storage.remove(snapshot, stockAfterPurchaseOrderRemoval(base.lines));
    return this.result(identity);
  }

  private async result(identity: PurchaseOrderIdentity) {
    const replacement = await this.orders.findAdjacent(identity.id, 'next') ?? await this.orders.findAdjacent(identity.id, 'previous');
    return { ...identity, replacement: replacement?.toPrimitives() ?? null };
  }
}
