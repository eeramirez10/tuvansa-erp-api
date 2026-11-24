import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { amountInWords } from '../../../../../shared/domain/format/amount-in-words.js';
import { connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type {
  PurchaseReceptionCommentsBase, PurchaseReceptionCommentsDataSource, PurchaseReceptionCommentsFields,
  PurchaseReceptionCommentsInput, PurchaseReceptionCommentsSnapshot, PurchaseReceptionCommentsSource,
} from '../../domain/datasources/purchase-reception-comments-data-source.js';
import type { PurchaseReceptionProps } from '../../domain/entities/purchase-reception.js';
import { isLocalPurchaseExpenseDocumentId } from './postgres-purchase-expenses.js';
import { isLocalPurchaseReceptionId } from './postgres-purchase-reception-writes.js';
import { lockPurchaseReceptionPieces } from './purchase-reception-piece-reads.js';

export const purchaseReceptionCommentsMigrations = [{ id: 'purchase_reception_comments', sql: `
  CREATE TABLE tuvansa.purchase_reception_comments (
    company_id integer NOT NULL CHECK(company_id=1),
    receipt_id bigint NOT NULL,
    receipt_number varchar(15) NOT NULL,
    supplier_id bigint NOT NULL,
    fields jsonb NOT NULL CHECK(jsonb_typeof(fields)='object'),
    revision integer NOT NULL CHECK(revision>0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(company_id,receipt_id)
  );
` }];

const unavailable = 'Configura PostgreSQL para guardar los comentarios de recepción.';
const conflict = (message: string) => new ConflictError(message, 'PURCHASE_RECEPTION_COMMENTS_CONFLICT');
const invalid = (message: string) => new ApplicationError(message, 'PURCHASE_RECEPTION_COMMENTS_INVALID', 422);

interface StoredComments {
  receiptNumber: string;
  supplierId: number;
  fields: Partial<PurchaseReceptionCommentsFields>;
  revision: number;
}

export async function purchaseReceptionCommentsAvailable(client: PostgresClient) {
  const { rows: [table] } = await client.query<{ available: boolean }>(
    "SELECT to_regclass('tuvansa.purchase_reception_comments') IS NOT NULL AS available",
  );
  return table?.available === true;
}

async function commentsOn(client: PostgresClient, companyId: number, receiptId: number) {
  if (!await purchaseReceptionCommentsAvailable(client)) return undefined;
  const { rows: [saved] } = await client.query<StoredComments>(
    `SELECT receipt_number AS "receiptNumber",supplier_id::float8 AS "supplierId",fields,revision
     FROM tuvansa.purchase_reception_comments WHERE company_id=$1 AND receipt_id=$2`, [companyId, receiptId],
  );
  return saved;
}

function matches(saved: StoredComments | undefined, receiptNumber: string, supplierId: number): saved is StoredComments {
  return saved?.receiptNumber === receiptNumber && saved.supplierId === supplierId;
}

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changedFields(base: PurchaseReceptionCommentsFields, fields: PurchaseReceptionCommentsFields) {
  return Object.fromEntries((Object.keys(fields) as Array<keyof PurchaseReceptionCommentsFields>)
    .filter((key) => !same(base[key], fields[key])).map((key) => [key, fields[key]]));
}

function normalize(input: PurchaseReceptionCommentsFields, previous: PurchaseReceptionCommentsFields) {
  const fields: PurchaseReceptionCommentsFields = {
    ...input,
    lines: [input.lines[0], input.lines[1], input.lines[2], input.lines[3], input.lines[4].replace(/\r\n?/g, '\n')],
    folioAt: input.folioAt?.length === 10 && previous.folioAt?.startsWith(input.folioAt) ? previous.folioAt : input.folioAt,
  };
  const exactWidths = { supplierReference: 23, orderNumber: 13, otherLabel: 20 } as const;
  for (const key of Object.keys(exactWidths) as Array<keyof typeof exactWidths>) {
    if (fields[key] === previous[key]) continue;
    const value = fields[key].toUpperCase();
    if (value.length > exactWidths[key]) throw invalid('La referencia, orden o texto adicional excede el espacio de captura de Proscai.');
    fields[key] = value;
  }
  if (fields.warehouse !== previous.warehouse && fields.warehouse.length > 6) {
    throw invalid('El almacén admite hasta 6 caracteres.');
  }
  return fields;
}

function localFields({ supplierReference, department, orderNumber, warehouse, classifications, dates, totals }: PurchaseReceptionProps): PurchaseReceptionCommentsFields {
  return {
    dueAt: dates.dueAt, supplierReference, department, orderNumber, warehouse,
    transportCode: classifications[6] ?? '', otherLabel: totals.otherLabel, processDate: null,
    boxes: 0, volume: 0, folio: '', folioAt: null, lines: ['', '', '', '', ''], amountInWords: amountInWords(totals.total),
  };
}

async function localReceptionComments(client: PostgresClient, companyId: number, receiptId: number): Promise<PurchaseReceptionCommentsBase | null> {
  const { rows: [available] } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('tuvansa.purchase_receptions') IS NOT NULL AS present",
  );
  if (!available?.present) return null;
  const { rows: [row] } = await client.query<{ receipt: PurchaseReceptionProps }>(
    "SELECT result->'reception' AS receipt FROM tuvansa.purchase_receptions WHERE company_id=$1 AND id=$2", [companyId, receiptId],
  );
  if (!row) return null;
  const { id, number, supplier } = row.receipt;
  return { reception: { id, number, supplierCode: supplier.code }, supplierId: supplier.id, fields: localFields(row.receipt), reason: null };
}

