import type { AccountingPolicy } from '../../domain/entities/accounting-policy.js';

export const toAccountingPolicyResponse = (policy: AccountingPolicy) => policy.toPrimitives();
