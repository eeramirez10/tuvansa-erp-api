export interface NativeReceiptPiece {
  id: number;
  productId: number;
  productCode: string;
  serialNumber: string;
  pieces: number;
  quantity: number;
  warehouse: string;
  orderNumber: string;
  reference: string;
  date: string | null;
  receiptNumber: string;
  invoiceNumber: string;
  customsEntry: string;
  importDate: string | null;
  customsOffice: string;
  notes: string;
}

export interface NativeReceiptPieceLine {
  id: number;
  productId: number;
  productCode: string;
  description: string;
  quantity: number;
  pieces: string;
  warehouse: string;
}

export interface NativeReceiptForPieces {
  id: number;
  number: string;
  warehouse: string;
  receivedAt: string | null;
  canWrite: boolean;
  reason: string | null;
  customsEntry: string;
  customsOffice: string;
  customsDate: string | null;
  lines: NativeReceiptPieceLine[];
  version: string;
}

export interface PurchaseReceptionPieceNativeSource {
  receipt(companyId: number, receiptId: number): Promise<NativeReceiptForPieces | null>;
  pieces(companyId: number, receiptNumber: string): Promise<NativeReceiptPiece[]>;
  serialExists(serial: string, excludeId?: number): Promise<boolean>;
  sequence(companyId: number): Promise<number | null>;
}

export interface PieceLineSnapshot {
  lineId: number;
  productCode: string;
  description: string;
  pieces: string;
  remaining: number;
  suggestedSerial: string;
  canAdd: boolean;
  addReason: string | null;
  canEdit: boolean;
  editReason: string | null;
  revision: string;
}

export interface AddPurchaseReceptionPieceInput {
  serial: string;
  quantity: number;
  reference: string;
  requestKey: string;
  revision: string;
}

export interface EditPurchaseReceptionPiecesInput {
  pieces: string;
  revision: string;
}

export interface UpdatePurchaseReceptionPieceSerialInput {
  serial: string;
  previousSerial: string;
}

export interface PurchaseReceptionPiecesDataSource {
  line(companyId: number, receiptId: number, lineId: number): Promise<PieceLineSnapshot | null>;
  add(companyId: number, receiptId: number, lineId: number, input: AddPurchaseReceptionPieceInput): Promise<{ serialNumber: string }>;
  edit(companyId: number, receiptId: number, lineId: number, input: EditPurchaseReceptionPiecesInput): Promise<{ pieces: string }>;
  updateSerial(companyId: number, receiptId: number, pieceId: number, input: UpdatePurchaseReceptionPieceSerialInput): Promise<{ serialNumber: string }>;
}
