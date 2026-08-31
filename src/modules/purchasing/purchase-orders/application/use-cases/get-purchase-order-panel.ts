import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PurchaseOrderPanelKey, PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';

export class GetPurchaseOrderPanel {
  constructor(private readonly repository: PurchaseOrdersRepository) {}
  async execute(id: number, key: PurchaseOrderPanelKey) {
    const result = await this.repository.getPanel(id, key);
    if (result === null) throw new NotFoundError('Orden de compra');
    return { data: result };
  }
}
