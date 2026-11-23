export interface PurchasePostingReversalReference {
  id: number;
  policyNumber: string;
  date: string;
  reason: string;
  userId: number;
  createdAt: string;
}

export const reversalReferenceSql = (alias: string) => `CASE WHEN ${alias}.id IS NOT NULL THEN
  jsonb_build_object('id',${alias}.id,'policyNumber',${alias}.policy_number,'date',${alias}.date,
    'reason',${alias}.reason,'userId',${alias}.user_id,'createdAt',${alias}.created_at::text) END`;

export function supplierPaymentReversalSql(available: boolean) {
  return {
    join: available ? `LEFT JOIN tuvansa.supplier_payment_reversals reversal
      ON reversal.payment_id=payment.id AND reversal.company_id=payment.company_id` : '',
    active: available ? 'reversal.id IS NULL' : 'true',
    paid: available ? 'sum(payment.amount) FILTER (WHERE reversal.id IS NULL)' : 'sum(payment.amount)',
    revision: available ? '(count(*) + count(reversal.id) + 1)::integer' : '(count(*) + 1)::integer',
    latestDate: available ? 'max(reversal.date)::text' : 'null::text',
    reference: available ? reversalReferenceSql('reversal') : 'null::jsonb',
  };
}
