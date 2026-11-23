import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { isPurchaseOrderAuthorizationStatus } from '../../domain/entities/purchase-order-authorization.js';
import type {
  PurchaseOrderClassificationUpdate, PurchaseOrdersRepository,
} from '../../domain/repositories/purchase-orders-repository.js';

export class UpdatePurchaseOrderClassifications {
  constructor(private readonly repository: PurchaseOrdersRepository) {}

  async execute(id: number, update: PurchaseOrderClassificationUpdate) {
    const panel = await this.repository.getClassifications(id);
    if (!panel) throw new NotFoundError('Orden de compra');
    if (!panel.summary.canWrite) {
      throw new ApplicationError('La clasificación requiere PostgreSQL.', 'POSTGRES_NOT_CONFIGURED', 503);
    }
    if (panel.summary.revision !== update.revision) {
      throw new ConflictError('Otra sesión cambió la clasificación. Vuelve a abrir la ventana.', 'PURCHASE_ORDER_CLASSIFICATIONS_STALE');
    }
    for (const [index, value] of update.current.entries()) {
      const previous = panel.summary.current[index] ?? '';
      if (index === 8 && value !== previous && (isPurchaseOrderAuthorizationStatus(value) || isPurchaseOrderAuthorizationStatus(previous))) {
        throw new ApplicationError('Usa Autorizar para cambiar el nivel de autorización de la orden.', 'PURCHASE_ORDER_AUTHORIZATION_MANAGED', 422);
      }
      if (value === '' || value === panel.summary.current[index]) continue;
      if (!panel.items.some((option) => option.classifier === index + 1 && option.compositeCode === value)) {
        throw new ApplicationError(`La opción no pertenece al clasificador ${index + 1}.`, 'INVALID_PURCHASE_ORDER_CLASSIFIER', 422);
      }
    }
    if (update.current.every((value, index) => value === panel.summary.current[index])) return { data: panel };

    const saved = await this.repository.saveClassifications(panel.purchaseOrder, update);
    return {
      data: {
        ...panel,
        source: 'mysql+postgres' as const,
        summary: { ...panel.summary, current: saved.current, revision: saved.revision },
      },
    };
  }
}
