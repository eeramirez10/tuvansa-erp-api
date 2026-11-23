import { readSupplierPayments } from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import { localPurchasePayablesSql, paymentDocumentIdSql } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-payables.js';
import {
  reversalReferenceSql, supplierPaymentReversalSql, type PurchasePostingReversalReference,
} from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-posting-reversal-reads.js';
import { supplierPaymentReversalsAvailable } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-posting-reversal-tables.js';
import { readCustomerCollections } from '../../../../accounts-receivable/clients/infrastructure/datasources/postgres-customer-collections.js';
import { BankAccount } from '../../domain/entities/bank-account.js';
import type { BankPanelKey, BankPanelOptions, BankPanelResponse } from '../../domain/repositories/bank-panels-repository.js';
import { bankReconciliationsAvailable, joinBankReconciliation, readBankReconciliationState } from './bank-reconciliation-reads.js';
import { BankAccountsWithCatalogDataSource } from './bank-accounts-with-catalog-data-source.js';
import { LegacyMysqlBankPanelsDataSource } from './legacy-mysql-bank-panels-data-source.js';
import { bankTransferCheque, readBankTransfers } from './postgres-bank-transfers.js';

const money = (value: number) => Number(value.toFixed(2));
const emptyPostings = { amount: 0, hasMovements: false };
const emptyTransfers = { ...emptyPostings, lastCheque: 0 };

export class BankAccountsWithLocalPostingsDataSource extends BankAccountsWithCatalogDataSource {
  override findById(id: number) { return this.withPostings(super.findById(id)); }
  override findByCode(code: string) { return this.withPostings(super.findByCode(code)); }

