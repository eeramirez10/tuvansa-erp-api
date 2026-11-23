import { readSupplierPayments } from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import { readCustomerCollections } from '../../../../accounts-receivable/clients/infrastructure/datasources/postgres-customer-collections.js';
import { BankAccount } from '../../domain/entities/bank-account.js';
import type { BankPanelKey, BankPanelOptions, BankPanelResponse } from '../../domain/repositories/bank-panels-repository.js';
import { bankReconciliationsAvailable, joinBankReconciliation, readBankReconciliationState } from './bank-reconciliation-reads.js';
import { LegacyMysqlBankAccountsDataSource } from './legacy-mysql-bank-accounts-data-source.js';
import { LegacyMysqlBankPanelsDataSource } from './legacy-mysql-bank-panels-data-source.js';

const money = (value: number) => Number(value.toFixed(2));

export class BankAccountsWithLocalPostingsDataSource extends LegacyMysqlBankAccountsDataSource {
  override findById(id: number) { return this.withPostings(super.findById(id)); }
  override findByCode(code: string) { return this.withPostings(super.findByCode(code)); }

  private async withPostings(source: Promise<BankAccount | null>) {
    const account = await source;
    if (!account) return null;
    const data = account.toPrimitives();
    const [payments, collections, reconciled] = await Promise.all([
      readSupplierPayments(0, async (client) => {
        const { rows: [row] } = await client.query<{ amount: number }>(
          'SELECT coalesce(sum(amount),0)::float8 AS amount FROM tuvansa.supplier_payments WHERE bank_account_id=$1 AND company_id=1', [data.id],
        );
        return row?.amount ?? 0;
      }),
      readCustomerCollections(0, async (client) => {
        const { rows: [row] } = await client.query<{ amount: number }>(
          'SELECT coalesce(sum(amount),0)::float8 AS amount FROM tuvansa.customer_collections WHERE bank_account_id=$1 AND company_id=1', [data.id],
        );
        return row?.amount ?? 0;
      }),
      readBankReconciliationState(1, data.id),
    ]);
    const net = money(collections - payments);
    if (net === 0 && reconciled.delta === 0) return account;
    return BankAccount.create({
      ...data,
      balances: {
        ...data.balances,
        current: net === 0 ? data.balances.current : money(data.balances.current + net),
        bank: reconciled.delta === 0 ? data.balances.bank : money(data.balances.bank + reconciled.delta),
      },
      currencyBalances: net === 0 ? data.currencyBalances : {
        ...data.currencyBalances, current: money(data.currencyBalances.current + net),
      },
    });
  }
}

interface LocalBankRow {
  id: string;
  number: string;
  policyNumber: string;
  date: string;
  amount: string;
  beneficiary: string;
  description: string;
  userId: number;
  statementDate: string | null;
}

interface BankPaymentRow extends LocalBankRow { mode: 'check' | 'transfer' }
interface BankCollectionRow extends LocalBankRow { reference: string }

const bankRow = ({ id, number, policyNumber, date, beneficiary, description, userId, statementDate }: LocalBankRow) => ({
  movementId: Number(id), policyId: Number(id), checkNumber: number,
  beneficiary, movementBeneficiary: beneficiary, policyNumber, policyDate: date, description, user: userId,
  reconciled: statementDate ? 'X' : '', inTransit: '', postdatedAt: null,
  ...(statementDate ? { statementDate } : {}),
  accountingType: 1, authorized: '', applied: 1, policyStatus: 0, costCenter: '', linked: '0',
});

const paymentRow = (row: BankPaymentRow) => ({
  ...bankRow(row), bankNumber: row.number, movementType: 'PP', charge: 0, credit: Number(row.amount), mode: row.mode,
});
const collectionRow = (row: BankCollectionRow) => ({
  ...bankRow(row), bankNumber: row.reference || row.number,
  movementType: 'PC', charge: Number(row.amount), credit: 0, mode: 'deposit',
});

const pendingReconciliation = (key: BankPanelKey) => key === 'reconciliation' || key === 'automatic-reconciliation';

