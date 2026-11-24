export type BankReviewMark = '' | '+' | '*';
export type BankReviewDocument = Record<string, BankReviewMark>;

export interface BankReviewRow {
  movementId: number;
  canSetReviewMark?: boolean;
  authorized: BankReviewMark;
  reviewed?: boolean;
  charge: number;
  credit: number;
  costCenter: number | string;
  movementType: string;
}

export function bankReviewMarks(values?: BankReviewDocument | number[]): BankReviewDocument {
  if (Array.isArray(values)) return Object.fromEntries(values.map((id) => [id, '*']));
  return values ?? {};
}
