import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import {
  connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import { isLocalPurchaseReceptionId } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-writes.js';
import type { BankAccountsWithCatalogDataSource } from '../../../../treasury/banking/infrastructure/datasources/bank-accounts-with-catalog-data-source.js';
import type {
  SupplierPaymentCommand, SupplierPaymentDataSource, SupplierPaymentIdentity, SupplierPaymentResult, SupplierPaymentTarget,
} from '../../domain/datasources/supplier-payment-data-source.js';
import { paymentMoney, validateSupplierPayment } from '../../domain/entities/supplier-payment.js';

const paymentIdStart = 6900000000000;
const paymentIdEnd = paymentIdStart + 99999998;

export const isLocalSupplierPaymentId = (id: number) => id >= paymentIdStart && id <= paymentIdEnd;

const migrations = [{
  id: 'supplier_payment_capture',
  sql: `
    CREATE SEQUENCE tuvansa.supplier_payment_ids START WITH ${paymentIdStart} MAXVALUE ${paymentIdEnd};
    CREATE TABLE tuvansa.supplier_payment_bank_counters (
      bank_account_id bigint NOT NULL,
      mode text NOT NULL CHECK (mode IN ('transfer', 'check')),
      sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 99999999),
      PRIMARY KEY (bank_account_id, mode)
    );
    CREATE TABLE tuvansa.supplier_payments (
      id bigint PRIMARY KEY,
      company_id integer NOT NULL,
      user_id integer NOT NULL CHECK (user_id >= 0),
      request_key uuid NOT NULL,
      fingerprint char(64) NOT NULL,
      receipt_id bigint NOT NULL REFERENCES tuvansa.purchase_receptions(id),
      receipt_revision integer NOT NULL CHECK (receipt_revision > 1),
      supplier_id bigint NOT NULL,
      bank_account_id bigint NOT NULL,
      bank_code text NOT NULL,
      bank_name text NOT NULL,
      supplier_account text NOT NULL,
      supplier_account_name text NOT NULL,
      amount numeric(18,2) NOT NULL CHECK (amount > 0),
      date date NOT NULL,
      mode text NOT NULL CHECK (mode IN ('transfer', 'check')),
      number varchar(10) NOT NULL,
      policy_number varchar(11) NOT NULL UNIQUE,
      description varchar(90) NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, request_key),
      UNIQUE (receipt_id, receipt_revision),
      UNIQUE (bank_account_id, mode, number),
      CHECK (bank_code <> supplier_account)
    );
    CREATE INDEX supplier_payments_supplier ON tuvansa.supplier_payments(company_id,supplier_id,date,id);
    CREATE INDEX supplier_payments_bank ON tuvansa.supplier_payments(company_id,bank_account_id,date,id);
  `,
}];

const unavailable = () =>
  new ApplicationError('No fue posible consultar o registrar los pagos de proveedor.', 'SUPPLIER_PAYMENT_POSTGRES_UNAVAILABLE', 503);

export async function supplierPaymentsAvailable(client: PostgresClient): Promise<boolean> {
  const { rows } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.supplier_payments') IS NOT NULL AS available",
  );
  return rows[0]?.available === true;
}

async function withConnection<T>(
  connect: PostgresConnectionFactory,
  work: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  let client: PostgresClient | undefined;
  try {
    client = await connect();
    return await work(client);
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw unavailable();
  } finally {
    client?.release();
  }
}

export function readSupplierPayments<T>(fallback: T, read: (client: PostgresClient) => Promise<T>): Promise<T> {
  if (!postgresConfigured()) return Promise.resolve(fallback);
  return withConnection(connectPostgres, async (client) =>
    await supplierPaymentsAvailable(client) ? read(client) : fallback);
}

export class PostgresSupplierPayments implements SupplierPaymentDataSource {
  private migration?: Promise<void>;

  constructor(
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured: () => boolean = postgresConfigured,
    private readonly bankCatalog?: Pick<BankAccountsWithCatalogDataSource, 'lookupOn'>,
  ) {}

  writable() { return this.configured(); }

  private async findTarget(client: PostgresClient, identity: SupplierPaymentIdentity, withPayments: boolean) {
    const principal = "COALESCE((r.payable ->> 'amount')::numeric,0)";
    const { rows: [row] } = await client.query<SupplierPaymentTarget>(
      `SELECT r.id::float8 AS "receiptId", r.number,
         r.result #>> '{reception,dates,receivedAt}' AS "receivedAt",
         COALESCE((r.result #>> '{reception,cancelled}')::boolean,false) AS cancelled,
         ${principal}::float8 AS principal,
         COALESCE((r.payable ->> 'currencyId')::integer,0) AS "currencyId",
         COALESCE((r.payable ->> 'exchangeRate')::float8,0) AS "exchangeRate",
         ${withPayments ? `GREATEST(${principal} - p.paid,0)` : principal}::float8 AS remaining,
         ${withPayments ? 'p.revision' : '1'} AS revision
       FROM tuvansa.purchase_receptions r
       ${withPayments ? `CROSS JOIN LATERAL (
         SELECT COALESCE(sum(amount),0) AS paid, (count(*) + 1)::integer AS revision
         FROM tuvansa.supplier_payments WHERE receipt_id = r.id
       ) p` : ''}
       WHERE r.id=$1 AND r.company_id=$2 AND r.number LIKE 'RW%'
         AND (r.result #>> '{reception,supplier,id}')::bigint = $3`,
      [identity.receiptId, identity.companyId, identity.supplierId],
    );
    return row ?? null;
  }

