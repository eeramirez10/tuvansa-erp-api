import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import {
  connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory,
} from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { assertActiveSupplierCatalog } from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-catalog-data-source.js';
import type {
  PurchaseReceptionDocumentationDataSource, ReceptionDocumentationPreview, ReceptionDocumentationSource,
} from '../../domain/datasources/purchase-reception-documentation-data-source.js';
import { historicalReceptionCancellationsOn } from './historical-purchase-reception-cancellation-reads.js';
import { MysqlPurchaseReceptionDocumentationSource } from './mysql-purchase-reception-documentation-source.js';
import { localPurchasePayablesSql } from './postgres-purchase-payables.js';
import { receiptCommentDueDate } from './postgres-purchase-reception-comments.js';
import { getDocumentPaymentStatus } from './postgres-purchase-posting-reversals.js';
import { isLocalPurchaseReceptionId } from './postgres-purchase-reception-writes.js';
import {
  ensurePurchaseReceptionDocumentationSchema, purchaseReceptionDocumentationsOn,
} from './purchase-reception-documentation-reads.js';
import { lockPurchaseReceptionPieces } from './purchase-reception-piece-reads.js';
import { purchaseReceptionCancellationsAvailable } from './purchase-posting-reversal-tables.js';

const disabled = 'Documenta convencional no está habilitado para la compañía.';
const unavailable = () => new ApplicationError(
  'No fue posible consultar o registrar Documenta.', 'PURCHASE_RECEPTION_DOCUMENTATION_UNAVAILABLE', 503,
);

type LocalSource = Omit<ReceptionDocumentationSource, 'recorded' | 'reason' | 'version' | 'amount'> & {
  amount: number | null;
  principal: number | null;
  currency: number | null;
  exchangeRate: number | null;
  type: string;
  cancelled: boolean;
};

async function localReception(client: PostgresClient, companyId: number, id: number, lock: boolean) {
  const { rows: [tables] } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('tuvansa.purchase_receptions') IS NOT NULL AS present",
  );
  if (!tables?.present) return null;
  const cancellations = await purchaseReceptionCancellationsAvailable(client);
  const { rows: [row] } = await client.query<LocalSource>(
    `SELECT r.id::float8,r.number,r.result #> '{reception,supplier}' AS supplier,
       r.result #>> '{reception,dates,receivedAt}' AS date,r.payable->>'dueAt' AS "dueAt",
       (r.payable->>'amount')::float8 AS amount,(r.result #>> '{reception,totals,balance}')::float8 AS principal,
       (r.payable->>'currencyId')::int AS currency,(r.payable->>'exchangeRate')::float8 AS "exchangeRate",
       r.movement #>> '{header,type}' AS type,
       (coalesce((r.result #>> '{reception,cancelled}')::boolean,false)
         ${cancellations ? 'OR EXISTS(SELECT 1 FROM tuvansa.purchase_reception_cancellations c WHERE c.receipt_id=r.id AND c.company_id=r.company_id)' : ''}
       ) AS cancelled
     FROM tuvansa.purchase_receptions r WHERE r.id=$1 AND r.company_id=$2 ${lock ? 'FOR UPDATE OF r' : ''}`, [id, companyId],
  );
  if (!row) return null;
  const status = await getDocumentPaymentStatus(client, companyId, [id]);
  let reason: string | null = null;
  if (!/^RW\d/.test(row.number) || row.type !== 'RA' || row.currency !== 1 || row.exchangeRate !== 1 || !row.date || row.cancelled) {
    reason = 'Documenta requiere una recepción ordinaria RW activa en pesos.';
  } else if (!row.amount || row.amount < 0 || row.amount !== row.principal || status.active) {
    reason = 'El saldo debe coincidir con el cargo original de la recepción, sin pagos activos.';
  }
  return { ...row, amount: row.amount ?? 0, version: JSON.stringify([row, status]), reason, nativeRecord: null };
}

export class PostgresPurchaseReceptionDocumentations implements PurchaseReceptionDocumentationDataSource {
  private migration?: Promise<void>;

  constructor(
    private readonly native: Pick<MysqlPurchaseReceptionDocumentationSource, 'enabled' | 'reception' | 'numberExists'> =
      new MysqlPurchaseReceptionDocumentationSource(),
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured = postgresConfigured,
  ) {}

  private async withConnection<T>(read: (client: PostgresClient) => Promise<T>) {
    if (!this.configured()) throw unavailable();
    let client: PostgresClient | undefined;
    try {
      client = await this.connect();
      return await read(client);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw unavailable();
    } finally { client?.release(); }
  }

  private async read(client: PostgresClient, companyId: number, receiptId: number, lock = false) {
    if (companyId !== 1) return null;
    const local = isLocalPurchaseReceptionId(receiptId);
    const source = local
      ? await localReception(client, companyId, receiptId, lock) : await this.native.reception(receiptId);
    if (!source) return null;
    const [documentations, cancellations, enabled, dueAt] = await Promise.all([
      purchaseReceptionDocumentationsOn(client, { sourceIds: [receiptId] }),
      local ? [] : historicalReceptionCancellationsOn(client, { receiptIds: [receiptId] }),
      this.native.enabled(),
      receiptCommentDueDate(client, companyId, source),
    ]);
    const reason = !enabled ? disabled : cancellations.length ? 'La recepción ya fue cancelada.' : source.reason;
    const { nativeRecord, ...snapshot } = source;
    return { ...snapshot, dueAt, reason, recorded: documentations[0]?.result ?? nativeRecord };
  }

