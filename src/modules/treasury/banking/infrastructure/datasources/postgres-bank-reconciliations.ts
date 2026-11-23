import { isLocalSupplierPaymentId, supplierPaymentsAvailable } from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import { customerCollectionsAvailable } from '../../../../accounts-receivable/clients/infrastructure/datasources/customer-collections-reads.js';
import { isLocalCustomerCollectionId } from '../../../../accounts-receivable/clients/infrastructure/datasources/postgres-customer-collections.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import {
  connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type {
  BankReconciliationCommand, BankReconciliationDataSource, BankReconciliationMovement, BankReconciliationResult,
} from '../../domain/datasources/bank-reconciliation-data-source.js';
import { bankCents, reconcileMovements } from '../../domain/entities/bank-reconciliation.js';
import { bankReconciliationsAvailable, bankReconciliationState } from './bank-reconciliation-reads.js';

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
}];

const unavailable = () => new ApplicationError(
  'No fue posible consultar o registrar la conciliación en PostgreSQL.', 'BANK_RECONCILIATION_POSTGRES_UNAVAILABLE', 503,
);

export class PostgresBankReconciliations implements BankReconciliationDataSource {
  private migration?: Promise<void>;

  constructor(
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured = postgresConfigured,
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

  async commit(command: BankReconciliationCommand) {
    if (!this.writable()) throw unavailable();
    this.migration ??= this.withConnection((client) => migratePostgres(client, migrations)).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    return this.withConnection(async (client) => {
      await client.query('BEGIN');
      try {
        const result = await this.saveInTransaction(client, command);
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
    const deposits = ids.filter(isLocalCustomerCollectionId);
    if (payments.length + deposits.length !== ids.length) return [];
    const movements: BankReconciliationMovement[] = [];
    if (payments.length && await supplierPaymentsAvailable(client)) {
      const { rows } = await client.query<BankReconciliationMovement>(
        `SELECT p.id::float8 AS id,p.date::text,(-p.amount)::float8 AS amount
         FROM tuvansa.supplier_payments p
         WHERE p.company_id=$1 AND p.bank_account_id=$2 AND p.id=ANY($3::bigint[])
           AND NOT EXISTS (SELECT 1 FROM tuvansa.bank_reconciliation_movements m WHERE m.movement_id=p.id)
         FOR KEY SHARE OF p`, [companyId, accountId, payments],
      );
      movements.push(...rows);
    }
    if (deposits.length && await customerCollectionsAvailable(client)) {
      const { rows } = await client.query<BankReconciliationMovement>(
        `SELECT c.id::float8 AS id,c.date::text,c.amount::float8 AS amount
         FROM tuvansa.customer_collections c
         WHERE c.company_id=$1 AND c.bank_account_id=$2 AND c.id=ANY($3::bigint[])
           AND NOT EXISTS (SELECT 1 FROM tuvansa.bank_reconciliation_movements m WHERE m.movement_id=c.id)
         FOR KEY SHARE OF c`, [companyId, accountId, deposits],
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

    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('bank-reconciliation:' || $1::text || ':' || $2::text,0))",
      [companyId, bankAccountId]);
    const opening = await command.bankOpeningBalance();
    const { delta, lastStatementDate } = await bankReconciliationState(client, companyId, bankAccountId);
    const movements = await this.pendingMovements(client, companyId, bankAccountId, input.movementIds);
    if (movements.length !== input.movementIds.length) {
      throw new ConflictError('Algún movimiento ya está conciliado o no pertenece a esta cuenta.',
        'BANK_RECONCILIATION_MOVEMENT_UNAVAILABLE');
    }
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
