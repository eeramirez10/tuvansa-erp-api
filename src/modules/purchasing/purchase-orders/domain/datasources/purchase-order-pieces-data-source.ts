import type { PurchaseOrderEditSnapshot } from './purchase-order-edit-data-source.js';
import type { PurchaseOrderIdentity } from '../repositories/purchase-orders-repository.js';

export const purchaseOrderPieceIdStart = 6600000000000;

export interface PurchaseOrderPiece {
  id: number;
  productCode: string;
  serial: string;
  pieces: number;
  quantity: number;
  warehouse: string;
  document: string;
  receipt: string;
}

export type PurchaseOrderPieceChange = { id: number | null; serial: string; quantity: number };

export type PurchaseOrderPiecesInput = Pick<PurchaseOrderEditSnapshot, 'revision' | 'legacyVersion'> & {
  productCode: string;
  entries: PurchaseOrderPieceChange[];
};

export type PurchaseOrderPieceImportInput = Pick<PurchaseOrderEditSnapshot, 'revision' | 'legacyVersion'> & {
  entries: Array<Pick<PurchaseOrderPiece, 'productCode' | 'serial' | 'quantity'>>;
};

export type PurchaseOrderPieceGroup = { productCode: string; items: PurchaseOrderPiece[] };

export interface PurchaseOrderPiecesStorage {
  listPieceOverrides(order: PurchaseOrderIdentity): Promise<PurchaseOrderPieceGroup[]>;
  savePieces(snapshot: PurchaseOrderEditSnapshot, products: PurchaseOrderPieceGroup[]): Promise<void>;
}

export function readPurchaseOrderPieces(items: Array<Record<string, unknown>>): PurchaseOrderPiece[] {
  return items.map((row) => ({
    id: Number(row.id), productCode: String(row.productCode ?? ''), serial: String(row.serial ?? ''),
    pieces: Number(row.pieces), quantity: Number(row.quantity), warehouse: String(row.warehouse ?? ''),
    document: String(row.document ?? ''), receipt: String(row.receipt ?? ''),
  }));
}
