import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type {
  ManualPolicyActionInput, ManualPolicyCommentsInput, ManualPolicyDataSource, ManualPolicyDocument, ManualPolicyInput, ManualPolicyLine, ManualPolicyOperation,
} from '../../domain/datasources/manual-policy-data-source.js';
import type { AccountingPolicyProps } from '../../domain/entities/accounting-policy.js';
import type { PolicyLiabilityCharge, PolicyLiabilityStorage } from '../../domain/datasources/policy-liability-data-source.js';
import type { BankAccountLookup } from '../../../../treasury/banking/domain/entities/bank-account.js';
import type { BankAccountsWithCatalogDataSource } from '../../../../treasury/banking/infrastructure/datasources/bank-accounts-with-catalog-data-source.js';
import { getManualPolicy, isManualPolicyId, manualPoliciesAvailable, manualPolicyIdStart, manualPolicyLineIdStart, manualPolicyProps } from './manual-policy-reads.js';

const migrations = [{ id: 'manual_accounting_policy', sql: `
  CREATE SEQUENCE tuvansa.manual_policy_ids START WITH ${manualPolicyIdStart} MAXVALUE ${manualPolicyIdStart + 99999998};
  CREATE SEQUENCE tuvansa.manual_policy_line_ids START WITH ${manualPolicyLineIdStart} MAXVALUE ${manualPolicyLineIdStart + 99999998};
  CREATE TABLE tuvansa.manual_accounting_policies (
    id bigint PRIMARY KEY,number varchar(11) UNIQUE NOT NULL,company_id integer NOT NULL CHECK (company_id=1),
    date date NOT NULL,concept varchar(90) NOT NULL,beneficiary varchar(85) NOT NULL,family varchar(20) NOT NULL,
    revision integer NOT NULL CHECK(revision>0),applied boolean NOT NULL,canceled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CHECK (NOT applied OR canceled_at IS NULL)
  );
  CREATE TABLE tuvansa.manual_accounting_policy_lines (
    id bigint PRIMARY KEY DEFAULT nextval('tuvansa.manual_policy_line_ids'),policy_id bigint NOT NULL REFERENCES tuvansa.manual_accounting_policies(id),
    position integer NOT NULL,account_id bigint NOT NULL,account_type integer NOT NULL,account jsonb NOT NULL,parents jsonb NOT NULL,
    cost_center integer NOT NULL,debit numeric(18,2) NOT NULL,credit numeric(18,2) NOT NULL,reference varchar(45) NOT NULL,
    UNIQUE(policy_id,position),CHECK ((debit>0 AND credit=0) OR (credit>0 AND debit=0))
  );
  CREATE INDEX manual_accounting_policy_lines_account ON tuvansa.manual_accounting_policy_lines(account_id,policy_id);
  CREATE TABLE tuvansa.manual_accounting_policy_changes (
    policy_id bigint NOT NULL REFERENCES tuvansa.manual_accounting_policies(id),revision integer NOT NULL,request_key uuid NOT NULL UNIQUE,
    fingerprint char(64) NOT NULL,action text NOT NULL CHECK (action IN ('create','change','apply','unapply','cancel')),
    result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(policy_id,revision)
  );
` }, { id: 'manual_accounting_policy_comments', sql: `
  ALTER TABLE tuvansa.manual_accounting_policies ADD COLUMN comment_metadata jsonb
    CHECK (comment_metadata IS NULL OR jsonb_typeof(comment_metadata)='object');
  ALTER TABLE tuvansa.manual_accounting_policy_changes DROP CONSTRAINT manual_accounting_policy_changes_action_check,
    ADD CONSTRAINT manual_accounting_policy_changes_action_check
      CHECK (action IN ('create','change','apply','unapply','cancel','comments'));
` }, { id: 'manual_accounting_policy_bank_review_transfer', sql: `
  ALTER TABLE tuvansa.manual_accounting_policy_lines ADD COLUMN bank_movement_type varchar(6),
    ADD COLUMN bank_source_movement_id bigint;
` }, { id: 'manual_accounting_policy_liabilities', sql: `
  CREATE SEQUENCE tuvansa.manual_policy_liability_reversal_ids START WITH 7990500000000 MAXVALUE 7990599999999;
  CREATE TABLE tuvansa.manual_policy_liabilities (
    policy_id bigint PRIMARY KEY REFERENCES tuvansa.manual_accounting_policies(id),
    source_policy_id bigint NOT NULL, company_id integer NOT NULL CHECK(company_id=1),
    number varchar(11) NOT NULL UNIQUE,supplier_id bigint NOT NULL,supplier_code varchar(12) NOT NULL,supplier_name text NOT NULL,
    supplier_account varchar(16) NOT NULL,reference varchar(20) NOT NULL,due_date date NOT NULL,
    amount numeric(18,2) NOT NULL CHECK(amount>0),tax numeric(18,2) NOT NULL CHECK(tax>=0),
    subtotal numeric(18,2) NOT NULL CHECK(subtotal>=0),currency smallint NOT NULL CHECK(currency IN(1,2)),
    exchange_rate numeric(18,8) NOT NULL CHECK(exchange_rate>0),user_id integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),cancelled_at timestamptz,reversal_id bigint UNIQUE,
    CHECK(subtotal+tax=amount),CHECK((reversal_id IS NULL)=(cancelled_at IS NULL))
  );
  CREATE UNIQUE INDEX manual_policy_liabilities_active_reference
    ON tuvansa.manual_policy_liabilities(company_id,supplier_id,lower(reference)) WHERE cancelled_at IS NULL;
` }];

