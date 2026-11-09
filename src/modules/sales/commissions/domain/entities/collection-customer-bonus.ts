export type CollectionCustomerStatus = 'Nuevo' | 'Recurrente' | 'Viejo_Reactivado' | 'Inactivo' | 'Sin clasificar';

/** The ERP routine writes this classification; reading a report never updates it. */
export function collectionCustomerBonus(rawStatus: string, paymentCents: number | null) {
  const statuses: CollectionCustomerStatus[] = ['Nuevo', 'Recurrente', 'Viejo_Reactivado', 'Inactivo'];
  const customerStatus = statuses.find(s => s.toLowerCase() === rawStatus.trim().toLowerCase()) ?? 'Sin clasificar';
  const customerBonusEligible = customerStatus === 'Nuevo' || customerStatus === 'Viejo_Reactivado';
  const known = customerStatus !== 'Sin clasificar';
  const collectedCents = paymentCents === null ? null : paymentCents === 0 ? 0 : -paymentCents;
  const customerBonusBase = !known ? null : !customerBonusEligible ? 0 : collectedCents === null ? null : collectedCents / 100;
  // Keep four places on document detail. The workbook applies 1% to each
  // agent's collected subtotal; rounding every document first changes payouts.
  const customerBonus = !known ? null : !customerBonusEligible ? 0 : collectedCents === null ? null : collectedCents / 10000;
  return { customerStatus, customerBonusEligible, customerBonusRate: !known ? null : customerBonusEligible ? 1 : 0,
    customerBonusBase, customerBonus };
}