  source(companyId: number, receiptId: number) {
    return this.withConnection((client) => this.read(client, companyId, receiptId));
  }

  private async assertNumbersAvailable(client: PostgresClient, companyId: number, numbers: string[]) {
    const payables = await localPurchasePayablesSql(client);
    const { rows } = payables ? await client.query(
      `SELECT 1 FROM (${payables}) d WHERE d.company_id=$1 AND upper(d.number)=ANY($2::text[]) LIMIT 1`,
      [companyId, numbers.map((number) => number.toUpperCase())],
    ) : { rows: [] };
    if (rows.length || await this.native.numberExists(companyId, numbers)) {
      throw new ConflictError('Ya existe un documento con alguno de los folios de destino.', 'PURCHASE_RECEPTION_DOCUMENTATION_NUMBER_EXISTS');
    }
  }

  async commit({ actor, receiptId, input, fingerprint, validate }: Parameters<PurchaseReceptionDocumentationDataSource['commit']>[0]) {
    this.migration ??= this.withConnection(ensurePurchaseReceptionDocumentationSchema).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    const { companyId } = actor;
    return this.withConnection(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('purchase-reception-documentation:'||$1::text||':'||$2::text,0))",
          [companyId, input.requestKey],
        );
        const { rows: [replay] } = await client.query<{ fingerprint: string; result: ReceptionDocumentationPreview }>(
          'SELECT fingerprint,result FROM tuvansa.purchase_reception_documentations WHERE company_id=$1 AND request_key=$2',
          [companyId, input.requestKey],
        );
        if (replay && replay.fingerprint !== fingerprint) {
          throw new ConflictError('La solicitud ya se usó con otros datos.', 'PURCHASE_RECEPTION_DOCUMENTATION_REQUEST_CONFLICT');
        }
        const result = replay?.result ?? await this.insert(client, actor, receiptId, input, fingerprint, validate);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
          throw new ConflictError('Se registró la recepción o un folio de destino simultáneamente.', 'PURCHASE_RECEPTION_DOCUMENTATION_CONFLICT');
        }
        throw error;
      }
    });
  }

  private async insert(
    client: PostgresClient, { companyId, userId }: Parameters<PurchaseReceptionDocumentationDataSource['commit']>[0]['actor'],
    receiptId: number, input: Parameters<PurchaseReceptionDocumentationDataSource['commit']>[0]['input'],
    fingerprint: string, validate: Parameters<PurchaseReceptionDocumentationDataSource['commit']>[0]['validate'],
  ) {
    const initial = await this.read(client, companyId, receiptId);
    if (!initial) throw new NotFoundError('Recepción de compra');
    await assertActiveSupplierCatalog(client, initial.supplier.id);
    await lockPurchaseReceptionPieces(client, companyId, receiptId);
    const source = await this.read(client, companyId, receiptId, true);
    if (!source) throw new NotFoundError('Recepción de compra');
    validate(source);
    await this.assertNumbersAvailable(client, companyId, input.documents.map(({ number }) => number));
    const { rows: [header] } = await client.query<{ id: string }>(
      "SELECT nextval('tuvansa.purchase_reception_documentation_ids') AS id",
    );
    const { rows: ids } = await client.query<{ id: string }>(
      "SELECT nextval('tuvansa.purchase_reception_documentation_document_ids') AS id FROM generate_series(1,$1::int)",
      [input.documents.length],
    );
    const result: ReceptionDocumentationPreview = {
      reception: { id: receiptId, number: source.number }, amount: source.amount, revision: input.revision,
      canWrite: false, reason: 'La recepción ya está documentada.', documents: input.documents.map((document, index) => ({
        id: Number(ids[index]!.id), ...document,
      })),
    };
    const documentationId = Number(header!.id);
    await client.query(
      `INSERT INTO tuvansa.purchase_reception_documentations
       (id,source_id,local_receipt_id,source_number,company_id,supplier_id,supplier_code,supplier_name,user_id,
        request_key,fingerprint,date,due_date,amount,result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
      [documentationId, receiptId, isLocalPurchaseReceptionId(receiptId) ? receiptId : null, source.number, companyId,
        source.supplier.id, source.supplier.code, source.supplier.name, userId, input.requestKey, fingerprint,
        source.date, source.dueAt, source.amount, JSON.stringify(result)],
    );
    for (const [index, document] of result.documents.entries()) {
      await client.query(
        `INSERT INTO tuvansa.purchase_reception_documentation_documents(id,documentation_id,company_id,number,amount,position)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [document.id, documentationId, companyId, document.number, document.amount, index + 1],
      );
    }
    return result;
  }
}
