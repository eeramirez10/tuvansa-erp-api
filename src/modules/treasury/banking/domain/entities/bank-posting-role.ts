import type { BankAccountProps } from './bank-account.js';

export function permitsBankPosting(account: BankAccountProps, companyId: number, role: 'payments' | 'deposits'): boolean {
  const { systemType, currency, control } = account;
  return systemType === 'bank' && currency.id === 1 && account.code.trim() !== ''
    && !control.subAccounts && !control.preventJournalEntries && control[role]
    && (control.company === 0 || control.company === companyId)
    && (control.multiCompany === 0 || control.multiCompany === companyId);
}
