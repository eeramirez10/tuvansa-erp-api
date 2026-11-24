import { isLocalSupplierPaymentId, supplierPaymentsAvailable } from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import { customerCollectionsAvailable } from '../../../../accounts-receivable/clients/infrastructure/datasources/customer-collections-reads.js';
import { customerCollectionReversalSql, customerCollectionReversalsAvailable, isLocalCustomerCollectionReversalId } from '../../../../accounts-receivable/clients/infrastructure/datasources/customer-collection-reversal-reads.js';
import { activeManualPolicyLines, isManualPolicyLineId, manualPoliciesAvailable } from '../../../../accounting/policies/infrastructure/datasources/manual-policy-reads.js';
import { isLocalCustomerCollectionId } from '../../../../accounts-receivable/clients/infrastructure/datasources/postgres-customer-collections.js';
import { supplierPaymentReversalSql } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-posting-reversal-reads.js';
import { isLocalSupplierPaymentReversalId, supplierPaymentReversalsAvailable } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-posting-reversal-tables.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import {
  connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type {
  BankReconciliationCommand, BankReconciliationDataSource, BankReconciliationMovement, BankReconciliationResult, BankTransitCommand,
} from '../../domain/datasources/bank-reconciliation-data-source.js';
import { bankCents, reconcileMovements } from '../../domain/entities/bank-reconciliation.js';
import { bankReconciliationsAvailable, bankReconciliationState, joinBankReconciliation } from './bank-reconciliation-reads.js';
import { bankTransfersAvailable, isLocalBankTransferMovementId } from './postgres-bank-transfers.js';
import type { BankAccountsWithCatalogDataSource } from './bank-accounts-with-catalog-data-source.js';
import { readBankTransitOn } from './bank-transit-reads.js';
import { readLegacyTransitMovement } from './legacy-mysql-bank-panels-data-source.js';

// Derivada: guarda el corte y relaciona el asiento bancario web con su conciliación.
const migrations = [{
  id: 'bank_reconciliation_capture',
  sql: `
    CREATE SEQUENCE tuvansa.bank_reconciliation_ids START WITH 7400000000000;
    CREATE TABLE tuvansa.bank_reconciliations (
      id bigint PRIMARY KEY DEFAULT nextval('tuvansa.bank_reconciliation_ids'),
      company_id integer NOT NULL,
      bank_account_id bigint NOT NULL,
      request_key uuid NOT NULL,
      fingerprint char(64) NOT NULL,
      statement_date date NOT NULL,
      statement_balance numeric(18,2) NOT NULL,
      previous_bank_balance numeric(18,2) NOT NULL,
      net_movement numeric(18,2) NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, request_key),
      CHECK (statement_balance = previous_bank_balance + net_movement)
    );
    CREATE INDEX bank_reconciliation_account ON tuvansa.bank_reconciliations(company_id,bank_account_id,statement_date);
    CREATE TABLE tuvansa.bank_reconciliation_movements (
      reconciliation_id bigint NOT NULL REFERENCES tuvansa.bank_reconciliations(id) ON DELETE CASCADE,
      movement_id bigint PRIMARY KEY
    );
    CREATE INDEX bank_reconciliation_batch ON tuvansa.bank_reconciliation_movements(reconciliation_id);
  `,
}, {
  id: 'bank_reconciliation_transit',
  sql: `CREATE TABLE tuvansa.bank_reconciliation_transit (
    company_id integer NOT NULL,
    bank_account_id bigint NOT NULL,
    movement_id bigint NOT NULL,
    in_transit boolean NOT NULL,
    amount numeric(18,2) NOT NULL,
    PRIMARY KEY (company_id, bank_account_id, movement_id)
  );
  CREATE INDEX bank_transit_movement ON tuvansa.bank_reconciliation_transit(company_id,movement_id);`,
}];

const inTransit = () => new ConflictError(
  'Hay movimientos en tránsito. Quita la marca antes de conciliarlos.', 'BANK_RECONCILIATION_MOVEMENT_IN_TRANSIT',
);
const movementUnavailable = () => new ConflictError(
  'Algún movimiento ya está conciliado o no pertenece a esta cuenta.', 'BANK_RECONCILIATION_MOVEMENT_UNAVAILABLE',
);

function lockAccount(client: PostgresClient, companyId: number, bankAccountId: number) {
  return client.query("SELECT pg_advisory_xact_lock(hashtextextended('bank-reconciliation:' || $1::text || ':' || $2::text,0))",
    [companyId, bankAccountId]);
}

const unavailable = () => new ApplicationError(
  'No fue posible consultar o registrar la conciliación en PostgreSQL.', 'BANK_RECONCILIATION_POSTGRES_UNAVAILABLE', 503,
);

export class PostgresBankReconciliations implements BankReconciliationDataSource {
  private migration?: Promise<void>;

  constructor(
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured = postgresConfigured,
    private readonly catalog?: Pick<BankAccountsWithCatalogDataSource, 'lookupOn'>,
    private readonly legacyTransit = readLegacyTransitMovement,
  ) {}

  writable() { return this.configured(); }

  private async withConnection<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> {
    let client: PostgresClient | undefined;
    try {
      client = await this.connect();
      return await operation(client);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw unavailable();
    } finally {
      client?.release();
    }
  }

  private async request(client: PostgresClient, companyId: number, key: string, fingerprint: string) {
    const { rows: [row] } = await client.query<{ result: BankReconciliationResult; fingerprint: string }>(
      'SELECT result,fingerprint FROM tuvansa.bank_reconciliations WHERE company_id=$1 AND request_key=$2', [companyId, key],
    );
    if (row && row.fingerprint !== fingerprint) {
      throw new ConflictError('La solicitud de conciliación ya se usó con otros datos.', 'BANK_RECONCILIATION_REQUEST_CONFLICT');
    }
    return row?.result ?? null;
  }

  findRequest(companyId: number, requestKey: string, fingerprint: string) {
    if (!this.writable()) return Promise.resolve(null);
    return this.withConnection(async (client) =>
      await bankReconciliationsAvailable(client) ? this.request(client, companyId, requestKey, fingerprint) : null);
  }

  commit(command: BankReconciliationCommand) {
    return this.transaction((client) => this.saveInTransaction(client, command));
  }

  setTransit({ companyId, bankAccountId, input, bankOpeningBalance }: BankTransitCommand) {
    return this.transaction(async (client) => {
      await lockAccount(client, companyId, bankAccountId);
      await bankOpeningBalance(this.catalog?.lookupOn(client));
      const [local] = await this.pendingMovements(client, companyId, bankAccountId, [input.movementId]);
      const original = local ? { amount: local.amount, inTransit: false }
        : await this.legacyTransit(companyId, bankAccountId, input.movementId);
      if (!original) throw movementUnavailable();

      const keys = [companyId, bankAccountId, input.movementId];
      if (original.inTransit === input.inTransit) {
        await client.query(
          'DELETE FROM tuvansa.bank_reconciliation_transit WHERE company_id=$1 AND bank_account_id=$2 AND movement_id=$3',
          keys,
        );
      } else {
        await client.query(
          `INSERT INTO tuvansa.bank_reconciliation_transit(company_id,bank_account_id,movement_id,in_transit,amount)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (company_id,bank_account_id,movement_id) DO UPDATE
           SET in_transit=EXCLUDED.in_transit,amount=EXCLUDED.amount`,
          [...keys, input.inTransit, bankCents(original.amount) / 100],
        );
      }
      return input;
    });
  }

  private async transaction<T>(operation: (client: PostgresClient) => Promise<T>) {
    if (!this.writable()) throw unavailable();
    this.migration ??= this.withConnection((client) => migratePostgres(client, migrations)).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    return this.withConnection(async (client) => {
      await client.query('BEGIN');
      try {
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  private async pendingMovements(client: PostgresClient, companyId: number, accountId: number, ids: number[]) {
    const payments = ids.filter(isLocalSupplierPaymentId);
    const paymentCorrections = ids.filter(isLocalSupplierPaymentReversalId);
    const deposits = ids.filter(isLocalCustomerCollectionId);
    const depositCorrections = ids.filter(isLocalCustomerCollectionReversalId);
    const manual = ids.filter(isManualPolicyLineId);
    const transfers = ids.filter(isLocalBankTransferMovementId);
    if (payments.length + paymentCorrections.length + deposits.length + depositCorrections.length + transfers.length + manual.length !== ids.length) return [];
    const movements: BankReconciliationMovement[] = [];
    if (payments.length && await supplierPaymentsAvailable(client)) {
      const reversal = supplierPaymentReversalSql(await supplierPaymentReversalsAvailable(client));
      const { rows } = await client.query<BankReconciliationMovement>(
        `SELECT payment.id::float8 AS id,payment.date::text,(-payment.amount)::float8 AS amount
         FROM tuvansa.supplier_payments payment ${reversal.join}
         WHERE payment.company_id=$1 AND payment.bank_account_id=$2 AND payment.id=ANY($3::bigint[])
           AND ${reversal.active}
           AND NOT EXISTS (SELECT 1 FROM tuvansa.bank_reconciliation_movements m WHERE m.movement_id=payment.id)
         FOR KEY SHARE OF payment`, [companyId, accountId, payments],
      );
      movements.push(...rows);
    }
    if (paymentCorrections.length && await supplierPaymentsAvailable(client) && await supplierPaymentReversalsAvailable(client)) {
      const { rows } = await client.query<BankReconciliationMovement>(
        `SELECT correction.id::float8 AS id,correction.date::text,payment.amount::float8 AS amount
         FROM tuvansa.supplier_payment_reversals correction
         JOIN tuvansa.supplier_payments payment ON payment.id=correction.payment_id AND payment.company_id=correction.company_id
         ${joinBankReconciliation(true, 'payment')}
         WHERE correction.company_id=$1 AND payment.bank_account_id=$2 AND correction.id=ANY($3::bigint[])
           AND correction.result #>> '{originalReconciliation,id}'=settlement.id::text
           AND correction.result #>> '{originalReconciliation,date}'=settlement.statement_date::text
           AND NOT EXISTS (SELECT 1 FROM tuvansa.bank_reconciliation_movements m WHERE m.movement_id=correction.id)
         FOR KEY SHARE OF correction`, [companyId, accountId, paymentCorrections],
      );
      movements.push(...rows);
    }
    if (deposits.length && await customerCollectionsAvailable(client)) {
      const reversal = customerCollectionReversalSql(await customerCollectionReversalsAvailable(client), 'c');
      const { rows } = await client.query<BankReconciliationMovement>(
        `SELECT c.id::float8 AS id,c.date::text,c.amount::float8 AS amount
         FROM tuvansa.customer_collections c ${reversal.join}
         WHERE c.company_id=$1 AND c.bank_account_id=$2 AND c.id=ANY($3::bigint[])
           AND ${reversal.active}
           AND NOT EXISTS (SELECT 1 FROM tuvansa.bank_reconciliation_movements m WHERE m.movement_id=c.id)
         FOR KEY SHARE OF c`, [companyId, accountId, deposits],
      );
      movements.push(...rows);
    }
    if (depositCorrections.length && await customerCollectionReversalsAvailable(client)) {
      const { rows } = await client.query<BankReconciliationMovement>(
        `SELECT correction.id::float8 AS id,correction.date::text,(-collection.amount)::float8 AS amount
         FROM tuvansa.customer_collection_reversals correction
         JOIN tuvansa.customer_collections collection ON collection.id=correction.collection_id AND collection.company_id=correction.company_id
         JOIN tuvansa.bank_reconciliation_movements original ON original.movement_id=collection.id
         JOIN tuvansa.bank_reconciliations settled ON settled.id=original.reconciliation_id
           AND settled.company_id=correction.company_id AND settled.bank_account_id=collection.bank_account_id
         WHERE correction.company_id=$1 AND collection.bank_account_id=$2 AND correction.id=ANY($3::bigint[])
           AND correction.result #>> '{originalReconciliation,id}'=settled.id::text
           AND NOT EXISTS (SELECT 1 FROM tuvansa.bank_reconciliation_movements m WHERE m.movement_id=correction.id)
         FOR KEY SHARE OF correction`, [companyId, accountId, depositCorrections],
      );
      movements.push(...rows);
    }
    if (transfers.length && await bankTransfersAvailable(client)) {
      const { rows } = await client.query<BankReconciliationMovement>(
        `SELECT leg.id::float8 AS id, t.date::text, leg.amount::float8 AS amount
         FROM tuvansa.bank_transfer_movements leg
         JOIN tuvansa.bank_transfers t ON t.id=leg.transfer_id AND t.company_id=leg.company_id
         WHERE leg.company_id=$1 AND leg.bank_account_id=$2 AND leg.id=ANY($3::bigint[])
           AND NOT EXISTS (SELECT 1 FROM tuvansa.bank_reconciliation_movements m WHERE m.movement_id=leg.id)
         FOR KEY SHARE OF leg`, [companyId, accountId, transfers],
      );
      movements.push(...rows);
    }
    if (manual.length && await manualPoliciesAvailable(client)) {
      const { rows } = await client.query<BankReconciliationMovement>(
        `SELECT l.id::float8,p.date::text,(l.debit-l.credit)::float8 AS amount ${activeManualPolicyLines}
         WHERE p.company_id=$1 AND l.account_id=$2 AND l.id=ANY($3::bigint[]) AND l.account_type=0
           AND NOT EXISTS (SELECT 1 FROM tuvansa.bank_reconciliation_movements m WHERE m.movement_id=l.id)
         FOR KEY SHARE OF l`, [companyId, accountId, manual],
      );
      movements.push(...rows);
    }
    return movements;
  }

  private async saveInTransaction(client: PostgresClient, command: BankReconciliationCommand) {
    const { companyId, bankAccountId, input, fingerprint } = command;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('bank-reconciliation-request:' || $1::text || ':' || $2::text,0))",
      [companyId, input.requestKey]);
    const existing = await this.request(client, companyId, input.requestKey, fingerprint);
    if (existing) return existing;

    await lockAccount(client, companyId, bankAccountId);
    const opening = await command.bankOpeningBalance(this.catalog?.lookupOn(client));
    const { delta, lastStatementDate } = await bankReconciliationState(client, companyId, bankAccountId);
    const movements = await this.pendingMovements(client, companyId, bankAccountId, input.movementIds);
    if (movements.length !== input.movementIds.length) throw movementUnavailable();
    const selected = new Set(input.movementIds);
    const marks = await readBankTransitOn(client, companyId, bankAccountId);
    if (marks.some((mark) => mark.inTransit && selected.has(mark.movementId))) throw inTransit();
    const amount = (bankCents(opening) + bankCents(delta)) / 100;
    const balances = reconcileMovements(input, movements, amount, lastStatementDate);
    const { rows: [allocation] } = await client.query<{ id: string }>("SELECT nextval('tuvansa.bank_reconciliation_ids') AS id");
    const result: BankReconciliationResult = {
      id: Number(allocation!.id), movementIds: input.movementIds, statementDate: input.statementDate, ...balances,
    };

    await client.query(
      `INSERT INTO tuvansa.bank_reconciliations
       (id,company_id,bank_account_id,request_key,fingerprint,statement_date,statement_balance,previous_bank_balance,net_movement,result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [result.id, companyId, bankAccountId, input.requestKey, fingerprint, result.statementDate, result.bankBalance,
        result.previousBankBalance, result.netMovement, JSON.stringify(result)],
    );
    await client.query(
      'INSERT INTO tuvansa.bank_reconciliation_movements(reconciliation_id,movement_id) SELECT $1, id FROM unnest($2::bigint[]) AS selected(id)',
      [result.id, input.movementIds],
    );
    return result;
  }
}
