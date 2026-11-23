import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { BankAccountsDataSource } from '../../domain/datasources/bank-accounts-data-source.js';
import type { BankReconciliationDataSource, BankReconciliationInput } from '../../domain/datasources/bank-reconciliation-data-source.js';
import { validateReconciliationInput } from '../../domain/entities/bank-reconciliation.js';

export class CaptureBankReconciliation {
  constructor(
    private readonly storage: BankReconciliationDataSource,
    private readonly accounts: Pick<BankAccountsDataSource, 'findById'>,
  ) {}

  async save(companyId: number, bankAccountId: number, raw: BankReconciliationInput) {
    if (!this.storage.writable()) {
      throw new ApplicationError('La conciliación requiere PostgreSQL.', 'BANK_RECONCILIATION_POSTGRES_UNAVAILABLE', 503);
    }
    const input = { ...raw, requestKey: raw.requestKey.toLowerCase(), movementIds: [...raw.movementIds].sort((a, b) => a - b) };
    validateReconciliationInput(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({
      companyId, bankAccountId, movementIds: input.movementIds, statementDate: input.statementDate,
      statementBalance: input.statementBalance, expectedBankBalance: input.expectedBankBalance,
    })).digest('hex');
    const existing = await this.storage.findRequest(companyId, input.requestKey, fingerprint);
    if (existing) return existing;
    return this.storage.commit({
      companyId, bankAccountId, input, fingerprint,
      bankOpeningBalance: async (lookup = async (id) => (await this.accounts.findById(id))?.toPrimitives() ?? null) => {
        const account = await lookup(bankAccountId);
        if (!account) throw new NotFoundError('Cuenta bancaria');
        if (account.currency.id !== 1 || account.systemType !== 'bank'
            || ![0, companyId].includes(account.control.company) || ![0, companyId].includes(account.control.multiCompany)) {
          throw new ApplicationError('La conciliación está disponible para cuentas bancarias de México en pesos.',
            'BANK_RECONCILIATION_INELIGIBLE_ACCOUNT', 422);
        }
        return Number(account.balances.bank.toFixed(2));
      },
    });
  }
}
