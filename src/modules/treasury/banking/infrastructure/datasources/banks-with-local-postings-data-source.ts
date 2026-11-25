import { readSupplierPayments } from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import { localPurchasePayablesSql, paymentDocumentIdSql } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-payables.js';
import {
  reversalReferenceSql, supplierPaymentReversalSql, type PurchasePostingReversalReference,
} from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-posting-reversal-reads.js';
import { supplierPaymentReversalsAvailable } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-posting-reversal-tables.js';
import { readCustomerCollections } from '../../../../accounts-receivable/clients/infrastructure/datasources/postgres-customer-collections.js';
import { customerCollectionReversalSql, customerCollectionReversalsAvailable } from '../../../../accounts-receivable/clients/infrastructure/datasources/customer-collection-reversal-reads.js';
import { activeManualPolicyLines, manualLineSettlement, manualPolicyAffectsAccount, manualPolicyLines, readAppliedHistoricalPolicies, readManualPolicies } from '../../../../accounting/policies/infrastructure/datasources/manual-policy-reads.js';
import { BankAccount } from '../../domain/entities/bank-account.js';
import type { BankPanelKey, BankPanelOptions, BankPanelResponse } from '../../domain/repositories/bank-panels-repository.js';
import { postgresConfigured } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { bankReconciliationsAvailable, joinBankReconciliation, readBankReconciliationState, readLegacyBankSettlements } from './bank-reconciliation-reads.js';
import { readBankTransit } from './bank-transit-reads.js';
import { BankAccountsWithCatalogDataSource } from './bank-accounts-with-catalog-data-source.js';
import { isLegacyBankMovementId, LegacyMysqlBankPanelsDataSource, readLegacyBankStatementDate, sumBankPanelColumn } from './legacy-mysql-bank-panels-data-source.js';
import { bankTransferCheque, readBankTransfers } from './postgres-bank-transfers.js';

const money = (value: number) => Number(value.toFixed(2));
const emptyPostings = { amount: 0, hasMovements: false };
const emptyTransfers = { ...emptyPostings, lastCheque: 0 };
const emptyManualPolicies = { ...emptyPostings, currency: 0 };

export class BankAccountsWithLocalPostingsDataSource extends BankAccountsWithCatalogDataSource {
  override findById(id: number) { return this.withPostings(super.findById(id)); }
  override findByCode(code: string) { return this.withPostings(super.findByCode(code)); }