  private async withPostings(source: Promise<BankAccount | null>) {
    const account = await source;
    if (!account) return null;
    const data = account.toPrimitives();
    const [payments, collections, transfers, reconciled] = await Promise.all([
      readSupplierPayments(emptyPostings, async (client) => {
        const reversal = supplierPaymentReversalSql(await supplierPaymentReversalsAvailable(client));
        const { rows: [row] } = await client.query<typeof emptyPostings>(
          `SELECT coalesce(${reversal.paid},0)::float8 AS amount, count(*) > 0 AS "hasMovements"
           FROM tuvansa.supplier_payments payment ${reversal.join}
           WHERE payment.bank_account_id=$1 AND payment.company_id=1`, [data.id],
        );
        return row ?? emptyPostings;
      }),
      readCustomerCollections(emptyPostings, async (client) => {
        const { rows: [row] } = await client.query<typeof emptyPostings>(
          `SELECT coalesce(sum(amount),0)::float8 AS amount, count(*) > 0 AS "hasMovements"
           FROM tuvansa.customer_collections WHERE bank_account_id=$1 AND company_id=1`, [data.id],
        );
        return row ?? emptyPostings;
      }),
      readBankTransfers(emptyTransfers, async (client) => {
        const { rows: [row] } = await client.query<typeof emptyTransfers>(
          `SELECT coalesce(sum(posting.amount),0)::float8 AS amount, count(*) > 0 AS "hasMovements",
                  coalesce(max(transfer.reference::bigint) FILTER (WHERE ${bankTransferCheque}),0)::float8 AS "lastCheque"
           FROM tuvansa.bank_transfer_movements AS posting
           JOIN tuvansa.bank_transfers AS transfer ON transfer.id=posting.transfer_id AND transfer.company_id=posting.company_id
           WHERE posting.bank_account_id=$1 AND posting.company_id=1`,
          [data.id],
        );
        return row ?? emptyTransfers;
      }),
      readBankReconciliationState(1, data.id),
    ]);
    const net = money(collections.amount - payments.amount + transfers.amount);
    const movements = data.control.movements || payments.hasMovements || collections.hasMovements || transfers.hasMovements;
    const nextCheckNumber = Math.max(data.control.nextCheckNumber, transfers.lastCheque);
    if (net === 0 && reconciled.delta === 0 && movements === data.control.movements && nextCheckNumber === data.control.nextCheckNumber) return account;
    return BankAccount.create({
      ...data,
      control: { ...data.control, movements, nextCheckNumber },
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

interface BankPaymentRow extends LocalBankRow {
  mode: 'check' | 'transfer';
  offset: boolean;
  supplierId: number;
  reversal: PurchasePostingReversalReference | null;
}
interface BankCollectionRow extends LocalBankRow { reference: string }
interface BankTransferRow extends LocalBankRow { reference: string; policyId: string; movementType: string; mode: 'check' | 'transfer' }

const bankRow = ({ id, number, policyNumber, date, beneficiary, description, userId, statementDate }: LocalBankRow) => ({
  movementId: Number(id), policyId: Number(id), checkNumber: number,
  beneficiary, movementBeneficiary: beneficiary, policyNumber, policyDate: date, description, user: userId,
  reconciled: statementDate ? 'X' : '', inTransit: '', postdatedAt: null,
  ...(statementDate ? { statementDate } : {}),
  accountingType: 1, authorized: '', applied: 1, policyStatus: 0, costCenter: '', linked: '0',
});

const paymentRow = (row: BankPaymentRow) => ({
  ...bankRow(row), bankNumber: row.number, movementType: row.offset ? 'RP' : 'PP',
  charge: row.offset ? Number(row.amount) : 0, credit: row.offset ? 0 : Number(row.amount), mode: row.mode,
  ...(row.offset ? {} : { supplierId: row.supplierId, paymentId: Number(row.id), canReverse: true }),
  ...(row.reversal ? { reversal: row.reversal } : {}),
});
const collectionRow = (row: BankCollectionRow) => ({
  ...bankRow(row), bankNumber: row.reference || row.number,
  movementType: 'PC', charge: Number(row.amount), credit: 0, mode: 'deposit',
});
const transferRow = (row: BankTransferRow) => ({
  ...bankRow(row), policyId: Number(row.policyId), bankNumber: row.mode === 'check' ? '' : row.reference || row.number,
  checkNumber: row.mode === 'check' ? row.reference : row.number, movementType: row.movementType,
  charge: Math.max(Number(row.amount), 0), credit: Math.max(-Number(row.amount), 0), mode: row.mode,
});

const pendingReconciliation = (key: BankPanelKey) => key === 'reconciliation' || key === 'automatic-reconciliation';

export class BankPanelsWithLocalPostingsDataSource extends LegacyMysqlBankPanelsDataSource {
  override async getPanel(id: number, key: BankPanelKey, options: BankPanelOptions): Promise<BankPanelResponse> {
    const base = await super.getPanel(id, key, options);
    const keys: BankPanelKey[] = ['auxiliary', 'reconciliation', 'automatic-reconciliation', 'authorization-review', 'payments', 'deposits'];
    if (!keys.includes(key) || (!base.available && key !== 'payments' && key !== 'deposits')) return base;
    const fiscalYear = typeof base.summary?.fiscalYear === 'number' ? base.summary.fiscalYear : options.fiscalYear;
    const panelOptions = { ...options, fiscalYear };
    const [payments, collections, transfers, reconciliation] = await Promise.all([
      key === 'deposits' ? [] : this.paymentRows(id, key, panelOptions),
      key === 'payments' ? [] : this.collectionRows(id, key, panelOptions),
      this.transferRows(id, key, panelOptions),
      pendingReconciliation(key) ? readBankReconciliationState(1, id) : null,
    ]);
    const local = [...payments, ...collections, ...transfers].sort((a, b) =>
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
    if (transfers.length) source.push('bank_transfers');
    const manual = key === 'reconciliation';
    const items = [...base.items, ...local.map((row) => pendingReconciliation(key) ? { ...row, canReconcile: true } : row)];
    const panel = { ...base, available: true, source, readOnly: manual ? false : base.readOnly, items, summary };
    delete panel.reason;
    return panel;
  }

  private paymentRows(id: number, key: BankPanelKey, { fiscalYear, asOfDate }: BankPanelOptions) {
    const start = key === 'auxiliary' && fiscalYear ? `${fiscalYear}-01-01` : null;
    const end = key === 'automatic-reconciliation' ? asOfDate : null;
    return readSupplierPayments<ReturnType<typeof paymentRow>[]>([], async (client) => {
      const payables = await localPurchasePayablesSql(client);
      if (!payables) return [];
      const join = joinBankReconciliation(await bankReconciliationsAvailable(client));
      const withReversals = await supplierPaymentReversalsAvailable(client);
      const pending = pendingReconciliation(key);
      const includeReversed = !pending && key !== 'authorization-review';
      const reversalJoin = withReversals ? `LEFT JOIN tuvansa.supplier_payment_reversals reversal
        ON reversal.payment_id=posting.id AND reversal.company_id=posting.company_id` : '';
      const scope = `FROM tuvansa.supplier_payments AS posting
        JOIN (${payables}) AS receipt ON receipt.id=${paymentDocumentIdSql('posting')}
          AND receipt.company_id=posting.company_id AND receipt.supplier_id=posting.supplier_id
        ${reversalJoin}`;
      const { rows } = await client.query<BankPaymentRow>(
        `WITH entries AS (
          SELECT posting.id, posting.number, posting.policy_number AS "policyNumber",
                posting.date::text, posting.amount::text, posting.description, posting.user_id AS "userId",
                posting.mode, receipt.supplier_name AS beneficiary,
                settlement.statement_date::text AS "statementDate", false AS "offset",
                posting.supplier_id::float8 AS "supplierId",
                ${withReversals ? reversalReferenceSql('reversal') : 'null::jsonb'} AS reversal
          ${scope} ${join}
          WHERE posting.bank_account_id=$1 AND posting.company_id=1
            ${pending ? 'AND settlement.statement_date IS NULL' : ''}
            ${!includeReversed && withReversals ? 'AND reversal.id IS NULL' : ''}
          ${withReversals && includeReversed ? `UNION ALL
          SELECT reversal.id,reversal.number,reversal.policy_number,reversal.date::text,posting.amount::text,
                 reversal.reason,reversal.user_id,posting.mode,receipt.supplier_name,NULL::text,true,
                 posting.supplier_id::float8,NULL::jsonb
          ${scope}
          WHERE posting.bank_account_id=$1 AND posting.company_id=1 AND reversal.id IS NOT NULL` : ''}
         )
         SELECT id::text,number,"policyNumber",date,amount,description,"userId",mode,beneficiary,"statementDate","offset","supplierId",reversal
         FROM entries
         WHERE ($2::date IS NULL OR date::date >= $2) AND ($3::date IS NULL OR date::date <= $3)
         ORDER BY date,id LIMIT 32767`,
        [id, start, end],
      );
      return rows.map(paymentRow);
    });
  }

  private collectionRows(id: number, key: BankPanelKey, { fiscalYear, asOfDate }: BankPanelOptions) {
    const start = key === 'auxiliary' && fiscalYear ? `${fiscalYear}-01-01` : null;
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

  private transferRows(id: number, key: BankPanelKey, { fiscalYear, asOfDate }: BankPanelOptions) {
    const start = key === 'auxiliary' && fiscalYear ? `${fiscalYear}-01-01` : null;
    const end = key === 'automatic-reconciliation' ? asOfDate : null;
    const listedCheque = key === 'payments' || key === 'deposits';
    return readBankTransfers<ReturnType<typeof transferRow>[]>([], async (client) => {
      const join = joinBankReconciliation(await bankReconciliationsAvailable(client));
      const { rows } = await client.query<BankTransferRow>(
        `SELECT posting.id::text, transfer.id::text AS "policyId", transfer.number, transfer.policy_number AS "policyNumber",
                transfer.date::text, posting.amount::text, transfer.description, transfer.reference,
                transfer.user_id AS "userId", transfer.beneficiary, transfer.movement_type AS "movementType",
                coalesce(transfer.result->>'mode','transfer') AS mode,
                settlement.statement_date::text AS "statementDate"
         FROM tuvansa.bank_transfer_movements AS posting
         JOIN tuvansa.bank_transfers AS transfer ON transfer.id = posting.transfer_id AND transfer.company_id = posting.company_id
         ${join}
         WHERE posting.bank_account_id = $1 AND posting.company_id = 1
           AND ($2::date IS NULL OR transfer.date >= $2) AND ($3::date IS NULL OR transfer.date <= $3)
           ${listedCheque ? "AND transfer.result->>'mode' = 'check'" : ''}
           ${key === 'payments' ? 'AND posting.amount < 0' : key === 'deposits' ? 'AND posting.amount > 0' : ''}
           ${pendingReconciliation(key) ? 'AND settlement.statement_date IS NULL' : ''}
         ORDER BY transfer.date, posting.id LIMIT 32767`,
        [id, start, end],
      );
      return rows.map(transferRow);
    });
  }
}
