import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  PurchaseOrderAuthorizationAccess, PurchaseOrderAuthorizationInput, PurchaseOrderAuthorizationStorage,
} from '../../domain/datasources/purchase-order-authorization-data-source.js';
import type { PurchaseOrderCreateStorage } from '../../domain/datasources/purchase-order-create-data-source.js';
import type {
  PurchaseOrderSupplierChangeCatalog, PurchaseOrderSupplierChangeInput, PurchaseOrderSupplierChangeMode,
  PurchaseOrderSupplierChangeStorage, PurchaseOrderSupplierFilters,
} from '../../domain/datasources/purchase-order-supplier-change-data-source.js';
import type { PurchaseOrderEditLegacyDataSource, PurchaseOrderEditStorage } from '../../domain/datasources/purchase-order-edit-data-source.js';
import type { PurchaseOrderClassificationStorage } from '../../domain/datasources/purchase-orders-data-source.js';
import { purchaseOrderAuthorizationLevels, purchaseOrderAuthorizationTransition } from '../../domain/entities/purchase-order-authorization.js';
import type { PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';
import { loadPurchaseOrderWriteContext } from './load-purchase-order-write-context.js';

export class AuthorizePurchaseOrder {
  constructor(
    private readonly legacy: PurchaseOrderEditLegacyDataSource & PurchaseOrderSupplierChangeCatalog,
    private readonly storage: PurchaseOrderEditStorage & PurchaseOrderAuthorizationStorage & PurchaseOrderSupplierChangeStorage,
    private readonly creation: PurchaseOrderCreateStorage,
    private readonly classifications: Pick<PurchaseOrderClassificationStorage, 'find'>,
    private readonly orders: PurchaseOrdersRepository,
    private readonly access: PurchaseOrderAuthorizationAccess,
  ) {}

  private async context(id: number) {
    const [order, classifications, supplierChanges] = await Promise.all([
      loadPurchaseOrderWriteContext(id, this.legacy, this.storage, this.creation),
      this.classifications.find([id]),
      this.storage.findSupplierChanges([id]),
    ]);
    const { base, documentKind, rules, stored, version } = order;
    const classification = classifications.find(({ number }) => number === base.number);
    const status = (classification?.current ?? base.classifications)[8] ?? '';
    const sourceReason = rules.companyId !== rules.activeCompanyId ? 'La orden pertenece a otra compañía.'
      : stored && stored.legacyVersion !== version ? 'La orden de origen cambió después de la edición en PostgreSQL.' : '';
    const supplierChange = supplierChanges.find(({ number }) => number === base.number);
    return {
      base, documentKind, version, status, sourceReason, supplier: supplierChange?.supplier ?? base.supplier,
      supplierRevision: supplierChange?.revision ?? 0, revision: stored?.revision ?? 0, classificationRevision: classification?.revision ?? 0,
    };
  }

  private authorizationReason({ documentKind, sourceReason }: Awaited<ReturnType<AuthorizePurchaseOrder['context']>>) {
    if (documentKind !== 'order') return 'La autorización está disponible para órdenes de compra.';
    return sourceReason || (!this.storage.writable() ? 'La autorización de órdenes requiere PostgreSQL.' : '');
  }

  private supplierReason(context: Awaited<ReturnType<AuthorizePurchaseOrder['context']>>, mode: PurchaseOrderSupplierChangeMode) {
    if (mode === 'authorization') {
      const reason = this.authorizationReason(context);
      if (reason) return reason;
      if (context.status !== '9A') return 'Solo se puede cambiar proveedores del status A.';
      if (context.supplier.code !== 'COMPRA') return 'El proveedor no es COMPRA.';
    }
    if (context.sourceReason) return context.sourceReason;
    if (!this.storage.writable()) return 'El cambio de proveedor requiere PostgreSQL.';
    return this.access.supplierChangeEnabled(mode) ? '' : 'No hay usuarios configurados para cambiar proveedor.';
  }

  async get(id: number) {
    const context = await this.context(id);
    const { base, version, status, supplier, supplierRevision, revision, classificationRevision } = context;
    const reason = this.authorizationReason(context) || (!this.access.enabled() ? 'No hay autorizadores configurados para órdenes de compra.' : '');
    const supplierReason = this.supplierReason(context, 'authorization');
    const levels = this.access.levels();
    return {
      id, number: base.number, status, revision, classificationRevision, legacyVersion: version, canWrite: !reason, reason,
      supplierChange: { canWrite: !supplierReason, reason: supplierReason, supplier, supplierRevision },
      options: purchaseOrderAuthorizationLevels.map((level) => ({
        level,
        canApprove: !reason && levels.includes(level) && purchaseOrderAuthorizationTransition(status, level, 'approve') !== null,
        canRevoke: !reason && levels.includes(level) && purchaseOrderAuthorizationTransition(status, level, 'revoke') !== null,
      })),
    };
  }

  async execute(id: number, input: PurchaseOrderAuthorizationInput, key: string | undefined) {
    const context = await this.context(id);
    const { base, version, status, revision, classificationRevision } = context;
    const reason = this.authorizationReason(context) || (!this.access.enabled() ? 'No hay autorizadores configurados para órdenes de compra.' : '');
    if (reason) throw new ApplicationError(reason, 'PURCHASE_ORDER_AUTHORIZATION_NOT_AVAILABLE', this.storage.writable() && this.access.enabled() ? 409 : 503);
    const actor = await this.access.verify(key, input.level);
    if (version !== input.legacyVersion || status !== input.status || revision !== input.revision || classificationRevision !== input.classificationRevision) {
      throw new ConflictError('La orden cambió. Vuelve a abrir Autorizar.', 'PURCHASE_ORDER_AUTHORIZATION_STALE');
    }
    const next = purchaseOrderAuthorizationTransition(status, input.level, input.direction);
    if (next === null) throw new ConflictError('El estado actual de la orden no permite este cambio.', 'PURCHASE_ORDER_AUTHORIZATION_TRANSITION');

    await this.storage.saveAuthorization({ id, number: base.number }, base.classifications, input, next, actor);
    const order = await this.orders.findById(id);
    if (!order) throw new NotFoundError('Orden de compra');
    return order.toPrimitives();
  }

  async searchSuppliers(filters: PurchaseOrderSupplierFilters) {
    return (await this.legacy.changeSuppliers(filters)).map(({ supplier }) => supplier);
  }

  async getSupplierAction(id: number) {
    const context = await this.context(id);
    const { base, version, supplier, supplierRevision, revision, classificationRevision } = context;
    const reason = this.supplierReason(context, 'action');
    return { id, number: base.number, revision, classificationRevision, supplierRevision, legacyVersion: version, supplier, canWrite: !reason, reason };
  }

  async changeSupplier(id: number, input: PurchaseOrderSupplierChangeInput, key: string | undefined, mode: PurchaseOrderSupplierChangeMode) {
    const actor = await this.access.verify(key, mode === 'action' ? 'supplier-change-action' : 'supplier-change');
    const context = await this.context(id);
    const { base, version, supplier, supplierRevision, revision, classificationRevision } = context;
    if (version !== input.legacyVersion || revision !== input.revision || classificationRevision !== input.classificationRevision ||
      supplierRevision !== input.supplierRevision) {
      throw new ConflictError('La orden cambió. Vuelve a abrir Cambia proveedor.', 'PURCHASE_ORDER_SUPPLIER_STALE');
    }
    const reason = this.supplierReason(context, mode);
    if (reason) throw new ConflictError(reason, 'PURCHASE_ORDER_SUPPLIER_CHANGE_NOT_ALLOWED');
    const [choice] = await this.legacy.changeSuppliers({ code: input.supplierCode }, true);
    if (!choice) throw new NotFoundError('Proveedor');
    if (mode === 'authorization' && (choice.supplier.id === supplier.id || choice.supplier.code === 'COMPRA')) {
      throw new ConflictError('Selecciona un proveedor distinto de COMPRA.', 'PURCHASE_ORDER_SUPPLIER_UNCHANGED');
    }
    await this.storage.saveSupplierChange({ id, number: base.number }, base.classifications[8] ?? '', supplier.id ?? 0, input, choice, actor, mode);
    const order = await this.orders.findById(id);
    if (!order) throw new NotFoundError('Orden de compra');
    return order.toPrimitives();
  }
}
