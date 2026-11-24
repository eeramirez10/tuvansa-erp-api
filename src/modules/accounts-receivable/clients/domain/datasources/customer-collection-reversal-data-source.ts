import type { PostingReversalInput, PostingReversalResult } from '../../../../purchasing/purchase-receptions/domain/datasources/purchase-posting-reversal-data-source.js';

export interface CustomerCollectionReversalIdentity { companyId: number; clientId: number; collectionId: number }
export interface CollectionBankReconciliation { id: number; date: string }
export interface CustomerCollectionReversalInput extends PostingReversalInput { expectedReconciliationId?: number | null | undefined }
export interface CustomerCollectionReversalResult extends PostingReversalResult { originalReconciliation?: CollectionBankReconciliation }

export interface CustomerCollectionReversalSource {
  number: string;
  policyNumber: string;
  originalDate: string;
  remissionId: number;
  remissionNumber: string;
  principal: number;
  bankAccountId: number;
  amount: number;
  supported: boolean;
  originalReconciliation: CollectionBankReconciliation | null;
  latestBankStatementDate: string | null;
  lastCollectionReversalAt: string | null;
  alreadyRecorded: CustomerCollectionReversalResult | null;
}

export interface CustomerCollectionReversalCommand {
  identity: CustomerCollectionReversalIdentity;
  userId: number;
  input: CustomerCollectionReversalInput;
  fingerprint: string;
  validate(source: CustomerCollectionReversalSource): void;
}

export interface CustomerCollectionReversalDataSource {
  source(identity: CustomerCollectionReversalIdentity): Promise<CustomerCollectionReversalSource | null>;
  findRequest(companyId: number, requestKey: string, fingerprint: string): Promise<CustomerCollectionReversalResult | null>;
  commit(command: CustomerCollectionReversalCommand): Promise<CustomerCollectionReversalResult>;
}