async function localExpenseComments(client: PostgresClient, companyId: number, receiptId: number): Promise<PurchaseReceptionCommentsBase | null> {
  const { rows: [available] } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('tuvansa.purchase_expense_documents') IS NOT NULL AS present",
  );
  if (!available?.present) return null;
  const { rows: [row] } = await client.query<{ id: number; number: string; supplierId: number; supplierCode: string; reference: string; dueAt: string; amount: number }>(
    `SELECT id::float8,number,supplier_id::float8 AS "supplierId",supplier_code AS "supplierCode",reference,
       due_date::text AS "dueAt",amount::float8 FROM tuvansa.purchase_expense_documents WHERE company_id=$1 AND id=$2`, [companyId, receiptId],
  );
  if (!row) return null;
  const { id, number, supplierId, supplierCode, reference, dueAt, amount } = row;
  return { reception: { id, number, supplierCode }, supplierId, reason: null, fields: {
    dueAt, supplierReference: reference, department: '', orderNumber: '', warehouse: '', transportCode: '',
    processDate: null, otherLabel: '', boxes: 0, volume: 0, folio: '', folioAt: null, lines: ['', '', '', '', ''],
    amountInWords: amountInWords(amount),
  } };
}

interface CommentsContext {
  base: PurchaseReceptionCommentsBase;
  stored: StoredComments | undefined;
  fields: PurchaseReceptionCommentsFields;
  revision: string;
  reason: string | null;
}

export class PostgresPurchaseReceptionComments implements PurchaseReceptionCommentsDataSource {
  private migration?: Promise<void>;
  constructor(
    private readonly native: PurchaseReceptionCommentsSource,
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured = postgresConfigured,
  ) {}

  private async using<T>(run: (client: PostgresClient) => Promise<T>) {
    const client = await this.connect();
    try { return await run(client); }
    finally { client.release(); }
  }

  private async base(companyId: number, receiptId: number, client?: PostgresClient) {
    if (companyId !== 1) return null;
    if (isLocalPurchaseReceptionId(receiptId)) return client ? localReceptionComments(client, companyId, receiptId) : null;
    if (isLocalPurchaseExpenseDocumentId(receiptId)) return client ? localExpenseComments(client, companyId, receiptId) : null;
    return this.native.read(companyId, receiptId);
  }

  private async context(companyId: number, receiptId: number, client?: PostgresClient): Promise<CommentsContext | null> {
    const base = await this.base(companyId, receiptId, client);
    if (!base) return null;
    const saved = client ? await commentsOn(client, companyId, receiptId) : undefined;
    const stored = matches(saved, base.reception.number, base.supplierId) ? saved : undefined;
    const reason = base.reason ?? (saved && !stored ? 'El folio o proveedor de la recepción cambió en Proscai.'
      : !client ? unavailable : null);
    const fields = { ...base.fields, ...stored?.fields };
    const revision = this.revision(companyId, base, stored?.revision ?? 0);
    return { base, stored, fields, revision, reason };
  }

  private revision(companyId: number, base: PurchaseReceptionCommentsBase, sequence: number) {
    return createHash('sha256').update(JSON.stringify([companyId, base, sequence])).digest('hex');
  }

  private async result({ base, fields, revision, reason }: CommentsContext): Promise<PurchaseReceptionCommentsSnapshot> {
    const [transportName, labels] = await Promise.all([
      this.native.transportName(fields.transportCode), this.native.labels(base.reception.number.charAt(0)),
    ]);
    return { reception: base.reception, fields, transportName, labels, revision, reason, canWrite: !reason };
  }

  async read(companyId: number, receiptId: number) {
    const context = this.configured()
      ? await this.using((client) => this.context(companyId, receiptId, client)) : await this.context(companyId, receiptId);
    return context ? this.result(context) : null;
  }

