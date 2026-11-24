import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import {
  connectPostgres, type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type {
  StampingSimulation, StampingSimulationDataSource,
} from '../../domain/datasources/stamping-simulation-data-source.js';
import { remissionCancellationSql, salesRemissionCancellationsAvailable } from './sales-remission-cancellation-reads.js';

// Derivada: registro local de pruebas de la API.
const migrations = [{
  id: 'sales_stamping_simulation',
  sql: `
    CREATE TABLE tuvansa.sales_stamping_simulations (
      remission_id bigint PRIMARY KEY REFERENCES tuvansa.sales_remissions(id) ON DELETE CASCADE,
      reference varchar(22) NOT NULL CHECK (reference LIKE 'SIM-FE-%'),
      simulated_at timestamptz NOT NULL DEFAULT now()
    );
  `,
}];

interface SimulationRow {
  reference: string;
  simulatedAt: Date;
}

const projection = 'reference, simulated_at AS "simulatedAt"';
const toSimulation = ({ reference, simulatedAt }: SimulationRow): StampingSimulation => ({
  mode: 'simulation', reference, simulatedAt: simulatedAt.toISOString(),
});

export class PostgresSalesStampingSimulations implements StampingSimulationDataSource {
  private migration?: Promise<void>;

  constructor(private readonly connect: PostgresConnectionFactory = connectPostgres) {}

  private async withConnection<T>(operation: (client: PostgresClient) => Promise<T>) {
    try {
      const client = await this.connect();
      try {
        return await operation(client);
      } finally {
        client.release();
      }
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('No fue posible consultar o registrar la simulación en PostgreSQL.', 'STAMPING_SIMULATION_STORAGE_UNAVAILABLE', 503);
    }
  }

  find(id: number) {
    return this.withConnection(async (client) => {
      const { rows: [table] } = await client.query<{ present: boolean }>(
        "SELECT to_regclass('tuvansa.sales_stamping_simulations') IS NOT NULL AS present",
      );
      if (!table?.present) return null;

      const { rows: [row] } = await client.query<SimulationRow>(
        `SELECT ${projection} FROM tuvansa.sales_stamping_simulations WHERE remission_id = $1`, [id],
      );
      return row ? toSimulation(row) : null;
    });
  }

  async record(id: number, reference: string) {
    this.migration ??= this.withConnection((client) => migratePostgres(client, migrations)).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    const created = await this.withConnection(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query('SELECT id FROM tuvansa.sales_remissions WHERE id=$1 FOR UPDATE', [id]);
        const cancellation = remissionCancellationSql(await salesRemissionCancellationsAvailable(client));
        const { rows: [active] } = await client.query(
          `SELECT 1 FROM tuvansa.sales_remissions remission ${cancellation.join} WHERE remission.id=$1
             AND NOT (${cancellation.canceled}) AND remission.result #>> '{invoice,cfdStatus}'='0'
             AND remission.result #>> '{invoice,folio}'=''
             AND NOT coalesce((remission.result #>> '{invoice,canceled}')::boolean,false)`, [id],
        );
        if (!active) throw new ApplicationError('Se requiere una remisión FA activa sin timbrado fiscal.', 'STAMPING_SIMULATION_INELIGIBLE', 422);
        const { rows: [row] } = await client.query<SimulationRow>(
          `INSERT INTO tuvansa.sales_stamping_simulations (remission_id, reference)
           VALUES ($1, $2) ON CONFLICT (remission_id) DO NOTHING RETURNING ${projection}`, [id, reference],
        );
        await client.query('COMMIT');
        return row ? toSimulation(row) : null;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
    if (created) return created;

    const previous = await this.find(id);
    if (previous) return previous;
    throw new ApplicationError('La simulación ya no está disponible. Vuelve a abrir la remisión.', 'STAMPING_SIMULATION_CHANGED', 409);
  }
}
