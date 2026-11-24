export type PostingReversalTarget = { kind: 'payment'; paymentId: number; supplierId: number } | { kind: 'expense'; documentId: number };

export interface PostingReversalReconciliation { id: number; date: string }

export interface PostingReversalResult {
  id: number;
  policyNumber: string;
  date: string;
  reason: string;
  originalReconciliation?: PostingReversalReconciliation;
}

export interface PostingReversalInput {
  requestKey: string;
  date: string;
  reason: string;
  confirmed: true;
  expectedReconciliationId?: number | null | undefined;
}

export interface PostingReversalDocument {
  id: number;
  number: string;
  total: number;
}

export interface PostingReversalSnapshot {
  targetId: number;
  number: string;
  policyNumber: string;
  originalDate: string;
  minimumDate: string;
  amount: number;
  documents: PostingReversalDocument[];
  blocked: string | null;
  originalReconciliation?: PostingReversalReconciliation | null;
  alreadyRecorded: PostingReversalResult | null;
}

export interface PostingReversalFiscalWindow { fiscalStart: string; fiscalEnd: string }
export interface PostingReversalReferences {
  fiscalWindow(companyId: number): Promise<PostingReversalFiscalWindow | null>;
}

export interface PostingReversalCommand {
  actor: { companyId: number; userId: number };
  target: PostingReversalTarget;
  input: PostingReversalInput;
  fingerprint: string;
  validate(snapshot: PostingReversalSnapshot): void;
}

export interface PostingReversalDataSource {
  snapshot(companyId: number, target: PostingReversalTarget): Promise<PostingReversalSnapshot | null>;
  findRequest(companyId: number, target: PostingReversalTarget, requestKey: string, fingerprint: string): Promise<PostingReversalResult | null>;
  commit(command: PostingReversalCommand): Promise<PostingReversalResult>;
}
