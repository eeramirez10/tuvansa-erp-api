import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PurchaseReceptionCommentsDataSource, PurchaseReceptionCommentsInput } from '../../domain/datasources/purchase-reception-comments-data-source.js';

export class ManagePurchaseReceptionComments {
  constructor(private readonly storage: PurchaseReceptionCommentsDataSource) {}

  async get(companyId: number, receiptId: number) {
    const data = await this.storage.read(companyId, receiptId);
    if (!data) throw new NotFoundError('Recepción de compra');
    return data;
  }

  save(companyId: number, receiptId: number, input: PurchaseReceptionCommentsInput) {
    return this.storage.save(companyId, receiptId, input);
  }
}
