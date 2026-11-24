import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  AddPurchaseReceptionPieceInput, EditPurchaseReceptionPiecesInput, PurchaseReceptionPiecesDataSource,
  UpdatePurchaseReceptionPieceSerialInput,
} from '../../domain/datasources/purchase-reception-pieces-data-source.js';

export class ManagePurchaseReceptionPieces {
  constructor(private readonly storage: PurchaseReceptionPiecesDataSource) {}

  async prepare(companyId: number, receiptId: number, lineId: number) {
    const line = await this.storage.line(companyId, receiptId, lineId);
    if (!line) throw new NotFoundError('Partida de recepción');
    return line;
  }

  add(companyId: number, receiptId: number, lineId: number, input: AddPurchaseReceptionPieceInput) {
    return this.storage.add(companyId, receiptId, lineId, input);
  }

  edit(companyId: number, receiptId: number, lineId: number, input: EditPurchaseReceptionPiecesInput) {
    return this.storage.edit(companyId, receiptId, lineId, input);
  }

  updateSerial(companyId: number, receiptId: number, pieceId: number, input: UpdatePurchaseReceptionPieceSerialInput) {
    return this.storage.updateSerial(companyId, receiptId, pieceId, input);
  }
}