export class BankPanelsWithLocalPostingsDataSource extends LegacyMysqlBankPanelsDataSource {
  override async getPanel(id: number, key: BankPanelKey, options: BankPanelOptions): Promise<BankPanelResponse> {
    const base = await super.getPanel(id, key, options);
    const keys: BankPanelKey[] = ['auxiliary', 'reconciliation', 'automatic-reconciliation', 'authorization-review', 'payments', 'deposits'];
    if (!keys.includes(key) || (!base.available && key !== 'payments' && key !== 'deposits')) return base;
    const [payments, collections, reconciliation] = await Promise.all([
      key === 'deposits' ? [] : this.paymentRows(id, key, options),
      key === 'payments' ? [] : this.collectionRows(id, key, options),
      pendingReconciliation(key) ? readBankReconciliationState(1, id) : null,
    ]);
    const local = [...payments, ...collections].sort((a, b) =>
      a.policyDate.localeCompare(b.policyDate) || a.movementId - b.movementId);
    const summary = { ...base.summary };
    if (reconciliation?.lastStatementDate) summary.lastStatementDate = reconciliation.lastStatementDate;
    if (!local.length) return reconciliation?.lastStatementDate ? { ...base, summary } : base;
    const charges = local.reduce((total, { charge }) => total + charge, 0);
    const credits = local.reduce((total, { credit }) => total + credit, 0);
    if (key === 'auxiliary' || key === 'payments' || key === 'deposits') {
      summary.credits = money(Number(summary.credits ?? 0) + credits);
      summary.charges = money(Number(summary.charges ?? 0) + charges);
      summary.balance = money(Number(summary.charges) - Number(summary.credits));
    } else if (key === 'reconciliation') {
      summary.credits = money(Number(summary.credits ?? 0) + credits);
      summary.charges = money(Number(summary.charges ?? 0) + charges);
    } else if (key === 'automatic-reconciliation') {
      summary.pending = money(Number(summary.pending ?? 0) + charges - credits);
    }
    const source = [...base.source];
    if (payments.length) source.push('supplier_payments');
    if (collections.length) source.push('customer_collections');
    const manual = key === 'reconciliation';
    const items = [...base.items, ...local.map((row) => manual ? { ...row, canReconcile: true } : row)];
    const panel = { ...base, available: true, source, readOnly: manual ? false : base.readOnly, items, summary };
    delete panel.reason;
    return panel;
  }

  private paymentRows(id: number, key: BankPanelKey, { fiscalYear, asOfDate }: BankPanelOptions) {
    const start = key === 'auxiliary' ? `${fiscalYear}-01-01` : null;
    const end = key === 'automatic-reconciliation' ? asOfDate : null;
    return readSupplierPayments<ReturnType<typeof paymentRow>[]>([], async (client) => {
      const join = joinBankReconciliation(await bankReconciliationsAvailable(client));
      const { rows } = await client.query<BankPaymentRow>(
        `SELECT posting.id::text, posting.number, posting.policy_number AS "policyNumber",
                posting.date::text, posting.amount::text, posting.description, posting.user_id AS "userId",
                posting.mode, receipt.result #>> '{reception,supplier,name}' AS beneficiary,
                settlement.statement_date::text AS "statementDate"
         FROM tuvansa.supplier_payments AS posting
         JOIN tuvansa.purchase_receptions AS receipt ON receipt.id = posting.receipt_id
         ${join}
         WHERE posting.bank_account_id = $1 AND posting.company_id = 1
           AND ($2::date IS NULL OR posting.date >= $2) AND ($3::date IS NULL OR posting.date <= $3)
           ${pendingReconciliation(key) ? 'AND settlement.statement_date IS NULL' : ''}
         ORDER BY posting.id LIMIT 32767`,
        [id, start, end],
      );
      return rows.map(paymentRow);
    });
  }

  private collectionRows(id: number, key: BankPanelKey, { fiscalYear, asOfDate }: BankPanelOptions) {
    const start = key === 'auxiliary' ? `${fiscalYear}-01-01` : null;
    const end = key === 'automatic-reconciliation' ? asOfDate : null;
    return readCustomerCollections<ReturnType<typeof collectionRow>[]>([], async (client) => {
      const join = joinBankReconciliation(await bankReconciliationsAvailable(client));
      const { rows } = await client.query<BankCollectionRow>(
        `SELECT posting.id::text, posting.number, posting.policy_number AS "policyNumber",
                posting.date::text, posting.amount::text, posting.description, posting.reference,
                posting.user_id AS "userId", remission.result #>> '{invoice,customer,name}' AS beneficiary,
                settlement.statement_date::text AS "statementDate"
         FROM tuvansa.customer_collections AS posting
         JOIN tuvansa.sales_remissions AS remission ON remission.id = posting.remission_id
         ${join}
         WHERE posting.bank_account_id = $1 AND posting.company_id = 1
           AND ($2::date IS NULL OR posting.date >= $2) AND ($3::date IS NULL OR posting.date <= $3)
           ${pendingReconciliation(key) ? 'AND settlement.statement_date IS NULL' : ''}
         ORDER BY posting.date, posting.id LIMIT 32767`, [id, start, end],
      );
      return rows.map(collectionRow);
    });
  }
}
