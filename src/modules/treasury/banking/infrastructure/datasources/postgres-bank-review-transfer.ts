import type { PostgresManualPolicies } from '../../../../accounting/policies/infrastructure/datasources/postgres-manual-policies.js';
import type { BankReviewTransferDataSource, BankReviewTransferPosting } from '../../domain/datasources/bank-review-transfer-data-source.js';
import type { PostgresBankPanelSettings } from './postgres-bank-panel-settings.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { isLocalSupplierPaymentId } from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import { isLocalCustomerCollectionId } from '../../../../accounts-receivable/clients/infrastructure/datasources/postgres-customer-collections.js';
import { customerCollectionReversalSql, customerCollectionReversalsAvailable } from '../../../../accounts-receivable/clients/infrastructure/datasources/customer-collection-reversal-reads.js';
import { supplierPaymentReversalSql } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-posting-reversal-reads.js';
import { supplierPaymentReversalsAvailable } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-posting-reversal-tables.js';
import { activeManualPolicyLines, isManualPolicyLineId } from '../../../../accounting/policies/infrastructure/datasources/manual-policy-reads.js';
import { isLocalBankTransferMovementId } from './postgres-bank-transfers.js';

async function verifyWebSources(client: PostgresClient, accountId: number, movementIds: number[]) {
  const payments = movementIds.filter(isLocalSupplierPaymentId);
  const deposits = movementIds.filter(isLocalCustomerCollectionId);
  const journals = movementIds.filter(isManualPolicyLineId);
  const transfers = movementIds.filter(isLocalBankTransferMovementId);
  const queries: { ids: number[]; sql: string }[] = [];
  if (payments.length) {
    const reversal = supplierPaymentReversalSql(await supplierPaymentReversalsAvailable(client));
    queries.push({ ids: payments, sql: `SELECT payment.id FROM tuvansa.supplier_payments payment ${reversal.join}
      WHERE payment.id=ANY($2::bigint[]) AND payment.bank_account_id=$1 AND payment.company_id=1 AND ${reversal.active}` });
  }
  if (deposits.length) {
    const reversal = customerCollectionReversalSql(await customerCollectionReversalsAvailable(client), 'posting');
    queries.push({ ids: deposits, sql: `SELECT posting.id FROM tuvansa.customer_collections posting ${reversal.join}
      WHERE posting.id=ANY($2::bigint[]) AND posting.bank_account_id=$1 AND posting.company_id=1 AND ${reversal.active}` });
  }
  if (journals.length) queries.push({ ids: journals, sql: `SELECT l.id ${activeManualPolicyLines}
    WHERE l.id=ANY($2::bigint[]) AND l.account_id=$1 AND l.account_type=0` });
  if (transfers.length) queries.push({ ids: transfers, sql: `SELECT id FROM tuvansa.bank_transfer_movements
    WHERE id=ANY($2::bigint[]) AND bank_account_id=$1 AND company_id=1` });
  for (const { ids, sql } of queries) {
    const { rows } = await client.query(sql, [accountId, ids]);
    if (rows.length !== ids.length) throw new ConflictError('Alguna partida marcada ya no está disponible.', 'BANK_REVIEW_TRANSFER_SELECTION_CHANGED');
  }
}

export class PostgresBankReviewTransfer implements BankReviewTransferDataSource {
  constructor(private readonly journals: PostgresManualPolicies, private readonly settings: PostgresBankPanelSettings) {}

  findRequest(requestKey: string, fingerprint: string) {
    return this.journals.findRequest(requestKey, fingerprint);
  }

  async post({ accountId, journal, lines, fingerprint, verify, revision, marks }: BankReviewTransferPosting) {
    await this.settings.ensureReady();
    return this.journals.create(journal, lines, fingerprint, verify, undefined, {
      origin: 'TRASPCTAS',
      record: async (client) => {
        const movementIds = [...new Set(lines.flatMap((line) => line.bankSourceMovementId ?? []))];
        await verifyWebSources(client, accountId, movementIds);
        await this.settings.saveInTransaction(client, { accountId, action: 'review', scope: '' }, revision, marks, true);
      },
    });
  }
}
