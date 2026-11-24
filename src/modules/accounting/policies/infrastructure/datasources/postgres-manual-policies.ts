import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type {
  ManualPolicyActionInput, ManualPolicyDataSource, ManualPolicyDocument, ManualPolicyInput, ManualPolicyLine, ManualPolicyOperation,
} from '../../domain/datasources/manual-policy-data-source.js';
import type { AccountingPolicyProps } from '../../domain/entities/accounting-policy.js';
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
    `INSERT INTO tuvansa.manual_accounting_policy_lines(policy_id,position,account_id,account_type,account,parents,cost_center,debit,credit,reference)
     SELECT $1,(ordinality)::int,(line #>> '{account,id}')::bigint,(line #>> '{account,type}')::int,line->'account',line->'parents',
       (line->>'costCenter')::int,(line->>'debit')::numeric,(line->>'credit')::numeric,line->>'reference'
     FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY parts(line,ordinality)`, [id, JSON.stringify(lines)],
  );
}

export class PostgresManualPolicies implements ManualPolicyDataSource {
  private migration?: Promise<void>;
  constructor(private readonly connect: PostgresConnectionFactory = connectPostgres, private readonly configured = postgresConfigured) {}

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

  private async transaction(key: string, fingerprint: string, action: string, work: (client: PostgresClient) => Promise<number>) {
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
        const result = manualPolicyProps(policy);
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

  create(input: ManualPolicyInput, lines: ManualPolicyLine[], fingerprint: string, verify: () => Promise<void>,
    source?: { id: number; revision: number }) {
    return this.transaction(input.requestKey, fingerprint, 'create', async (client) => {
      if (source) {
        // Lock the original before its accounts, as in the edit and cancellation paths.
        const { rows } = await client.query(`SELECT id FROM tuvansa.manual_accounting_policies
          WHERE company_id=1 AND id=$1 AND revision=$2 AND canceled_at IS NULL FOR UPDATE`, [source.id, source.revision]);
        if (!rows.length) throw new ConflictError('La póliza original cambió. Vuelve a abrir Duplicar.', 'MANUAL_POLICY_REVISION_CHANGED');
      }
      await lockAccounts(client, lines);
      await verify();
      const { rows: [row] } = await client.query<{ id: string }>("SELECT nextval('tuvansa.manual_policy_ids') AS id");
      const id = Number(row!.id);
      const number = `3JW${String(id - manualPolicyIdStart + 1).padStart(8, '0')}`;
      await client.query(`INSERT INTO tuvansa.manual_accounting_policies(id,number,company_id,date,concept,beneficiary,family,revision,applied)
        VALUES($1,$2,1,$3,$4,$5,$6,1,true)`, [id, number, input.date, input.concept, input.beneficiary, input.family]);
      await insertLines(client, id, lines);
      return id;
    });
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
      await client.query('DELETE FROM tuvansa.manual_accounting_policy_lines WHERE policy_id=$1', [id]);
      await insertLines(client, id, lines);
      await client.query(`UPDATE tuvansa.manual_accounting_policies SET date=$2,concept=$3,beneficiary=$4,family=$5,
        revision=revision+1,updated_at=now() WHERE id=$1`, [id, input.date, input.concept, input.beneficiary, input.family]);
      return id;
    });
  }

  perform(id: number, operation: ManualPolicyOperation, input: ManualPolicyActionInput, fingerprint: string,
    validate: (current: ManualPolicyDocument) => Promise<void>) {
    return this.transaction(input.requestKey, fingerprint, operation, async (client) => {
      await validate(await this.current(client, id, input.revision));
      await client.query(`UPDATE tuvansa.manual_accounting_policies SET applied=$2,revision=revision+1,updated_at=now(),
        canceled_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE id=$1`, [id, operation === 'apply', operation === 'cancel']);
      return id;
    });
  }
}
