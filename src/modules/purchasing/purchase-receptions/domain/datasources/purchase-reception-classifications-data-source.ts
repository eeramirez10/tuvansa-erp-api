import type { PurchaseReceptionPanelResult } from '../repositories/purchase-receptions-repository.js';

export type PurchaseReceptionClassifier = {
  classifier: number;
  code: string;
  description: string;
  compositeCode: string;
};

export interface PurchaseReceptionClassificationPanel extends PurchaseReceptionPanelResult {
  key: 'classifications';
  items: PurchaseReceptionClassifier[];
  summary: {
    current: string[];
    labels: string[];
    revision: string;
    canWrite: boolean;
  };
}

export interface PurchaseReceptionClassificationUpdate {
  current: string[];
  revision: string;
}

export interface PurchaseReceptionClassificationsDataSource {
  save(id: number, update: PurchaseReceptionClassificationUpdate): Promise<PurchaseReceptionClassificationPanel>;
}
