import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import {
  connectPostgres, postgresConfigured, postgresUnavailable, type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type {
  PolicyClassificationIdentity, PolicyClassificationsStorage, PolicyClassificationUpdate, SavedPolicyClassification,
} from '../../domain/datasources/policy-classifications-storage.js';
import { isManualPolicyId } from './manual-policy-reads.js';

// Derivada. El historial por folio permite recuperar una escritura confirmada por su UUID.
const migrations = [{
  id: 'accounting_policy_classifications',
  sql: `CREATE TABLE tuvansa.accounting_policy_classifications (
    policy_id bigint NOT NULL,
    policy_number text NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    composite_code varchar(4) NOT NULL CHECK (composite_code <> ''),
    request_key uuid NOT NULL,
    saved_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (policy_id,policy_number,revision),
    UNIQUE (policy_id,policy_number,request_key)
  );`,
}];

const fields = 'policy_id::float8 AS id, policy_number AS number, revision, composite_code AS "compositeCode"';

export class PostgresPolicyClassifications implements PolicyClassificationsStorage {
  private migration?: Promise<void>;

  constructor(
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured = postgresConfigured,
  ) {}

  writable() { return this.configured(); }

  private async withClient<T>(work: (client: PostgresClient) => Promise<T>): Promise<T> {
    let client: PostgresClient | undefined;
    try {
      client = await this.connect();
      return await work(client);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('No fue posible consultar o guardar los clasificadores de la póliza.',
        'POLICY_CLASSIFICATIONS_UNAVAILABLE', 503);
    } finally { client?.release(); }
  }

  async find(policies: PolicyClassificationIdentity[]) {
    if (!this.writable() || policies.length === 0) return [];
    return this.withClient(async (client) => {
      const { rows: [table] } = await client.query<{ present: boolean }>(
        "SELECT to_regclass('tuvansa.accounting_policy_classifications') IS NOT NULL AS present",
      );
      if (!table?.present) return [];
      const { rows } = await client.query<SavedPolicyClassification>(
        `SELECT DISTINCT ON (policy_id,policy_number) ${fields}
         FROM tuvansa.accounting_policy_classifications
         WHERE (policy_id,policy_number) IN (SELECT * FROM unnest($1::bigint[], $2::text[]))
         ORDER BY policy_id,policy_number,revision DESC`,
        [policies.map(({ id }) => id), policies.map(({ number }) => number)],
      );
      return rows;
    });
  }

  async save(policy: PolicyClassificationIdentity, input: PolicyClassificationUpdate) {
    if (!this.writable()) throw postgresUnavailable();
    this.migration ??= this.withClient((client) => migratePostgres(client, migrations)).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    return this.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const saved = await this.saveLocked(client, policy, input);
        await client.query('COMMIT');
        return saved;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  private async saveLocked(client: PostgresClient, policy: PolicyClassificationIdentity, input: PolicyClassificationUpdate) {
    const identity = [policy.id, policy.number];
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('policy-classification:' || $1::text,0))", [policy.id]);
    const { rows: [replay] } = await client.query<SavedPolicyClassification>(
      `SELECT ${fields} FROM tuvansa.accounting_policy_classifications
       WHERE policy_id=$1 AND policy_number=$2 AND request_key=$3`, [...identity, input.requestKey],
    );
    if (replay) {
      if (replay.compositeCode === input.compositeCode && replay.revision === input.revision + 1) return replay;
      throw new ConflictError('La clave del guardado ya se usó para otra clasificación.', 'POLICY_CLASSIFICATION_REQUEST_REUSED');
    }

    if (isManualPolicyId(policy.id)) {
      const { rows: [manual] } = await client.query<{ active: boolean }>(
        'SELECT canceled_at IS NULL AS active FROM tuvansa.manual_accounting_policies WHERE id=$1 AND number=$2 FOR UPDATE',
        identity,
      );
      if (!manual?.active) throw new ConflictError('La póliza está dada de baja.', 'POLICY_CLASSIFICATION_INACTIVE');
    }

    const { rows: [last] } = await client.query<{ revision: number }>(
      `SELECT revision FROM tuvansa.accounting_policy_classifications
       WHERE policy_id=$1 AND policy_number=$2 ORDER BY revision DESC LIMIT 1`, identity,
    );
    if ((last?.revision ?? 0) !== input.revision) {
      throw new ConflictError('La clasificación cambió. Vuelve a abrir la ventana.', 'POLICY_CLASSIFICATION_STALE');
    }
    const { rows: [saved] } = await client.query<SavedPolicyClassification>(
      `INSERT INTO tuvansa.accounting_policy_classifications(policy_id,policy_number,revision,composite_code,request_key)
       VALUES ($1,$2,$3,$4,$5) RETURNING ${fields}`,
      [...identity, input.revision + 1, input.compositeCode, input.requestKey],
    );
    return saved!;
  }
}
