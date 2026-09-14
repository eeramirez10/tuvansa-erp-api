import { createHash } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { ClientFiscalDataSource } from '../../domain/datasources/client-fiscal-data-source.js';
import type { CapitalRegime, ClientFiscal, FiscalSaveResult, SaveClientFiscal } from '../../domain/entities/client-fiscal.js';

interface FiscalRow extends RowDataPacket {
  CLISEQ: number; CLICOD: string; CLIRFC: string; CLINOM: string;
  CLICP: string; CLIREGIMEN: string; CLICFDI4CS: number;
}

// Derivada: optimistic-concurrency token, NOT the OMNIS fiscal checksum.
const versionOf = (row: FiscalRow) => createHash('sha256').update(JSON.stringify([
  row.CLISEQ, row.CLICOD, row.CLIRFC, row.CLINOM, row.CLICP, row.CLIREGIMEN, row.CLICFDI4CS,
])).digest('hex');

export const parseCapitalRegimes = (text: string): CapitalRegime[] => {
  const seen = new Set<string>();
  return text.split('||').flatMap((line) => {
    const [rawCode, rawDescription] = line.split('|~|~');
    const code = rawCode?.trim() ?? '';
    const description = rawDescription?.trim() ?? '';
    if (!description || seen.has(code)) return [];
    seen.add(code);
    return [{ code, description }];
  });
};

export class LegacyMysqlClientFiscalDataSource implements ClientFiscalDataSource {
  constructor(private readonly pool: Pool = legacyMysqlPool) {}

  private async read(db: Pool | PoolConnection, clientId: number, lock = false): Promise<FiscalRow | null> {
    // Adaptada: explicit fields from the captured SELECT * WHERE CLISEQ ... LIMIT 1.
    const [rows] = await db.execute<FiscalRow[]>(
      `SELECT CLISEQ, CLICOD, CLIRFC, CLINOM, CLICP, CLIREGIMEN, CLICFDI4CS
       FROM fcli WHERE CLISEQ = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [clientId],
    );
    return rows[0] ?? null;
  }

  private async map(db: Pool | PoolConnection, row: FiscalRow): Promise<ClientFiscal> {
    // Adaptada: captured FYG lookup, narrowed to its payload. Binary preserves legacy bytes.
    const [catalog] = await db.execute<RowDataPacket[]>(
      'SELECT CAST(YGDAT AS BINARY) AS payload FROM fyg WHERE YGKEY = ? LIMIT 1',
      ['REGIMENES_DE_CAPITAL'],
    );
    const payload: unknown = catalog[0]?.payload;
    let text = typeof payload === 'string' ? payload : '';
    if (Buffer.isBuffer(payload)) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(payload); }
      catch { text = new TextDecoder('windows-1252').decode(payload); }
    }
    return {
      clientId: row.CLISEQ, code: row.CLICOD,
      values: { taxId: row.CLIRFC, name: row.CLINOM, postalCode: row.CLICP, fiscalRegime: row.CLIREGIMEN },
      version: versionOf(row), verification: Number(row.CLICFDI4CS) === 0 ? 'pending' : 'legacy-marker-present',
      capitalRegimes: parseCapitalRegimes(text), verificationAvailable: false,
    };
  }

  async find(clientId: number) {
    const row = await this.read(this.pool, clientId);
    return row ? this.map(this.pool, row) : null;
  }

  async save(clientId: number, input: SaveClientFiscal): Promise<FiscalSaveResult> {
    const db = await this.pool.getConnection();
    try {
      await db.beginTransaction();
      const row = await this.read(db, clientId, true);
      if (!row) { await db.rollback(); return { status: 'not-found' }; }
      if (versionOf(row) !== input.expectedVersion) { await db.rollback(); return { status: 'conflict' }; }
      const v = input.values;
      const changed = row.CLIRFC !== v.taxId || row.CLINOM !== v.name
        || row.CLICP !== v.postalCode || row.CLIREGIMEN !== v.fiscalRegime;
      if (changed) {
        // Derivada from captured writes: save edited fields but invalidate the unconfirmed marker.
        // Opening/cancelling is read-only; unchanged saves preserve the existing marker.
        await db.execute(
          'UPDATE fcli SET CLIRFC=?, CLINOM=?, CLICP=?, CLIREGIMEN=?, CLICFDI4CS=0 WHERE CLISEQ=?',
          [v.taxId, v.name, v.postalCode, v.fiscalRegime, clientId],
        );
      }
      const updated = await this.read(db, clientId);
      if (!updated) throw new Error('Client disappeared while locked');
      const data = await this.map(db, updated);
      await db.commit();
      return { status: 'saved', data };
    } catch (error) {
      await db.rollback();
      throw error;
    } finally { db.release(); }
  }
}