  target(identity: SupplierPaymentIdentity) {
    if (!this.writable() || !isLocalPurchaseReceptionId(identity.receiptId)) return Promise.resolve(null);
    return withConnection(this.connect, async (client) => {
      const { rows } = await client.query<{ available: boolean }>(
        "SELECT to_regclass('tuvansa.purchase_receptions') IS NOT NULL AS available",
      );
      return rows[0]?.available ? this.findTarget(client, identity, await supplierPaymentsAvailable(client)) : null;
    });
  }

  private async request(client: PostgresClient, companyId: number, requestKey: string, fingerprint: string) {
    const { rows: [row] } = await client.query<{ result: SupplierPaymentResult; fingerprint: string }>(
      'SELECT result,fingerprint FROM tuvansa.supplier_payments WHERE company_id=$1 AND request_key=$2',
      [companyId, requestKey],
    );
    if (row && row.fingerprint !== fingerprint) {
      throw new ConflictError('La solicitud de pago ya se usó con otros datos.', 'SUPPLIER_PAYMENT_REQUEST_CONFLICT');
    }
    return row?.result ?? null;
  }

  findRequest(companyId: number, requestKey: string, fingerprint: string) {
    if (!this.writable()) return Promise.resolve(null);
    return withConnection(this.connect, async (client) =>
      await supplierPaymentsAvailable(client) ? this.request(client, companyId, requestKey, fingerprint) : null);
  }

  private async migrate() {
    const client = await this.connect();
    try { await migratePostgres(client, migrations); } finally { client.release(); }
  }

  async commit({ identity, userId, input, fingerprint, resolvePosting }: SupplierPaymentCommand): Promise<SupplierPaymentResult> {
    if (!this.configured()) throw unavailable();
    this.migration ??= this.migrate().catch(() => {
      delete this.migration;
      throw unavailable();
    });
    await this.migration;

    return withConnection(this.connect, async (client) => {
      await client.query('BEGIN');
      try {
        const result = await this.saveInTransaction(client, { identity, userId, input, fingerprint, resolvePosting });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  private async saveInTransaction(
    client: PostgresClient,
    { identity, userId, input, fingerprint, resolvePosting }: SupplierPaymentCommand,
  ) {
    const { companyId, supplierId, receiptId } = identity;
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('supplier-payment:' || $1::text || ':' || $2::text, 0))",
      [companyId, input.requestKey],
    );
    const previous = await this.request(client, companyId, input.requestKey, fingerprint);
    if (previous) return previous;

    // Lock the payable before reading its total again so different requests cannot draw the same balance.
    await client.query('SELECT id FROM tuvansa.purchase_receptions WHERE id=$1 AND company_id=$2 FOR UPDATE', [receiptId, companyId]);
    const target = await this.findTarget(client, identity, true);
    if (!target) throw new NotFoundError('Recepción local del proveedor');
    validateSupplierPayment(target, input);
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('bank-reconciliation:' || $1::text || ':' || $2::text, 0))",
      [companyId, input.bankAccountId],
    );
    const { bank, policyType, supplierAccount, supplierAccountName } = await resolvePosting(this.bankCatalog?.lookupOn(client));

    const { rows: [allocation] } = await client.query<{ id: string; sequence: number }>(
      `INSERT INTO tuvansa.supplier_payment_bank_counters(bank_account_id,mode,sequence) VALUES ($1,$2,1)
       ON CONFLICT (bank_account_id,mode) DO UPDATE
         SET sequence = tuvansa.supplier_payment_bank_counters.sequence + 1
       RETURNING nextval('tuvansa.supplier_payment_ids') AS id, sequence`,
      [bank.id, input.mode],
    );
    const id = Number(allocation!.id);
    const number = (input.mode === 'transfer' ? 'TW' : 'CW') + String(allocation!.sequence).padStart(8, '0');
    const policyNumber = policyType + 'PW' + String(id - paymentIdStart + 1).padStart(8, '0');
    const result: SupplierPaymentResult = {
      id, receiptId, receiptNumber: target.number, number, bankAccountId: bank.id, mode: input.mode,
      amount: input.amount, date: input.date, policyNumber, remaining: paymentMoney(target.remaining - input.amount),
    };
    await client.query(
      `INSERT INTO tuvansa.supplier_payments
       (id,company_id,user_id,request_key,fingerprint,receipt_id,receipt_revision,supplier_id,
        bank_account_id,bank_code,bank_name,supplier_account,supplier_account_name,amount,date,
        mode,number,policy_number,description,result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)`,
      [id, companyId, userId, input.requestKey, fingerprint, receiptId, target.revision + 1, supplierId,
        bank.id, bank.code, bank.name, supplierAccount, supplierAccountName, input.amount, input.date,
        input.mode, number, policyNumber, input.description, JSON.stringify(result)],
    );
    return result;
  }
}
