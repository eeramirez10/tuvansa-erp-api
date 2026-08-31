import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PurchaseReceptionsRepository } from '../../domain/repositories/purchase-receptions-repository.js';
import { toPurchaseReceptionResponse } from '../dtos/purchase-reception-response.js';

export class GetPurchaseReceptionByNumber {
  constructor(private readonly repository: PurchaseReceptionsRepository) {}
  async execute(number: string) {
    const result = await this.repository.findByNumber(number);
    if (result === null) throw new NotFoundError('Recepcion de compra');
    return toPurchaseReceptionResponse(result);
  }
}