  private async withPostings(source: Promise<BankAccount | null>) {
    const account = await source;
    if (!account) return null;
    const data = account.toPrimitives();
    const [payments, collections, transfers, manual, reconciled, transit] = await Promise.all([
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
        const reversal = customerCollectionReversalSql(await customerCollectionReversalsAvailable(client));
        const { rows: [row] } = await client.query<typeof emptyPostings>(
          `SELECT coalesce(${reversal.paid},0)::float8 AS amount,count(*)>0 AS "hasMovements"
           FROM tuvansa.customer_collections collection ${reversal.join} WHERE collection.bank_account_id=$1 AND collection.company_id=1`, [data.id],
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
      readManualPolicies(emptyManualPolicies, async (client) => {
        const { rows: [row] } = await client.query<typeof emptyManualPolicies>(
          `SELECT coalesce(sum(l.debit-l.credit),0)::float8 AS amount,
             coalesce(sum(l.debit-l.credit) FILTER (WHERE l.account_id=$1),0)::float8 AS currency,
             count(*) FILTER (WHERE l.account_id=$1)>0 AS "hasMovements"
           ${activeManualPolicyLines} WHERE ${manualPolicyAffectsAccount}`, [data.id],
        );
        return row ?? emptyManualPolicies;
      }),
      readBankReconciliationState(1, data.id),
      readBankTransit(1, data.id),
    ]);
    const directNet = collections.amount - payments.amount + transfers.amount;
    const net = money(directNet + manual.amount);
    const netCurrency = money(directNet + manual.currency);
    const movements = data.control.movements || payments.hasMovements || collections.hasMovements || transfers.hasMovements || manual.hasMovements;
    const nextCheckNumber = Math.max(data.control.nextCheckNumber, transfers.lastCheque);
    const transitDelta = money(transit.reduce((total, mark) => total + mark.delta, 0));
    if (net === 0 && netCurrency === 0 && reconciled.delta === 0 && transitDelta === 0
        && movements === data.control.movements && nextCheckNumber === data.control.nextCheckNumber) return account;
    return BankAccount.create({
      ...data,
      control: { ...data.control, movements, nextCheckNumber },
      balances: {
        ...data.balances,
        current: net === 0 ? data.balances.current : money(data.balances.current + net),
        bank: reconciled.delta === 0 ? data.balances.bank : money(data.balances.bank + reconciled.delta),
        inTransit: money(data.balances.inTransit + transitDelta),
      },
      currencyBalances: netCurrency === 0 ? data.currencyBalances : {
        ...data.currencyBalances, current: money(data.currencyBalances.current + netCurrency),
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
  reconciliationId: number | null;
  reversal: PurchasePostingReversalReference | null;
}
interface BankCollectionRow extends LocalBankRow { reference: string; offset: boolean; clientId: number; reversal: PurchasePostingReversalReference | null }
interface BankTransferRow extends LocalBankRow { reference: string; policyId: string; movementType: string; mode: 'check' | 'transfer' }
interface ManualBankRow extends LocalBankRow {
  linePolicyId: string; debit: string; credit: string; reference: string; center: number; movementType: string; applied: boolean;
}

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
  ...(row.reconciliationId === null ? {} : { reconciliationId: row.reconciliationId }),
  ...(row.offset ? {} : { supplierId: row.supplierId, paymentId: Number(row.id), canReverse: true }),
  ...(row.reversal ? { reversal: row.reversal } : {}),
});
const collectionRow = (row: BankCollectionRow) => ({
  ...bankRow(row), bankNumber: row.reference || row.number,
  movementType: 'PC', charge: row.offset ? 0 : Number(row.amount), credit: row.offset ? Number(row.amount) : 0, mode: 'deposit',
  ...(row.offset ? {} : { clientId: row.clientId, collectionId: Number(row.id), canReverseCollection: !row.reversal }),
  ...(row.reversal ? { reversal: row.reversal } : {}),
});
const transferRow = (row: BankTransferRow) => ({
  ...bankRow(row), policyId: Number(row.policyId), bankNumber: row.mode === 'check' ? '' : row.reference || row.number,
  checkNumber: row.mode === 'check' ? row.reference : row.number, movementType: row.movementType,
  charge: Math.max(Number(row.amount), 0), credit: Math.max(-Number(row.amount), 0), mode: row.mode,
});
const manualBankRow = (row: ManualBankRow) => ({
  ...bankRow(row), policyId: Number(row.linePolicyId), bankNumber: row.reference || row.number,
  checkNumber: '', movementType: row.movementType, charge: Number(row.debit), credit: Number(row.credit), mode: 'journal', costCenter: row.center,
  applied: row.applied ? 1 : 0,
  ...(!row.applied ? { canApplyPolicy: true, accumulated: 0 } : {}),
});

const pendingReconciliation = (key: BankPanelKey) => key === 'reconciliation' || key === 'automatic-reconciliation';

export class BankPanelsWithLocalPostingsDataSource extends LegacyMysqlBankPanelsDataSource {
  override async getPanel(id: number, key: BankPanelKey, options: BankPanelOptions): Promise<BankPanelResponse> {
    const historyForAuxiliary = key === 'auxiliary' ? await readAppliedHistoricalPolicies() : [];
    const base = await super.getPanel(id, key, options, historyForAuxiliary);
    const keys: BankPanelKey[] = ['auxiliary', 'unapplied-auxiliary', 'reconciliation', 'automatic-reconciliation', 'authorization-review', 'payments', 'deposits'];
    if (!keys.includes(key) || (!base.available && key !== 'payments' && key !== 'deposits')) return base;
    const fiscalYear = typeof base.summary?.fiscalYear === 'number' ? base.summary.fiscalYear : options.fiscalYear;
    const panelOptions = { ...options, fiscalYear };
    const unapplied = key === 'unapplied-auxiliary';
    const pending = pendingReconciliation(key);
    const canSettle = pending && postgresConfigured() && base.summary?.transitEligible === true;
    const legacyRows = base.items as Record<string, unknown>[];
    const [payments, collections, transfers, journals, reconciliation, transit, settled, legacyStatementDate, appliedHere] = await Promise.all([
      key === 'deposits' || unapplied ? [] : this.paymentRows(id, key, panelOptions),
      key === 'payments' || unapplied ? [] : this.collectionRows(id, key, panelOptions),
      unapplied ? [] : this.transferRows(id, key, panelOptions),
      key === 'deposits' || key === 'payments' ? [] : this.manualRows(id, key, panelOptions),
      pendingReconciliation(key) ? readBankReconciliationState(1, id) : null,
      pendingReconciliation(key) ? readBankTransit(1, id) : [],
      pending || key === 'auxiliary' ? readLegacyBankSettlements(id) : [],
      canSettle ? readLegacyBankStatementDate(1, id) : null,
      unapplied || pending || key === 'authorization-review' ? readAppliedHistoricalPolicies(
        [...new Set(legacyRows.map(({ policyId }) => Number(policyId)).filter(isLegacyBankMovementId))],
      ) : [],
    ]);
    const webJournals = journals.filter(({ movementId }) => !isLegacyBankMovementId(movementId));
    const local = [...payments, ...collections, ...transfers, ...webJournals].sort((a, b) =>
      a.policyDate.localeCompare(b.policyDate) || a.movementId - b.movementId);
    const summary = { ...base.summary };
    if (reconciliation?.lastStatementDate) summary.lastStatementDate = reconciliation.lastStatementDate;
    if (legacyStatementDate) summary.lastLegacyStatementDate = legacyStatementDate;
    if (!local.length && !pending && !settled.length && !unapplied && !appliedHere.length) return base;
    const charges = local.reduce((total, { charge }) => total + charge, 0);
    const credits = local.reduce((total, { credit }) => total + credit, 0);
    if (key === 'auxiliary' || unapplied || key === 'payments' || key === 'deposits') {
      summary.credits = money(Number(summary.credits ?? 0) + credits);
      summary.charges = money(Number(summary.charges ?? 0) + charges);
      summary.balance = money(Number(summary.charges) - Number(summary.credits));
    }
    const source = [...base.source];
    if (payments.length) source.push('supplier_payments');
    if (collections.length) source.push('customer_collections');
    if (transfers.length) source.push('bank_transfers');
    if (webJournals.length || appliedHere.length || historyForAuxiliary.length) source.push('manual_accounting_policy_lines');
    if (transit.length) source.push('bank_reconciliation_transit');
    if (settled.length) source.push('bank_reconciliation_movements');
    const settledDates = new Map(settled.map(({ movementId, statementDate }) => [movementId, statementDate]));
    const appliedIds = new Set(appliedHere);
    const historical = legacyRows.flatMap<Record<string, unknown>>(({ applyCandidate, ...row }) => {
      const applied = appliedIds.has(Number(row.policyId));
      if (unapplied) {
        return applied ? [] : [{ ...row, canApplyPolicy: postgresConfigured() && Number(applyCandidate) === 1 }];
      }
      const statementDate = settledDates.get(Number(row.movementId));
      if (statementDate && pending) return [];
      return [{ ...row, ...(statementDate ? { reconciled: 'X', statementDate } : {}), ...(applied ? { applied: 1 } : {}) }];
    });
    let items = [...historical, ...local] as Record<string, unknown>[];
    if (unapplied) {
      summary.charges = money(sumBankPanelColumn(items, 'charge'));
      summary.credits = money(sumBankPanelColumn(items, 'credit'));
      summary.balance = money(Number(summary.charges) - Number(summary.credits));
    }
    const manual = key === 'reconciliation';
    if (pending) {
      const marks = new Map(transit.map((mark) => [mark.movementId, mark.inTransit]));
      items = items.map((row) => {
        const marked = marks.get(Number(row.movementId)) ?? row.inTransit === '*';
        const historicalEligible = Number(row.applied) === 1 && Number(row.accountingType) === 1 && row.reconciled === ''
          && Number(row.charge) !== Number(row.credit) && typeof row.policyDate === 'string' && row.policyDate > '1900-12-31';
        return { ...row, inTransit: marked ? '*' : '', canReconcile: (Boolean(row.mode) || (canSettle && historicalEligible)) && !marked,
          ...(historicalEligible ? { historical: true } : {}),
          ...(manual && canSettle ? { canChangeTransit: true } : {}) };
      });
      if (!manual) items = items.filter((row) => row.inTransit !== '*');
      const charges = sumBankPanelColumn(items, 'charge');
      const credits = sumBankPanelColumn(items, 'credit');
      if (manual) {
        summary.charges = money(charges);
        summary.credits = money(credits);
      } else {
        summary.pending = money(charges - credits);
      }
      delete summary.transitEligible;
    }
    const panel = { ...base, available: true, source,
      readOnly: manual || unapplied ? !items.some((row) => row.canChangeTransit || row.canReconcile || row.canApplyPolicy) : base.readOnly,
      items, summary };
    delete panel.reason;
    return panel;
  }

  private paymentRows(id: number, key: BankPanelKey, { fiscalYear, asOfDate }: BankPanelOptions) {
    const start = key === 'auxiliary' && fiscalYear ? `${fiscalYear}-01-01` : null;
    const end = key === 'automatic-reconciliation' ? asOfDate : null;
    return readSupplierPayments<ReturnType<typeof paymentRow>[]>([], async (client) => {
      const payables = await localPurchasePayablesSql(client);
      if (!payables) return [];
      const hasSettlements = await bankReconciliationsAvailable(client);
      const join = joinBankReconciliation(hasSettlements);
      const withReversals = await supplierPaymentReversalsAvailable(client);
      const pending = pendingReconciliation(key);
      const includeReversed = !pending && key !== 'authorization-review';
      const correctionJoin = joinBankReconciliation(hasSettlements, 'reversal', 'correction_settlement', 'posting');
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
                settlement.statement_date::text AS "statementDate", settlement.id::float8 AS "reconciliationId", false AS "offset",
                posting.supplier_id::float8 AS "supplierId",
                ${withReversals ? reversalReferenceSql('reversal') : 'null::jsonb'} AS reversal
          ${scope} ${join}
          WHERE posting.bank_account_id=$1 AND posting.company_id=1
            ${pending ? 'AND settlement.statement_date IS NULL' : ''}
            ${!includeReversed && withReversals ? 'AND reversal.id IS NULL' : ''}
          ${withReversals && (includeReversed || (pending && hasSettlements)) ? `UNION ALL
          SELECT reversal.id,reversal.number,reversal.policy_number,reversal.date::text,posting.amount::text,
                 reversal.reason,reversal.user_id,posting.mode,receipt.supplier_name,
                 correction_settlement.statement_date::text,correction_settlement.id::float8,true,
                 posting.supplier_id::float8,NULL::jsonb
          ${scope} ${join} ${correctionJoin}
          WHERE posting.bank_account_id=$1 AND posting.company_id=1 AND reversal.id IS NOT NULL
            ${pending ? `AND reversal.result #>> '{originalReconciliation,id}'=settlement.id::text
              AND reversal.result #>> '{originalReconciliation,date}'=settlement.statement_date::text
              AND correction_settlement_movement.movement_id IS NULL` : ''}` : ''}
         )
         SELECT id::text,number,"policyNumber",date,amount,description,"userId",mode,beneficiary,"statementDate","reconciliationId","offset","supplierId",reversal
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
      const bankReconciliationAvailable = await bankReconciliationsAvailable(client);
      const join = joinBankReconciliation(bankReconciliationAvailable);
      const hasReversals = await customerCollectionReversalsAvailable(client);
      const reversal = customerCollectionReversalSql(hasReversals, 'posting');
      const pending = pendingReconciliation(key);
      const includeReversed = !pending && key !== 'authorization-review';
      const scope = `FROM tuvansa.customer_collections posting ${reversal.join}
        JOIN tuvansa.sales_remissions remission ON remission.id=posting.remission_id AND remission.company_id=posting.company_id`;
      const correctionJoin = joinBankReconciliation(bankReconciliationAvailable, 'reversal', 'correction_settlement', 'posting');
      const { rows } = await client.query<BankCollectionRow>(
        `WITH entries AS (
          SELECT posting.id,posting.number,posting.policy_number AS "policyNumber",posting.date,posting.amount,posting.description,posting.reference,
                 posting.user_id AS "userId",remission.result #>> '{invoice,customer,name}' AS beneficiary,
                 settlement.statement_date::text AS "statementDate",false AS "offset",posting.client_id::float8 AS "clientId",${reversal.reference} AS reversal
          ${scope} ${join} WHERE posting.bank_account_id=$1 AND posting.company_id=1
            ${pending ? 'AND settlement.statement_date IS NULL' : ''} ${!includeReversed ? `AND ${reversal.active}` : ''}
          ${hasReversals && (includeReversed || pending) ? `UNION ALL
            SELECT reversal.id,reversal.number,reversal.policy_number,reversal.date,posting.amount,reversal.reason,concat('REV ',posting.policy_number),
                   reversal.user_id,remission.result #>> '{invoice,customer,name}',correction_settlement.statement_date::text,true,posting.client_id::float8,NULL::jsonb
            ${scope} ${join} ${correctionJoin} WHERE posting.bank_account_id=$1 AND posting.company_id=1 AND reversal.id IS NOT NULL
              ${pending ? `AND reversal.result #>> '{originalReconciliation,id}'=settlement.id::text
                AND correction_settlement.id IS NULL` : ''}` : ''}
        ) SELECT id::text,number,"policyNumber",date::text,amount::text,description,reference,"userId",beneficiary,"statementDate","offset","clientId",reversal
        FROM entries WHERE ($2::date IS NULL OR date >= $2) AND ($3::date IS NULL OR date <= $3)
        ORDER BY date,id LIMIT 32767`, [id, start, end],
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

  private manualRows(id: number, key: BankPanelKey, { fiscalYear, asOfDate }: BankPanelOptions) {
    const pending = pendingReconciliation(key);
    const unapplied = key === 'unapplied-auxiliary';
    const start = (key === 'auxiliary' || unapplied) && fiscalYear ? `${fiscalYear}-01-01` : null;
    const end = key === 'automatic-reconciliation' ? asOfDate : null;
    return readManualPolicies<ReturnType<typeof manualBankRow>[]>([], async (client) => {
      const settlement = manualLineSettlement(await bankReconciliationsAvailable(client));
      const { rows } = await client.query<ManualBankRow>(
        `SELECT l.id::text,p.id::text AS "linePolicyId",p.number,p.number AS "policyNumber",p.date::text,
          (l.debit-l.credit)::text AS amount,l.debit::text,l.credit::text,p.beneficiary,p.concept AS description,
          l.reference,l.cost_center AS center,0 AS "userId",settlement.statement_date::text AS "statementDate",
          coalesce(to_jsonb(l)->>'bank_movement_type','3') AS "movementType", p.applied
         ${unapplied ? manualPolicyLines : activeManualPolicyLines} ${settlement} WHERE l.account_id=$1
           AND ($2::date IS NULL OR p.date >= $2) AND ($3::date IS NULL OR p.date <= $3)
           ${pending ? 'AND l.account_type=0 AND settlement.statement_date IS NULL' : ''}
           ${unapplied ? 'AND l.account_type=0 AND NOT p.applied' : ''}
         ORDER BY p.date,l.id LIMIT 32767`, [id, start, end],
      );
      return rows.map(manualBankRow);
    });
  }
}
