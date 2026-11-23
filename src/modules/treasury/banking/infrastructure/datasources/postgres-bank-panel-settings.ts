import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import {
  connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type {
  BankPanelSetting, BankPanelSettingKey, BankPanelSettingsDataSource,
} from '../../domain/datasources/bank-panel-settings-data-source.js';

const migrations = [{
  id: 'bank_panel_settings',
  sql: `
    CREATE TABLE tuvansa.bank_panel_settings (
      bank_account_id bigint NOT NULL,
      action text NOT NULL CHECK (action IN ('classifiers','budget','review')),
      scope text NOT NULL,
      revision integer NOT NULL CHECK (revision > 0),
      document jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (bank_account_id,action,scope)
    );
  `,
}];

const unavailable = () => new ApplicationError(
  'No fue posible consultar o guardar la configuración de Bancos en PostgreSQL.', 'BANK_PANEL_SETTINGS_UNAVAILABLE', 503,
);

export class PostgresBankPanelSettings implements BankPanelSettingsDataSource {
  private migration?: Promise<void>;

  constructor(
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured = postgresConfigured,
  ) {}

  writable() { return this.configured(); }

  private async withClient<T>(work: (client: PostgresClient) => Promise<T>) {
    let client: PostgresClient | undefined;
    try {
      client = await this.connect();
      return await work(client);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw unavailable();
    } finally {
      client?.release();
    }
  }

  private async readRecord<T>(client: PostgresClient, key: BankPanelSettingKey) {
    const { rows: [record] } = await client.query<BankPanelSetting<T>>(
      'SELECT revision, document AS values FROM tuvansa.bank_panel_settings WHERE bank_account_id=$1 AND action=$2 AND scope=$3',
      [key.accountId, key.action, key.scope],
    );
    return record ?? null;
  }

  read<T>(key: BankPanelSettingKey): Promise<BankPanelSetting<T> | null> {
    if (!this.writable()) return Promise.resolve(null);
    return this.withClient(async (client) => {
      const { rows: [table] } = await client.query<{ present: boolean }>(
        "SELECT to_regclass('tuvansa.bank_panel_settings') IS NOT NULL AS present",
      );
      return table?.present ? this.readRecord<T>(client, key) : null;
    });
  }

  async save<T>(key: BankPanelSettingKey, revision: number, values: T) {
    if (!this.writable()) throw unavailable();
    this.migration ??= this.withClient((client) => migratePostgres(client, migrations)).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    const encoded = JSON.stringify(values);
    const parameters = [key.accountId, key.action, key.scope];
    return this.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('bank-panel:' || $1::text || ':' || $2::text || ':' || $3::text,0))",
          parameters,
        );
        const existing = await this.readRecord<T>(client, key);
        const current = existing?.revision ?? 0;
        if (current !== revision && (!existing || JSON.stringify(existing.values) !== encoded)) {
          throw new ConflictError('La configuración cambió. Vuelve a abrir la ventana.', 'BANK_PANEL_SETTINGS_REVISION_CHANGED');
        }
        if (existing && JSON.stringify(existing.values) === encoded) {
          await client.query('COMMIT');
          return existing;
        }
        await client.query(
          `INSERT INTO tuvansa.bank_panel_settings (bank_account_id,action,scope,document,revision)
           VALUES ($1,$2,$3,$4::jsonb,$5)
           ON CONFLICT (bank_account_id,action,scope) DO UPDATE
           SET document=excluded.document,revision=excluded.revision,updated_at=now()`,
          [...parameters, encoded, current + 1],
        );
        await client.query('COMMIT');
        return { revision: current + 1, values };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }
}