const unavailable = () => new ApplicationError('No fue posible consultar o guardar la póliza en PostgreSQL.', 'MANUAL_POLICY_POSTGRES_UNAVAILABLE', 503);

async function replay(client: PostgresClient, key: string, fingerprint: string) {
  const { rows: [previous] } = await client.query<{ fingerprint: string; result: AccountingPolicyProps }>(
    'SELECT fingerprint,result FROM tuvansa.manual_accounting_policy_changes WHERE request_key=$1', [key],
  );
  if (previous && previous.fingerprint !== fingerprint) throw new ConflictError('La solicitud ya se usó con otros datos.', 'MANUAL_POLICY_REQUEST_CONFLICT');
  return previous?.result ?? null;
}

async function lockAccounts(client: PostgresClient, lines: ManualPolicyLine[]) {
  const ids = [...new Set(lines.flatMap(({ account, parents }) => [account.id, ...parents.map(({ id }) => id)]))].sort((a, b) => a - b);
  for (const id of ids) await client.query("SELECT pg_advisory_xact_lock(hashtextextended('bank-reconciliation:1:'||$1::text,0))", [id]);
}

async function insertLines(client: PostgresClient, id: number, lines: ManualPolicyLine[]) {
  await client.query(
    `INSERT INTO tuvansa.manual_accounting_policy_lines(id,policy_id,position,account_id,account_type,account,parents,cost_center,debit,credit,reference,
       bank_movement_type,bank_source_movement_id)
     SELECT coalesce((line->>'historicalMovementId')::bigint,nextval('tuvansa.manual_policy_line_ids')),
       $1,(ordinality)::int,(line #>> '{account,id}')::bigint,(line #>> '{account,type}')::int,line->'account',line->'parents',
       (line->>'costCenter')::int,(line->>'debit')::numeric,(line->>'credit')::numeric,line->>'reference',
       line->>'bankMovementType',(line->>'bankSourceMovementId')::bigint
     FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY parts(line,ordinality)`, [id, JSON.stringify(lines)],
  );
}

export class PostgresManualPolicies implements ManualPolicyDataSource, PolicyLiabilityStorage {
  private migration?: Promise<void>;
  constructor(private readonly connect: PostgresConnectionFactory = connectPostgres, private readonly configured = postgresConfigured,
    private readonly bankCatalog?: Pick<BankAccountsWithCatalogDataSource, 'lookupOn'>) {}

  writable() { return this.configured(); }

  private async withClient<T>(work: (client: PostgresClient) => Promise<T>) {
    if (!this.writable()) throw unavailable();
    let client: PostgresClient | undefined;
    try { client = await this.connect(); return await work(client); }
    catch (error) { if (error instanceof ApplicationError) throw error; throw unavailable(); }
    finally { client?.release(); }
  }

  find(id: number) {
    if (!isManualPolicyId(id) || !this.writable()) return Promise.resolve(null);
    return this.withClient(async (client) => await manualPoliciesAvailable(client) ? getManualPolicy(client, id) : null);
  }

  findRequest(key: string, fingerprint: string) {
    return this.withClient(async (client) => await manualPoliciesAvailable(client) ? replay(client, key, fingerprint) : null);
  }

  hasLiability(id: number) {
    if (!this.writable() || !isManualPolicyId(id)) return Promise.resolve(false);
    return this.withClient(async (client) => {
      const { rows: [table] } = await client.query<{ available: boolean }>(
        "SELECT to_regclass('tuvansa.manual_policy_liabilities') IS NOT NULL AS available",
      );
      if (!table?.available) return false;
      const { rows } = await client.query('SELECT 1 FROM tuvansa.manual_policy_liabilities WHERE policy_id=$1', [id]);
      return rows.length > 0;
    });
  }