  async save(companyId: number, receiptId: number, input: PurchaseReceptionCommentsInput) {
    if (!this.configured()) throw new ApplicationError(unavailable, 'PURCHASE_RECEPTION_COMMENTS_NOT_CONFIGURED', 503);
    this.migration ??= this.using((client) => migratePostgres(client, purchaseReceptionCommentsMigrations)).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    return this.using(async (client) => {
      await client.query('BEGIN');
      try {
        await lockPurchaseReceptionPieces(client, companyId, receiptId);
        const current = await this.context(companyId, receiptId, client);
        if (!current) throw new NotFoundError('Recepción de compra');
        if (current.reason) throw conflict(current.reason);
        if (current.revision !== input.revision) throw conflict('La recepción o sus comentarios cambiaron. Vuelve a abrir el editor.');
        const fields = normalize(input.fields, current.fields);
        const sequence = current.stored?.revision ?? 0;
        const changed = Object.keys(changedFields(current.fields, fields)).length > 0;
        if (changed) {
          const { base } = current;
          const overrides = changedFields(base.fields, fields);
          await client.query(
            `INSERT INTO tuvansa.purchase_reception_comments(company_id,receipt_id,receipt_number,supplier_id,fields,revision)
             VALUES($1,$2,$3,$4,$5::jsonb,1)
             ON CONFLICT(company_id,receipt_id) DO UPDATE SET fields=excluded.fields,revision=tuvansa.purchase_reception_comments.revision+1,updated_at=now()`,
            [companyId, receiptId, base.reception.number, base.supplierId, JSON.stringify(overrides)],
          );
        }
        const result = await this.result({ ...current, fields, revision: this.revision(companyId, current.base, sequence + Number(changed)) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }
}

type ReceiptIdentity = Pick<PurchaseReceptionProps, 'id' | 'number' | 'supplier'>;

export async function readReceiptTransport(client: PostgresClient, companyId: number, receipt: ReceiptIdentity) {
  const saved = await commentsOn(client, companyId, receipt.id);
  if (matches(saved, receipt.number, receipt.supplier.id)) return { code: saved.fields.transportCode, canWrite: true };
  return { code: undefined, canWrite: !saved };
}

export async function saveReceiptTransport(
  client: PostgresClient, companyId: number, receipt: ReceiptIdentity, code: string,
) {
  const { rows } = await client.query(
    `INSERT INTO tuvansa.purchase_reception_comments(company_id,receipt_id,receipt_number,supplier_id,fields,revision)
     VALUES($1,$2,$3,$4,jsonb_build_object('transportCode',$5::text),1)
     ON CONFLICT(company_id,receipt_id) DO UPDATE SET
       fields=tuvansa.purchase_reception_comments.fields || excluded.fields,
       revision=tuvansa.purchase_reception_comments.revision+1,updated_at=now()
     WHERE tuvansa.purchase_reception_comments.receipt_number=excluded.receipt_number
       AND tuvansa.purchase_reception_comments.supplier_id=excluded.supplier_id
     RETURNING receipt_id`,
    [companyId, receipt.id, receipt.number, receipt.supplier.id, code],
  );
  if (!rows.length) throw conflict('El folio o proveedor de la recepción cambió en Proscai.');
}

export async function receiptCommentDueDate(client: PostgresClient, companyId: number, receipt: {
  id: number; number: string; supplier: { id: number }; dueAt: string | null;
}) {
  const saved = await commentsOn(client, companyId, receipt.id);
  return matches(saved, receipt.number, receipt.supplier.id) && saved.fields.dueAt !== undefined ? saved.fields.dueAt : receipt.dueAt;
}

export async function withReceiptComments(receipt: PurchaseReceptionProps): Promise<PurchaseReceptionProps> {
  if (!postgresConfigured()) return receipt;
  const client = await connectPostgres();
  try {
    const saved = await commentsOn(client, 1, receipt.id);
    if (!matches(saved, receipt.number, receipt.supplier.id)) return receipt;
    const { dueAt, supplierReference, department, orderNumber, warehouse, transportCode, otherLabel } = saved.fields;
    const { dates, totals, classifications } = receipt;
    return {
      ...receipt, supplierReference: supplierReference ?? receipt.supplierReference, department: department ?? receipt.department,
      orderNumber: orderNumber ?? receipt.orderNumber, warehouse: warehouse ?? receipt.warehouse,
      dates: dueAt === undefined ? dates : { ...dates, dueAt },
      delayDays: dueAt === undefined ? receipt.delayDays : dueAt ? Math.max(0, Math.floor((Date.now() - Date.parse(dueAt)) / 86_400_000)) : 0,
      classifications: transportCode === undefined ? classifications
        : Array.from({ length: Math.max(classifications.length, 9) }, (_, index) => index === 6 ? transportCode : classifications[index] ?? ''),
      totals: otherLabel === undefined ? totals : { ...totals, otherLabel },
    };
  } finally { client.release(); }
}
