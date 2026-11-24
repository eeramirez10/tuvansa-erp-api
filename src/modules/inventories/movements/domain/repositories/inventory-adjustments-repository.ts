import type { MovementDocument } from '../entities/inventory-movement.js';

export type InventoryAdjustmentType = 'EI' | 'SI' | 'TR';

export interface InventoryAdjustmentInput {
  requestKey: string;
  type: InventoryAdjustmentType;
  date: string;
  warehouse: string;
  destinationWarehouse?: string;
  document?: string;
  reference?: string;
  lines: { productId: number; quantity: number; cost?: number }[];
}

export interface InventoryAdjustmentCapture {
  writable: boolean;
  reason: string | null;
  automaticPeps?: boolean;
  defaultDate: string;
  defaultWarehouse: string;
  types: { code: InventoryAdjustmentType; name: string; sign: -1 | 0 | 1 }[];
  warehouses: { code: string; name: string }[];
}

export interface InventoryAdjustmentsRepository {
  capture(): Promise<InventoryAdjustmentCapture>;
  create(input: InventoryAdjustmentInput): Promise<MovementDocument>;
}
