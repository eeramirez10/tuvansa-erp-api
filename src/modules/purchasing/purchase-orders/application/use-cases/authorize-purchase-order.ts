import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  PurchaseOrderAuthorizationAccess, PurchaseOrderAuthorizationInput, PurchaseOrderAuthorizationStorage,
} from '../../domain/datasources/purchase-order-authorization-data-source.js';
import type { PurchaseOrderCreateStorage } from '../../domain/datasources/purchase-order-create-data-source.js';
import type {
  PurchaseOrderSupplierChangeCatalog, PurchaseOrderSupplierChangeInput, PurchaseOrderSupplierChangeStorage, PurchaseOrderSupplierFilters,
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
    const { base, rules, stored, version } = order;
    const classification = classifications.find(({ number }) => number === base.number);
    const status = (classification?.current ?? base.classifications)[8] ?? '';
    let reason = '';
    if (base.documentKind !== 'order') reason = 'La autorización está disponible para órdenes de compra.';
    else if (rules.companyId !== rules.activeCompanyId) reason = 'La orden pertenece a otra compañía.';
    else if (stored && stored.legacyVersion !== version) reason = 'La orden de origen cambió después de la edición en PostgreSQL.';
    else if (!this.storage.writable()) reason = 'La autorización de órdenes requiere PostgreSQL.';
    const supplier = supplierChanges.find(({ number }) => number === base.number)?.supplier ?? base.supplier;
    const supplierReason = reason || (status !== '9A' ? 'Solo se puede cambiar proveedores del status A.'
      : supplier.code !== 'COMPRA' ? 'El proveedor no es COMPRA.'
      : !this.access.supplierChangeEnabled() ? 'No hay usuarios configurados para cambiar proveedor.' : '');
    return { base, version, status, reason, supplier, supplierReason, revision: stored?.revision ?? 0, classificationRevision: classification?.revision ?? 0 };
  }

  async get(id: number) {
    const { base, version, status, reason: orderReason, supplier, supplierReason, revision, classificationRevision } = await this.context(id);
    const reason = orderReason || (!this.access.enabled() ? 'No hay autorizadores configurados para órdenes de compra.' : '');
    const levels = this.access.levels();
    return {
      id, number: base.number, status, revision, classificationRevision, legacyVersion: version, canWrite: !reason, reason,
      supplierChange: { canWrite: !supplierReason, reason: supplierReason, supplier },
      options: purchaseOrderAuthorizationLevels.map((level) => ({
        level,
        canApprove: !reason && levels.includes(level) && purchaseOrderAuthorizationTransition(status, level, 'approve') !== null,
        canRevoke: !reason && levels.includes(level) && purchaseOrderAuthorizationTransition(status, level, 'revoke') !== null,
      })),
    };
  }

  async execute(id: number, input: PurchaseOrderAuthorizationInput, key: string | undefined) {
    const { base, version, status, reason: orderReason, revision, classificationRevision } = await this.context(id);
    const reason = orderReason || (!this.access.enabled() ? 'No hay autorizadores configurados para órdenes de compra.' : '');
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

  async changeSupplier(id: number, input: PurchaseOrderSupplierChangeInput, key: string | undefined) {
    const actor = await this.access.verify(key, 'supplier-change');
    const { base, version, supplier, supplierReason, revision, classificationRevision } = await this.context(id);
    if (version !== input.legacyVersion || revision !== input.revision || classificationRevision !== input.classificationRevision) {
      throw new ConflictError('La orden cambió. Vuelve a abrir Cambia proveedor.', 'PURCHASE_ORDER_SUPPLIER_STALE');
    }
    if (supplierReason) throw new ConflictError(supplierReason, 'PURCHASE_ORDER_SUPPLIER_CHANGE_NOT_ALLOWED');
    const [choice] = await this.legacy.changeSuppliers({ code: input.supplierCode }, true);
    if (!choice) throw new NotFoundError('Proveedor');
    if (choice.supplier.id === supplier.id || choice.supplier.code === 'COMPRA') {
      throw new ConflictError('Selecciona un proveedor distinto de COMPRA.', 'PURCHASE_ORDER_SUPPLIER_UNCHANGED');
    }
    await this.storage.saveSupplierChange({ id, number: base.number }, base.classifications[8] ?? '', supplier.id, input, choice, actor);
    const order = await this.orders.findById(id);
    if (!order) throw new NotFoundError('Orden de compra');
    return order.toPrimitives();
  }
}
