export interface InventoryPepsCost {
  average: number;
  last: number;
  adValorem: number;
}

export interface InventoryPepsCostBasis extends InventoryPepsCost {
  openingStock: number;
}

export interface InventoryPepsCustoms {
  customsEntry: string;
  customsOffice: string;
  date: string | null;
}
