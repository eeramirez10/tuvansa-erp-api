import { createHash } from 'node:crypto';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { InvoicePanelResult } from '../../domain/repositories/invoice-panels-repository.js';

export interface InvoicePieceIdentity { id: number; number: string }

export interface InvoicePieceEdit {
  expectedVersion: string;
  requestKey: string;
  value: string;
}

export interface SavedInvoicePiece {
  lineId: number;
  value: string;
  revision: number;
  expectedVersion: string;
}

export interface InvoicePieceStore {
  writable(): boolean;
  latest(invoice: InvoicePieceIdentity): Promise<SavedInvoicePiece[]>;
  save(invoice: InvoicePieceIdentity, lineId: number, original: string, edit: InvoicePieceEdit): Promise<SavedInvoicePiece>;
}

export const originalPieceValue = (pieces: unknown): string => pieces == null ? '' : String(pieces);

export function invoicePieceVersion(invoice: InvoicePieceIdentity, lineId: number, original: string, revision: number): string {
  return createHash('sha256').update(JSON.stringify([invoice.id, invoice.number, lineId, original, revision])).digest('hex');
}

export class EditInvoicePieces {
  constructor(private readonly store: InvoicePieceStore, private readonly read: (id: number) => Promise<InvoicePanelResult | null>) {}

  async execute(invoiceId: number, lineId: number, edit: InvoicePieceEdit) {
    const panel = await this.read(invoiceId);
    const line = panel?.items.find((item) => item.id === lineId);
    if (!panel || !line) throw new NotFoundError('Partida de la factura');
    const original = originalPieceValue(line.pieces);
    const saved = await this.store.save(panel.invoice, lineId, original, edit);
    return { id: lineId, pieces: saved.value, version: invoicePieceVersion(panel.invoice, lineId, original, saved.revision) };
  }
}
