import type { MovementHeader } from '../entities/inventory-movement.js';

export interface MovementPrintSettings {
  format: string;
  adHoc: boolean;
  companyName: string;
  place: string;
  warehouseName: string;
}

export interface MovementPrintCustoms {
  entry: string;
  date: string | null;
  office: string;
}

export interface InventoryMovementPrintReferences {
  settings(header: MovementHeader): Promise<MovementPrintSettings | null>;
  customsByLot(ids: number[]): Promise<Map<number, MovementPrintCustoms>>;
}
