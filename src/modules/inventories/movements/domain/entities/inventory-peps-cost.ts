export interface InventoryPepsCost {
  average: number;
  last: number;
  adValorem: number;
}

export interface InventoryPepsCostBasis extends InventoryPepsCost {
  openingStock: number;
}
