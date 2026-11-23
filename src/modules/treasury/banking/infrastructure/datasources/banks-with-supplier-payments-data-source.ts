import { readSupplierPayments } from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import { BankAccount } from '../../domain/entities/bank-account.js';
import type { BankPanelKey, BankPanelOptions, BankPanelResponse } from '../../domain/repositories/bank-panels-repository.js';
import { LegacyMysqlBankAccountsDataSource } from './legacy-mysql-bank-accounts-data-source.js';
import { LegacyMysqlBankPanelsDataSource } from './legacy-mysql-bank-panels-data-source.js';

const money = (value: number) => Number(value.toFixed(2));

export class BankAccountsWithSupplierPaymentsDataSource extends LegacyMysqlBankAccountsDataSource {
  override findById(id: number) { return this.withPayments(super.findById(id)); }
  override findByCode(code: string) { return this.withPayments(super.findByCode(code)); }

  private async withPayments(source: Promise<BankAccount | null>) {
    const account = await source;
    if (!account) return null;
    const data = account.toPrimitives();
    const payments = await readSupplierPayments(0, async (client) => {
      const { rows } = await client.query<{ amount: string }>(
        'SELECT coalesce(sum(amount),0) AS amount FROM tuvansa.supplier_payments WHERE bank_account_id=$1 AND company_id=1',
        [data.id],
      );
      return Number(rows[0]?.amount ?? 0);
    });
    if (payments === 0) return account;
    return BankAccount.create({
      ...data,
      balances: { ...data.balances, current: money(data.balances.current - payments) },
      currencyBalances: { ...data.currencyBalances, current: money(data.currencyBalances.current - payments) },
    });
  }
}

interface BankPaymentRow {
  id: string;
  number: string;
  policyNumber: string;
  date: string;
  amount: string;
  beneficiary: string;
  description: string;
  userId: number;
  mode: 'check' | 'transfer';
}

const paymentRow = ({ id, number, policyNumber, date, amount, beneficiary, description, userId, mode }: BankPaymentRow) => ({
  movementId: Number(id), policyId: Number(id), bankNumber: number, checkNumber: number,
  beneficiary, movementBeneficiary: beneficiary, policyNumber, policyDate: date, description, user: userId,
  movementType: 'PP', charge: 0, credit: Number(amount), reconciled: '', inTransit: '', postdatedAt: null,
  accountingType: 1, authorized: '', applied: 1, policyStatus: 0, costCenter: '', linked: '0', mode,
});

export class BankPanelsWithSupplierPaymentsDataSource extends LegacyMysqlBankPanelsDataSource {
  override async getPanel(id: number, key: BankPanelKey, options: BankPanelOptions): Promise<BankPanelResponse> {
    const base = await super.getPanel(id, key, options);
    const keys: BankPanelKey[] = ['auxiliary', 'reconciliation', 'automatic-reconciliation', 'authorization-review', 'payments'];
    if (!keys.includes(key) || (!base.available && key !== 'payments')) return base;
    const local = await this.paymentRows(id, key, options);
    if (!local.length) return base;
    const summary = { ...base.summary };
    const credits = local.reduce((total, { credit }) => total + credit, 0);
    if (key === 'auxiliary' || key === 'payments') {
      summary.credits = money(Number(summary.credits ?? 0) + credits);
      summary.charges = Number(summary.charges ?? 0);
      summary.balance = money(Number(summary.charges) - Number(summary.credits));
    } else if (key === 'reconciliation') {
      summary.credits = money(Number(summary.credits ?? 0) + credits);
    } else if (key === 'automatic-reconciliation') {
      summary.pending = money(Number(summary.pending ?? 0) - credits);
    }
    const panel = { ...base, available: true, source: [...base.source, 'supplier_payments'], items: [...base.items, ...local], summary };
    delete panel.reason;
    return panel;
  }

  private paymentRows(id: number, key: BankPanelKey, { fiscalYear, asOfDate }: BankPanelOptions) {
    const start = key === 'auxiliary' ? `${fiscalYear}-01-01` : null;
    const end = key === 'automatic-reconciliation' ? asOfDate : null;
    return readSupplierPayments<ReturnType<typeof paymentRow>[]>([], async (client) => {
      const { rows } = await client.query<BankPaymentRow>(
        `SELECT p.id::text,p.number,p.policy_number AS "policyNumber",p.date::text,p.amount::text,p.description,
           p.user_id AS "userId",p.mode,r.result #>> '{reception,supplier,name}' AS beneficiary
         FROM tuvansa.supplier_payments p JOIN tuvansa.purchase_receptions r ON r.id=p.receipt_id
         WHERE p.bank_account_id=$1 AND p.company_id=1 AND ($2::date IS NULL OR p.date >= $2)
           AND ($3::date IS NULL OR p.date <= $3)
         ORDER BY p.id LIMIT 32767`,
        [id, start, end],
      );
      return rows.map(paymentRow);
    });
  }
}
