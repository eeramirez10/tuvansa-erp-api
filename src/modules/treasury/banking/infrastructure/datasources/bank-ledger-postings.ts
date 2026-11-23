import type { RowDataPacket } from 'mysql2/promise';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { connectPostgres, postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';

interface MonthPosting {
  month: string;
  charges: number;
  credits: number;
}

interface FiscalWindow extends RowDataPacket {
  from: string;
  to: string;
}

const money = (value: number) => Number(value.toFixed(2));

async function monthlyPostings(client: PostgresClient, accountId: number, window: FiscalWindow) {
  const { rows: [tables] } = await client.query<{ payments: boolean; collections: boolean; transfers: boolean }>(
    `SELECT to_regclass('tuvansa.supplier_payments') IS NOT NULL AS payments,
            to_regclass('tuvansa.customer_collections') IS NOT NULL AS collections,
            to_regclass('tuvansa.bank_transfer_movements') IS NOT NULL
              AND to_regclass('tuvansa.bank_transfers') IS NOT NULL AS transfers`,
  );
  const source: string[] = [];
  if (tables?.payments) source.push('SELECT date,-amount AS amount FROM tuvansa.supplier_payments WHERE company_id=1 AND bank_account_id=$1');
  if (tables?.collections) source.push('SELECT date,amount FROM tuvansa.customer_collections WHERE company_id=1 AND bank_account_id=$1');
  if (tables?.transfers) source.push(
    `SELECT t.date,m.amount FROM tuvansa.bank_transfer_movements m
     JOIN tuvansa.bank_transfers t ON t.id=m.transfer_id AND t.company_id=m.company_id
     WHERE m.company_id=1 AND m.bank_account_id=$1`,
  );
  if (source.length === 0) return [];

  // Derivada. Los movimientos web se suman a los acumulados mensuales del catálogo histórico.
  const { rows } = await client.query<MonthPosting>(
    `WITH postings AS (${source.join(' UNION ALL ')})
     SELECT to_char(date,'YYYY-MM') AS month,
            coalesce(sum(amount) FILTER (WHERE amount > 0),0)::float8 AS charges,
            coalesce(-sum(amount) FILTER (WHERE amount < 0),0)::float8 AS credits
     FROM postings WHERE date BETWEEN $2::date AND $3::date GROUP BY 1 ORDER BY 1`,
    [accountId, window.from, window.to],
  );
  return rows;
}

export async function bankLedgerWithWebPostings(accountId: number, base: Record<string, unknown>[]) {
  const [settings] = await legacyMysqlPool.execute<FiscalWindow[]>(
    'SELECT CIAFI AS `from`, CIAFF AS `to` FROM FCIA WHERE CIASEQ=1 LIMIT 1',
  );
  const [window] = settings;
  if (!window?.from || !window.to) return { items: base, years: [], webPostings: false };
  const firstYear = Number(window.from.slice(0, 4));
  const years = [firstYear, firstYear + 1];
  if (!postgresConfigured()) return { items: base, years, webPostings: false };

  let client: PostgresClient | undefined;
  try {
    client = await connectPostgres();
    const rows = await monthlyPostings(client, accountId, window);
    const monthTotals = new Map(rows.map((row) => [row.month, row]));
    let running = 0;
    const items = base.map((row, index) => {
      const key = `${index < 12 ? years[0] : years[1]}-${String(index % 12 + 1).padStart(2, '0')}`;
      const charges = monthTotals.get(key)?.charges ?? 0;
      const credits = monthTotals.get(key)?.credits ?? 0;
      running = money(running + charges - credits);
      return {
        ...row, charges: money(Number(row.charges ?? 0) + charges), credits: money(Number(row.credits ?? 0) + credits),
        balance: money(Number(row.balance ?? 0) + running),
      };
    });
    return { items, years, webPostings: rows.length > 0 };
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError('No fue posible consultar los movimientos web del Mayor.', 'BANK_LEDGER_UNAVAILABLE', 503);
  } finally {
    client?.release();
  }
}
