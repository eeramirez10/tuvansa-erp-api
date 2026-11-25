import { createHash } from 'node:crypto';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import {
  connectPostgres, postgresConfigured, postgresUnavailable, type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import {
  supplierGroupingMovementsOn, type SupplierGroupingMovement,
} from '../../../../../shared/infrastructure/datasources/supplier-balance-grouping-reads.js';
import { lockPurchaseReceptionPieces } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-reception-piece-reads.js';
import { historicalReceptionCancellationsOn } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/historical-purchase-reception-cancellation-reads.js';
import { purchaseReceptionDocumentationsOn } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-reception-documentation-reads.js';
import { receiptSupplierChangesOn } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-reception-supplier-change-reads.js';
import type {
  SupplierBalanceGroupingDataSource, SupplierBalanceGroupingInput, SupplierBalanceGroupingResult,
} from '../../domain/datasources/supplier-balance-grouping-data-source.js';
import { assertActiveSupplierCatalog } from './postgres-supplier-catalog-data-source.js';
import { readHistoricalSupplierBalances, type HistoricalSupplierBalance } from './mysql-historical-supplier-balances.js';

const migrations = [{ id: 'supplier_balance_grouping', sql: `
  CREATE TABLE tuvansa.supplier_balance_groupings (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id integer NOT NULL CHECK(company_id=1),
    supplier_id bigint NOT NULL CHECK(supplier_id>0),
    request_key uuid NOT NULL,
    fingerprint char(64) NOT NULL,
    date date NOT NULL,
    result jsonb NOT NULL,
    UNIQUE(company_id,request_key)
  );
  CREATE SEQUENCE tuvansa.supplier_balance_grouping_movement_ids
    START WITH 8020000000000 INCREMENT BY 2 MAXVALUE 8020999999998;
  CREATE TABLE tuvansa.supplier_balance_grouping_transfers (
    id bigint PRIMARY KEY DEFAULT nextval('tuvansa.supplier_balance_grouping_movement_ids'),
    grouping_id bigint NOT NULL REFERENCES tuvansa.supplier_balance_groupings(id),
    target_id bigint NOT NULL CHECK(target_id>0),
    target_number text NOT NULL CHECK(target_number<>''),
    source_id bigint NOT NULL CHECK(source_id>0),
    source_number text NOT NULL CHECK(source_number<>''),
    amount numeric(18,2) NOT NULL CHECK(amount>0),
    CHECK(target_id<>source_id),
    UNIQUE(grouping_id,source_id)
  );
  CREATE INDEX supplier_balance_groups_supplier ON tuvansa.supplier_balance_groupings(supplier_id);
  CREATE INDEX supplier_balance_groups_source ON tuvansa.supplier_balance_grouping_transfers(source_id);
  CREATE INDEX supplier_balance_groups_target ON tuvansa.supplier_balance_grouping_transfers(target_id);
` }];

const companyId = 1;
const cents = (amount: number) => Math.round(amount * 100);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dateInMexico = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Mexico_City' });
const conflict = (message: string) => new ConflictError(message, 'SUPPLIER_GROUPING_STALE');

export function supplierGroupingPosition(row: Record<string, unknown>, movements: SupplierGroupingMovement[]) {
  const { id, company, document, date, amount, originalAmount, currency, exchangeRate, groupingStatus } = row;
  if (company !== companyId || currency !== 1 || exchangeRate !== 1
    || typeof id !== 'number' || typeof document !== 'string' || !document.trim()
    || typeof amount !== 'number' || !Number.isSafeInteger(cents(amount)) || amount <= 0) return null;
  const legs = movements.filter((leg) => leg.receiptId === id && leg.document === document);
  const outstanding = legs.reduce((total, leg) => total + cents(leg.amount), cents(amount));
  if (!Number.isSafeInteger(outstanding) || outstanding < 0) return null;
  const revision = hash([id, document, date, amount, originalAmount, groupingStatus, legs.map(({ id }) => id)]);
  return { id, document, outstanding, revision };
}

export function supplierGroupingBalanceItems(
  items: Array<Record<string, unknown>>, movements: SupplierGroupingMovement[], configured: boolean,
) {
  return items.flatMap((row) => {
    const { groupingStatus, activeSupplier, ...visible } = row;
    const position = supplierGroupingPosition({ ...visible, groupingStatus }, movements);
    if (position?.outstanding === 0) return [];
    return [position ? { ...visible, amount: position.outstanding / 100,
      ...(configured && activeSupplier === 1 ? { groupingRevision: position.revision } : {}) } : visible];
  });
}

export function supplierGroupingMovementRows(movements: SupplierGroupingMovement[]) {
  return movements.map((movement) => ({
    ...movement, company: companyId, movementType: 'AT', currency: 1, exchangeRate: 1,
    exchangeDifference: 0, policy: '', documentReference: '', userId: 0,
  }));
}

type HistoricalReader = (supplierId: number, ids: number[]) => Promise<HistoricalSupplierBalance[]>;

export class PostgresSupplierBalanceGrouping implements SupplierBalanceGroupingDataSource {
  private migration?: Promise<void>;

  constructor(
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured = postgresConfigured,
    private readonly historical: HistoricalReader = readHistoricalSupplierBalances,
    private readonly date = () => dateInMexico.format(new Date()),
  ) {}

  async save(supplierId: number, input: SupplierBalanceGroupingInput) {
    if (!this.configured()) throw postgresUnavailable();
    this.migration ??= this.migrate().catch((error) => { delete this.migration; throw error; });
    await this.migration;
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      try {
        const result = await this.saveOn(client, supplierId, input);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    } finally { client.release(); }
  }

  private async migrate() {
    const client = await this.connect();
    try { await migratePostgres(client, migrations); }
    finally { client.release(); }
  }

  private async saveOn(client: PostgresClient, supplierId: number, { requestKey, target, sources }: SupplierBalanceGroupingInput) {
    const fingerprint = hash([supplierId, target, sources]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('supplier-balance-grouping:' || $1::text,0))", [requestKey]);
    const { rows: [saved] } = await client.query<{ fingerprint: string; result: SupplierBalanceGroupingResult }>(
      'SELECT fingerprint,result FROM tuvansa.supplier_balance_groupings WHERE company_id=$1 AND request_key=$2', [companyId, requestKey],
    );
    if (saved) {
      if (saved.fingerprint !== fingerprint) throw new ConflictError(
        'La solicitud de agrupación ya se usó con otros datos.', 'SUPPLIER_GROUPING_REQUEST_CONFLICT',
      );
      return saved.result;
    }
    const ids = [target.id, ...sources.map(({ id }) => id)].sort((a, b) => a - b);
    for (const id of ids) await lockPurchaseReceptionPieces(client, companyId, id);
    await assertActiveSupplierCatalog(client, supplierId);
    const [rows, movements, cancellations, documentations, changes] = await Promise.all([
      this.historical(supplierId, ids), supplierGroupingMovementsOn(client, { documentIds: ids }),
      historicalReceptionCancellationsOn(client, { receiptIds: ids }),
      purchaseReceptionDocumentationsOn(client, { sourceIds: ids }), receiptSupplierChangesOn(client, { receiptIds: ids }),
    ]);
    if (cancellations.length || documentations.length || changes.some((change) => change.historical)) {
      throw conflict('Un documento seleccionado ya fue cancelado, documentado o cambió de proveedor.');
    }
    const positions = new Map(rows.filter(({ activeSupplier }) => activeSupplier === 1)
      .map((row) => [row.id, supplierGroupingPosition({ ...row }, movements)]));
    const current = [target, ...sources].map(({ id, revision }) => {
      const position = positions.get(id);
      if (!position || position.outstanding === 0 || position.revision !== revision) {
        throw conflict('El saldo de un documento cambió. Vuelve a consultar los documentos.');
      }
      return position;
    });
    const [destination, ...origins] = current;
    const amount = origins.reduce((sum, { outstanding }) => sum + outstanding, 0);
    const remaining = destination!.outstanding + amount;
    if (!Number.isSafeInteger(remaining)) throw conflict('El saldo agrupado excede el importe admitido.');
    const result = {
      targetId: target.id, sourceIds: origins.map(({ id }) => id), amount: amount / 100,
      remaining: remaining / 100, date: this.date(),
    };
    const { rows: [group] } = await client.query<{ id: string }>(
      `INSERT INTO tuvansa.supplier_balance_groupings(company_id,supplier_id,request_key,fingerprint,date,result)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`, [companyId, supplierId, requestKey, fingerprint, result.date, JSON.stringify(result)],
    );
    for (const origin of origins) {
      await client.query(
        `INSERT INTO tuvansa.supplier_balance_grouping_transfers(grouping_id,target_id,target_number,source_id,source_number,amount)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [group!.id, target.id, destination!.document, origin.id, origin.document, origin.outstanding / 100],
      );
    }
    return result;
  }
}
