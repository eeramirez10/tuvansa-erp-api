import type { PurchaseOrderEditSnapshot, PurchaseOrderStockChange } from './purchase-order-edit-data-source.js';

export type PurchaseOrderBranchTransferMode = 'divide' | 'percentage';

export type PurchaseOrderBranchTransferInput = Pick<PurchaseOrderEditSnapshot, 'revision' | 'legacyVersion'> & {
  requestKey: string;
  mode: PurchaseOrderBranchTransferMode;
  sourceLineId: number;
  destinationNumber: string;
  destinationRevision: number;
  destinationLegacyVersion: string;
  quantity: number;
  destinationBranch: number;
};

export type PurchaseOrderBranchTransferIdentity = { sourceId: number; destinationId: number };

export interface PurchaseOrderBranchTransferStorage {
  findBranchTransferRequest(requestKey: string, fingerprint: string): Promise<PurchaseOrderBranchTransferIdentity | null>;
  /** A null sourceStock keeps the source snapshot as a revision guard without writing it separately. */
  saveBranchTransfer(
    requestKey: string,
    fingerprint: string,
    source: PurchaseOrderEditSnapshot,
    sourceStock: PurchaseOrderStockChange[] | null,
    destination: PurchaseOrderEditSnapshot,
    destinationStock: PurchaseOrderStockChange[],
  ): Promise<void>;
}