  historicalApplied(id: number) {
    if (!this.writable()) return Promise.resolve(false);
    return this.withClient(async (client) => {
      if (!await manualPoliciesAvailable(client)) return false;
      const { rows } = await client.query('SELECT 1 FROM tuvansa.manual_accounting_policies WHERE id=$1 AND applied', [id]);
      return rows.length > 0;
    });
  }

  private async transaction(key: string, fingerprint: string, action: string, work: (client: PostgresClient) => Promise<number>,
    present = manualPolicyProps) {
    this.migration ??= this.withClient((client) => migratePostgres(client, migrations)).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    return this.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('manual-policy-request:'||$1,0))", [key]);
        const existing = await replay(client, key, fingerprint);
        if (existing) {
          await client.query('COMMIT');
          return existing;
        }
        const id = await work(client);
        const policy = (await getManualPolicy(client, id))!;
        const result = present(policy);
        await client.query(
          `INSERT INTO tuvansa.manual_accounting_policy_changes(policy_id,revision,request_key,fingerprint,action,result)
           VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [id, policy.revision, key, fingerprint, action, JSON.stringify(result)],
        );
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  applyHistorical(policy: AccountingPolicyProps & { date: string }, requestKey: string, lines: ManualPolicyLine[],
    fingerprint: string, verify: (lookup?: BankAccountLookup) => Promise<void>) {
    return this.transaction(requestKey, fingerprint, 'apply', async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('historical-policy:'||$1::text,0))", [policy.id]);
      const { rows } = await client.query('SELECT 1 FROM tuvansa.manual_accounting_policies WHERE id=$1', [policy.id]);
      if (rows.length) throw new ConflictError('La póliza ya está aplicada.', 'MANUAL_POLICY_BLOCKED');
      await lockAccounts(client, lines);
      await verify(this.bankCatalog?.lookupOn(client));
      await client.query(`INSERT INTO tuvansa.manual_accounting_policies(id,number,company_id,date,concept,beneficiary,family,revision,applied)
        VALUES($1,$2,1,$3,$4,$5,$6,1,true)`, [policy.id, policy.number, policy.date, policy.concept, policy.beneficiary, policy.family]);
      await insertLines(client, policy.id, lines);
      return policy.id;
    }, () => ({ ...policy, applied: true }));
  }

  create(input: ManualPolicyInput, lines: ManualPolicyLine[], fingerprint: string, verify: (lookup?: BankAccountLookup) => Promise<void>,
    source?: { id: number; revision: number },
    posting?: { origin: string; record: (client: PostgresClient, policy: { id: number; number: string }) => Promise<void> }) {
    return this.transaction(input.requestKey, fingerprint, 'create', async (client) => {
      if (source) {
        // Lock the original before its accounts, as in the edit and cancellation paths.
        const { rows } = await client.query(`SELECT id FROM tuvansa.manual_accounting_policies
          WHERE company_id=1 AND id=$1 AND revision=$2 AND canceled_at IS NULL FOR UPDATE`, [source.id, source.revision]);
        if (!rows.length) throw new ConflictError('La póliza original cambió. Vuelve a abrir Duplicar.', 'MANUAL_POLICY_REVISION_CHANGED');
      }
      await lockAccounts(client, lines);
      if (source && posting?.origin === 'DUPPAS' && (await getManualPolicy(client, source.id))?.reconciled) {
        throw new ConflictError('La póliza original contiene una partida conciliada.', 'POLICY_LIABILITY_REVISION_CHANGED');
      }
      await verify(this.bankCatalog?.lookupOn(client));
      const { rows: [row] } = await client.query<{ id: string }>("SELECT nextval('tuvansa.manual_policy_ids') AS id");
      const id = Number(row!.id);
      const number = `3JW${String(id - manualPolicyIdStart + 1).padStart(8, '0')}`;
      await client.query(`INSERT INTO tuvansa.manual_accounting_policies(id,number,company_id,date,concept,beneficiary,family,revision,applied,comment_metadata)
        VALUES($1,$2,1,$3,$4,$5,$6,1,true,$7::jsonb)`, [id, number, input.date, input.concept, input.beneficiary, input.family,
        posting ? JSON.stringify({ origin: posting.origin }) : null]);
      await insertLines(client, id, lines);
      await posting?.record(client, { id, number });
      return id;
    });
  }

  createLiability(input: ManualPolicyInput, lines: ManualPolicyLine[], fingerprint: string, verify: (lookup?: BankAccountLookup) => Promise<void>,
    source: { id: number; revision: number } | undefined, charge: PolicyLiabilityCharge) {
    return this.create(input, lines, fingerprint, verify, source, {
      origin: 'DUPPAS',
      record: async (client, { id, number }) => {
        const { supplier, sourceId, userId, reference, dueDate, amount, tax, subtotal } = charge;
        const { rows } = await client.query(
          `INSERT INTO tuvansa.manual_policy_liabilities
           (policy_id,source_policy_id,company_id,number,supplier_id,supplier_code,supplier_name,supplier_account,
            reference,due_date,amount,tax,subtotal,currency,exchange_rate,user_id)
           VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (company_id,supplier_id,lower(reference)) WHERE cancelled_at IS NULL DO NOTHING
           RETURNING policy_id`,
          [id, sourceId, `PVW${number.slice(-8)}`, supplier.id, supplier.code, supplier.name, supplier.accountCode,
            reference, dueDate, amount, tax, subtotal, supplier.currency, supplier.exchangeRate, userId],
        );
        if (!rows.length) throw new ConflictError('El proveedor ya tiene un pasivo vigente con esa referencia.', 'POLICY_LIABILITY_REFERENCE_EXISTS');
      },
    });
  }

  private async requireOrdinaryPolicy(client: PostgresClient, id: number) {
    const { rows } = await client.query('SELECT 1 FROM tuvansa.manual_policy_liabilities WHERE policy_id=$1', [id]);
    if (rows.length) throw new ConflictError('La póliza está vinculada a un cargo. Usa Baja para cancelar ambos registros.', 'POLICY_LIABILITY_LINKED');
  }

  private async current(client: PostgresClient, id: number, revision: number, newLines: ManualPolicyLine[] = []) {
    if (!isManualPolicyId(id)) throw new NotFoundError('Póliza de diario capturada en la web');
    await client.query('SELECT id FROM tuvansa.manual_accounting_policies WHERE id=$1 AND company_id=1 FOR UPDATE', [id]);
    const before = await getManualPolicy(client, id);
    if (!before) throw new NotFoundError('Póliza de diario capturada en la web');
    if (before.revision !== revision) throw new ConflictError('La póliza cambió. Vuelve a abrirla.', 'MANUAL_POLICY_REVISION_CHANGED');
    await lockAccounts(client, [...before.lines, ...newLines]);
    return (await getManualPolicy(client, id))!;
  }

  change(id: number, input: ManualPolicyInput & { revision: number }, lines: ManualPolicyLine[], fingerprint: string,
    validate: (current: ManualPolicyDocument) => Promise<void>) {
    return this.transaction(input.requestKey, fingerprint, 'change', async (client) => {
      await validate(await this.current(client, id, input.revision, lines));
      await this.requireOrdinaryPolicy(client, id);
      await client.query('DELETE FROM tuvansa.manual_accounting_policy_lines WHERE policy_id=$1', [id]);
      await insertLines(client, id, lines);
      await client.query(`UPDATE tuvansa.manual_accounting_policies SET date=$2,concept=$3,beneficiary=$4,family=$5,
        revision=revision+1,updated_at=now() WHERE id=$1`, [id, input.date, input.concept, input.beneficiary, input.family]);
      return id;
    });
  }

  changeComments(id: number, input: ManualPolicyCommentsInput, fingerprint: string,
    validate: (current: ManualPolicyDocument) => void) {
    return this.transaction(input.requestKey, fingerprint, 'comments', async (client) => {
      validate(await this.current(client, id, input.revision));
      await this.requireOrdinaryPolicy(client, id);
      const { date, concept, beneficiary, family, ...metadata } = input.fields;
      await client.query(`UPDATE tuvansa.manual_accounting_policies SET date=$2,concept=$3,beneficiary=$4,family=$5,
        comment_metadata=$6::jsonb,revision=revision+1,updated_at=now() WHERE id=$1`,
      [id, date, concept, beneficiary, family, JSON.stringify(metadata)]);
      return id;
    });
  }

  perform(id: number, operation: ManualPolicyOperation, input: ManualPolicyActionInput, fingerprint: string,
    validate: (current: ManualPolicyDocument) => Promise<void>) {
    return this.transaction(input.requestKey, fingerprint, operation, async (client) => {
      const current = await this.current(client, id, input.revision);
      await validate(current);
      if (operation === 'cancel') {
        await client.query(`UPDATE tuvansa.manual_policy_liabilities SET cancelled_at=now(),
          reversal_id=nextval('tuvansa.manual_policy_liability_reversal_ids')
          WHERE policy_id=$1 AND cancelled_at IS NULL`, [id]);
      } else {
        await this.requireOrdinaryPolicy(client, id);
      }
      if (operation !== 'apply') await removeBankTransit(client, 1, current.lines.map((line) => line.id));
      await client.query(`UPDATE tuvansa.manual_accounting_policies SET applied=$2,revision=revision+1,updated_at=now(),
        canceled_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE id=$1`, [id, operation === 'apply', operation === 'cancel']);
      return id;
    });
  }
}
import { removeBankTransit } from '../../../../treasury/banking/infrastructure/datasources/bank-transit-reads.js';
