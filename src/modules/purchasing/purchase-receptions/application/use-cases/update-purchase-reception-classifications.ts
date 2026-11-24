import type {
  PurchaseReceptionClassificationsDataSource, PurchaseReceptionClassificationUpdate,
} from '../../domain/datasources/purchase-reception-classifications-data-source.js';

export class UpdatePurchaseReceptionClassifications {
  constructor(private readonly storage: PurchaseReceptionClassificationsDataSource) {}

  execute(id: number, update: PurchaseReceptionClassificationUpdate) {
    return this.storage.save(id, update);
  }
}
