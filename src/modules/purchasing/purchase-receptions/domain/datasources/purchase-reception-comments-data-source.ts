export type PurchaseReceptionCommentLines = [string, string, string, string, string];

export interface PurchaseReceptionCommentsFields {
  dueAt: string | null;
  supplierReference: string;
  department: string;
  orderNumber: string;
  transportCode: string;
  processDate: string | null;
  otherLabel: string;
  boxes: number;
  volume: number;
  folio: string;
  folioAt: string | null;
  lines: PurchaseReceptionCommentLines;
  amountInWords: string;
  warehouse: string;
}

export interface PurchaseReceptionCommentsBase {
  reception: { id: number; number: string; supplierCode: string };
  supplierId: number;
  fields: PurchaseReceptionCommentsFields;
  reason: string | null;
}

export interface PurchaseReceptionCommentsSource {
  read(companyId: number, receptionId: number): Promise<PurchaseReceptionCommentsBase | null>;
  labels(movementLetter: string): Promise<PurchaseReceptionCommentLines>;
  transportName(code: string): Promise<string>;
}

export interface PurchaseReceptionCommentsSnapshot {
  reception: PurchaseReceptionCommentsBase['reception'];
  fields: PurchaseReceptionCommentsFields;
  transportName: string;
  labels: PurchaseReceptionCommentLines;
  revision: string;
  canWrite: boolean;
  reason: string | null;
}

export interface PurchaseReceptionCommentsInput {
  fields: PurchaseReceptionCommentsFields;
  revision: string;
}

export interface PurchaseReceptionCommentsDataSource {
  read(companyId: number, receptionId: number): Promise<PurchaseReceptionCommentsSnapshot | null>;
  save(companyId: number, receptionId: number, input: PurchaseReceptionCommentsInput): Promise<PurchaseReceptionCommentsSnapshot>;
}
