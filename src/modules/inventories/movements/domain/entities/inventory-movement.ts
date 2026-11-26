export interface MovementHeader {
  id: number;
  document: string;
  date: string;
  reference: string;
  reference2: string;
  warehouse: string;
  supplierCode: string;
  customerCode: string;
  customerName: string;
  type: string;
  status: number;
  company: number;
  userId: number;
  inventoryFlag: number;
  billingFlag: number;
}

export interface MovementLine {
  id: number;
  productId: number;
  productCode: string;
  description: string;
  quantity: number;
  unit: string;
  cost: number;
  price?: number;
  invoicedQuantity?: number;
  pieces: number;
  piecesText: string;
  warehouse: string;
  type: string;
  lotId: number;
  customsEntry?: string;
  lotWarehouse?: string;
  userId: number;
}

export interface MovementDocument {
  header: MovementHeader;
  lines: MovementLine[];
  totals: { quantity: number; cost: number };
  invoiceTransfer?: { sourceId: number; subtotal: number; tax: number; total: number };
  comment?: string;
}
