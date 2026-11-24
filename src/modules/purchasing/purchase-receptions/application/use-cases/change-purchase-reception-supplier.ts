import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  PurchaseReceptionSupplierChangeDataSource, ReceiptSupplierSearch,
} from '../../domain/datasources/purchase-reception-supplier-change-data-source.js';

export class ChangePurchaseReceptionSupplier {
  constructor(private readonly data: PurchaseReceptionSupplierChangeDataSource) {}

  async preview(companyId: number, receiptId: number) {
    const state = await this.data.preview(companyId, receiptId);
    if (!state) throw new NotFoundError('Recepción de compra');
    return state;
  }

  search(companyId: number, receiptId: number, filters: ReceiptSupplierSearch) {
    return this.data.search(companyId, receiptId, filters);
  }

  save(companyId: number, receiptId: number, input: { revision: string; supplierCode: string }) {
    return this.data.save(companyId, receiptId, input);
  }
}
