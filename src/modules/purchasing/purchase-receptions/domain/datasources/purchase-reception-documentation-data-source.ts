import type { PurchaseReceptionActor } from './purchase-reception-write-data-source.js';

export interface ReceptionDocumentationDocument {
  id: number;
  number: string;
  amount: number;
}

export interface ReceptionDocumentationPreview {
  reception: { id: number; number: string };
  amount: number;
  revision: string;
  canWrite: boolean;
  reason: string | null;
  documents: ReceptionDocumentationDocument[];
}

export interface ReceptionDocumentationInput {
  requestKey: string;
  revision: string;
  documents: Omit<ReceptionDocumentationDocument, 'id'>[];
}

export interface ReceptionDocumentationSource {
  id: number;
  number: string;
  supplier: { id: number; code: string; name: string };
  date: string | null;
  dueAt: string | null;
  amount: number;
  reason: string | null;
  version: string;
  recorded: ReceptionDocumentationPreview | null;
}

export interface PurchaseReceptionDocumentationDataSource {
  source(companyId: number, receiptId: number): Promise<ReceptionDocumentationSource | null>;
  commit(command: {
    actor: PurchaseReceptionActor;
    receiptId: number;
    input: ReceptionDocumentationInput;
    fingerprint: string;
    validate(source: ReceptionDocumentationSource): void;
  }): Promise<ReceptionDocumentationPreview>;
}
