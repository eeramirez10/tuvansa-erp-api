import type { PurchaseOrderEditSnapshot } from './purchase-order-edit-data-source.js';
import type { PurchaseOrderIdentity } from '../repositories/purchase-orders-repository.js';

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

export interface PurchaseOrderPiecesStorage {
  listPieceOverrides(order: PurchaseOrderIdentity): Promise<Array<{ productCode: string; items: PurchaseOrderPiece[] }>>;
  savePieces(snapshot: PurchaseOrderEditSnapshot, productCode: string, items: PurchaseOrderPiece[]): Promise<void>;
}

export function readPurchaseOrderPieces(items: Array<Record<string, unknown>>): PurchaseOrderPiece[] {
  return items.map((row) => ({
    id: Number(row.id), productCode: String(row.productCode ?? ''), serial: String(row.serial ?? ''),
    pieces: Number(row.pieces), quantity: Number(row.quantity), warehouse: String(row.warehouse ?? ''),
    document: String(row.document ?? ''), receipt: String(row.receipt ?? ''),
  }));
}
