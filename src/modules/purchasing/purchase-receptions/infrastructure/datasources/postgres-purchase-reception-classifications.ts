import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import {
  connectPostgres, postgresConfigured, postgresUnavailable, type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type {
  PurchaseReceptionClassificationPanel, PurchaseReceptionClassificationsDataSource, PurchaseReceptionClassificationUpdate,
} from '../../domain/datasources/purchase-reception-classifications-data-source.js';
import type { PurchaseReceptionProps } from '../../domain/entities/purchase-reception.js';
import type { LegacyMysqlPurchaseReceptionsDataSource } from './legacy-mysql-purchase-receptions-data-source.js';
import { readLocalReceptionOn } from './local-purchase-reception-view.js';
import { isLocalPurchaseExpenseDocumentId } from './postgres-purchase-expenses.js';
import {
  purchaseReceptionCommentsMigrations, readReceiptTransport, saveReceiptTransport,
} from './postgres-purchase-reception-comments.js';
import { isLocalPurchaseReceptionId } from './postgres-purchase-reception-writes.js';
import { lockPurchaseReceptionPieces } from './purchase-reception-piece-reads.js';

const companyId = 1;
const transportPosition = 6;
const migrations = [...purchaseReceptionCommentsMigrations, { id: 'purchase_reception_classifications', sql: `
  CREATE TABLE tuvansa.purchase_reception_classifications (
    company_id integer NOT NULL CHECK(company_id=1),
    receipt_id bigint NOT NULL,
    receipt_number varchar(15) NOT NULL,
    original_supplier_id bigint NOT NULL,
    overrides jsonb NOT NULL CHECK(jsonb_typeof(overrides)='array' AND jsonb_array_length(overrides)=9),
    revision integer NOT NULL CHECK(revision>0),
    PRIMARY KEY(company_id,receipt_id)
  );
` }];

type Identity = Pick<PurchaseReceptionProps, 'id' | 'number' | 'supplier'>;
type StoredClassifications = {
  number: string;
  supplierId: number;
  overrides: Array<string | null>;
  revision: number;
};

async function classificationsOn(client: PostgresClient, id: number) {
  const { rows: [table] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.purchase_reception_classifications') IS NOT NULL AS available",
  );
  if (!table?.available) return undefined;
  const { rows: [saved] } = await client.query<StoredClassifications>(
    `SELECT receipt_number AS number,original_supplier_id::float8 AS "supplierId",overrides,revision
     FROM tuvansa.purchase_reception_classifications WHERE company_id=$1 AND receipt_id=$2`, [companyId, id],
  );
  return saved;
}

function matches(saved: StoredClassifications | undefined, receipt: Identity): saved is StoredClassifications {
  return saved?.number === receipt.number && saved.supplierId === receipt.supplier.id;
}

function effectiveClassifications(receipt: PurchaseReceptionProps, overrides?: Array<string | null>) {
  return Array.from({ length: 9 }, (_, index) => overrides?.[index] ?? receipt.classifications[index] ?? '');
}

export async function withReceiptClassifications(receipt: PurchaseReceptionProps): Promise<PurchaseReceptionProps> {
  if (!postgresConfigured()) return receipt;
  const client = await connectPostgres();
  try {
    const saved = await classificationsOn(client, receipt.id);
    return matches(saved, receipt) ? { ...receipt, classifications: effectiveClassifications(receipt, saved.overrides) } : receipt;
  } finally {
    client.release();
  }
}

export class PostgresPurchaseReceptionClassifications implements PurchaseReceptionClassificationsDataSource {
  private migration?: Promise<void>;

  constructor(
    private readonly legacy: Pick<LegacyMysqlPurchaseReceptionsDataSource, 'findById' | 'classificationCatalog'>,
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured = postgresConfigured,
  ) {}

  private async using<T>(work: (client: PostgresClient) => Promise<T>) {
    const client = await this.connect();
    try { return await work(client); }
    finally { client.release(); }
  }

  private async receipt(id: number, client?: PostgresClient) {
    if (isLocalPurchaseReceptionId(id) || isLocalPurchaseExpenseDocumentId(id)) {
      return client ? readLocalReceptionOn(client, companyId, id) : null;
    }
    return (await this.legacy.findById(id))?.toPrimitives() ?? null;
  }

  private async context(id: number, client?: PostgresClient) {
    const receipt = await this.receipt(id, client);
    if (!receipt) return null;
    const [saved, transport, catalog] = await Promise.all([
      client ? classificationsOn(client, id) : undefined,
      client ? readReceiptTransport(client, companyId, receipt) : undefined,
      this.legacy.classificationCatalog(),
    ]);
    const matching = matches(saved, receipt);
    const overrides = matching ? saved.overrides : undefined;
    const current = effectiveClassifications(receipt, overrides);
    current[transportPosition] = transport?.code ?? current[transportPosition]!;
    const sequence = matching ? saved.revision : 0;
    const canWrite = Boolean(client && (!saved || matching) && transport?.canWrite);
    const panel: PurchaseReceptionClassificationPanel = {
      purchaseReception: { id, number: receipt.number }, key: 'classifications', section: 'actions',
      button: 'Clasificar', source: matching || transport?.code !== undefined || isLocalPurchaseReceptionId(id)
        || isLocalPurchaseExpenseDocumentId(id) ? 'postgres' : 'mysql',
      items: catalog.items,
      summary: { current, labels: catalog.labels, revision: this.revision(receipt, current, sequence), canWrite },
    };
    return { receipt, overrides, sequence, panel };
  }

  private revision(receipt: Identity, current: string[], sequence: number) {
    return createHash('sha256').update(JSON.stringify([receipt.id, receipt.number, receipt.supplier.id, current, sequence])).digest('hex');
  }

  async read(id: number) {
    const context = this.configured() ? await this.using((client) => this.context(id, client)) : await this.context(id);
    return context?.panel ?? null;
  }

  async save(id: number, update: PurchaseReceptionClassificationUpdate): Promise<PurchaseReceptionClassificationPanel> {
    if (!this.configured()) throw postgresUnavailable();
    this.migration ??= this.using((client) => migratePostgres(client, migrations)).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;

    return this.using(async (client) => {
      await client.query('BEGIN');
      try {
        await lockPurchaseReceptionPieces(client, companyId, id);
        const context = await this.context(id, client);
        if (!context) throw new NotFoundError('Recepción de compra');
        const { receipt, overrides, sequence, panel } = context;
        const { current, revision, canWrite } = panel.summary;
        if (!canWrite || revision !== update.revision) {
          throw new ConflictError('La recepción o sus clasificadores cambiaron. Vuelve a abrir Clasificar.', 'PURCHASE_RECEPTION_CLASSIFICATIONS_STALE');
        }
        const changed = update.current.some((code, index) => code !== current[index]);
        if (changed) {
          update.current.forEach((code, index) => {
            if (code && code !== current[index] && !panel.items.some((item) => item.classifier === index + 1 && item.compositeCode === code)) {
              throw new ApplicationError('Selecciona una opción del catálogo de cada clasificador.', 'PURCHASE_RECEPTION_CLASSIFICATION_INVALID', 422);
            }
          });
          const nextTransport = update.current[transportPosition]!;
          if (nextTransport !== current[transportPosition]) await saveReceiptTransport(client, companyId, receipt, nextTransport);
          const nextOverrides = update.current.map((code, index) =>
            index === transportPosition ? null : code !== current[index] ? code : overrides?.[index] ?? null,
          );
          await client.query(
            `INSERT INTO tuvansa.purchase_reception_classifications(company_id,receipt_id,receipt_number,original_supplier_id,overrides,revision)
             VALUES($1,$2,$3,$4,$5::jsonb,1)
             ON CONFLICT(company_id,receipt_id) DO UPDATE SET
               overrides=excluded.overrides,revision=tuvansa.purchase_reception_classifications.revision+1`,
            [companyId, id, receipt.number, receipt.supplier.id, JSON.stringify(nextOverrides)],
          );
        }
        await client.query('COMMIT');
        return changed ? {
          ...panel, source: 'postgres',
          summary: { ...panel.summary, current: update.current, revision: this.revision(receipt, update.current, sequence + 1) },
        } : panel;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }
}
