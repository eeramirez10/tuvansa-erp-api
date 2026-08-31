import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PurchaseReceptionPanelKey, PurchaseReceptionsRepository } from '../../domain/repositories/purchase-receptions-repository.js';

export class GetPurchaseReceptionPanel {
  constructor(private readonly repository: PurchaseReceptionsRepository) {}
  async execute(id: number, key: PurchaseReceptionPanelKey) {
    const result = await this.repository.getPanel(id, key);
    if (result === null) throw new NotFoundError('Recepcion de compra');
    return { data: result };
  }
}
