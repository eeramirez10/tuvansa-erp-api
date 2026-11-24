import { postgresConfigured } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { PurchaseReceptionsDataSource } from '../../domain/datasources/purchase-receptions-data-source.js';
import { readSupplierPayments } from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import { PurchaseReception, type PurchaseReceptionProps } from '../../domain/entities/purchase-reception.js';
import type {
  PurchaseReceptionNavigationDirection, PurchaseReceptionPanelKey, PurchaseReceptionPanelResult,
  PurchaseReceptionSearchCriteria, PurchaseReceptionSearchResult,
} from '../../domain/repositories/purchase-receptions-repository.js';
import type { LegacyMysqlPurchaseReceptionsDataSource } from './legacy-mysql-purchase-receptions-data-source.js';
import { isLocalPurchaseReceptionId } from './postgres-purchase-reception-writes.js';
import { isLocalPurchaseExpenseDocumentId } from './postgres-purchase-expenses.js';
import { paymentDocumentIdSql } from './postgres-purchase-payables.js';
import { readLocalReceptionView, type LocalReceptionViewRecord } from './local-purchase-reception-view.js';
import { readHistoricalReceptionCancellations } from './historical-purchase-reception-cancellation-reads.js';
import {
  readPurchaseReceptionDocumentations, type PurchaseReceptionDocumentationRecord,
} from './purchase-reception-documentation-reads.js';
import { supplierPaymentReversalSql, type PurchasePostingReversalReference } from './purchase-posting-reversal-reads.js';
import { supplierPaymentReversalsAvailable } from './purchase-posting-reversal-tables.js';
import { withReceiptPieceLines, withReceiptPieces } from './purchase-reception-piece-reads.js';
import { purchaseReceptionCommentsAvailable, withReceiptComments } from './postgres-purchase-reception-comments.js';
import { PostgresPurchaseReceptionClassifications, withReceiptClassifications } from './postgres-purchase-reception-classifications.js';
import { readReceiptSupplierChanges, receiptSupplierChangesAvailable, withReceiptSupplierChange } from './purchase-reception-supplier-change-reads.js';

const reception = 'reception';
const empty = { items: [], total: 0 };
const money = (value: number) => Number(value.toFixed(2));
const isLocalDocument = (id: number) => isLocalPurchaseReceptionId(id) || isLocalPurchaseExpenseDocumentId(id);
const isHistoricalRA = (number: string) => /^RA\d/.test(number);


const documentationMovement = ({ id, sourceId, sourceNumber, date, amount }: PurchaseReceptionDocumentationRecord) => ({
  id, date, transactionType: 'DO', reference: '', relatedDocumentId: sourceId, relatedDocument: sourceNumber,
  charges: 0, payments: amount, signedAmount: -amount, policyId: null, policyNumber: '',
});

export class HybridPurchaseReceptionsDataSource implements PurchaseReceptionsDataSource {
  constructor(
    private readonly legacy: LegacyMysqlPurchaseReceptionsDataSource,
    private readonly classifications = new PostgresPurchaseReceptionClassifications(legacy),
  ) {}

  private record(field: 'id' | 'number', value: string | number) {
    return readLocalReceptionView<LocalReceptionViewRecord | null>(null, true, async (client, view) => {
      const { rows: [row] } = await client.query<LocalReceptionViewRecord>(
        `SELECT reception,principal::float8 AS principal,movement_type AS "movementType",
                policy_number AS "policyNumber",policy_id::float8 AS "policyId"
         FROM (${view}) documents WHERE company_id=1 AND ${field}=$1`, [value],
      );
      return row ?? null;
    });
  }

  async findById(id: number) {
    if (!isLocalDocument(id)) return this.withHistoricalCancellation(await this.legacy.findById(id));
    const local = await this.record('id', id);
    if (!local) return null;
    return this.localDetail(local.reception);
  }

  async findByNumber(number: string) {
    const local = await this.record('number', number.toUpperCase());
    if (!local) return this.withHistoricalCancellation(await this.legacy.findByNumber(number));
    return this.localDetail(local.reception);
  }

  private async localDetail(receipt: PurchaseReceptionProps) {
    const document = /^RW\d/.test(receipt.number) ? await withReceiptPieceLines(receipt) : receipt;
    const classified = await withReceiptClassifications(await withReceiptComments(document));
    return (await this.withBalances([PurchaseReception.create(await withReceiptSupplierChange(classified))]))[0]!;
  }

  private async withHistoricalCancellations(items: PurchaseReception[]) {
    if (!postgresConfigured() || !items.length) return items;
    const receipts = items.map((item) => item.toPrimitives());
    const receiptIds = receipts.filter(({ number }) => isHistoricalRA(number)).map(({ id }) => id);
    const [cancellationRows, documentationRows] = await Promise.all([
      readHistoricalReceptionCancellations({ receiptIds }),
      readPurchaseReceptionDocumentations({ sourceIds: receiptIds }),
    ]);
    const cancellations = new Map(cancellationRows.map(({ receiptId, result }) => [receiptId, result]));
    const documented = new Set(documentationRows.map(({ sourceId }) => sourceId));
    return items.map((item, index) => {
      const receipt = receipts[index]!;
      if (!isHistoricalRA(receipt.number)) return item;
      const cancellation = cancellations.get(receipt.id);
      return PurchaseReception.create(cancellation ? {
        ...receipt, cancellationAvailable: true, cancelled: true, status: 'C', cancellation,
        totals: { ...receipt.totals, balance: 0 },
      } : {
        ...receipt, cancellationAvailable: true,
        totals: documented.has(receipt.id) ? { ...receipt.totals, balance: 0 } : receipt.totals,
      });
    });
  }

  private async withHistoricalCancellation(receipt: PurchaseReception | null) {
    if (!receipt) return null;
    const [item] = await this.withHistoricalCancellations([receipt]);
    const document = item!.toPrimitives();
    const withPieces = isHistoricalRA(document.number) ? await withReceiptPieceLines(document) : document;
    const classified = await withReceiptClassifications(await withReceiptComments(withPieces));
    return PurchaseReception.create(await withReceiptSupplierChange(classified));
  }

  private async withBalances(items: PurchaseReception[]) {
    if (!items.length) return items;
    const rows = items.map((item) => item.toPrimitives());
    const debits = await readSupplierPayments(new Map<number, number>(), async (client) => {
      const reversal = supplierPaymentReversalSql(await supplierPaymentReversalsAvailable(client));
      const { rows: found } = await client.query<{ id: string; paid: string }>(
        `SELECT ${paymentDocumentIdSql('payment')} AS id,coalesce(${reversal.paid},0) AS paid
         FROM tuvansa.supplier_payments AS payment ${reversal.join}
         WHERE payment.company_id=1 AND ${paymentDocumentIdSql('payment')}=ANY($1::bigint[])
         GROUP BY 1`,
        [rows.map(({ id }) => id)],
      );
      return new Map(found.map(({ id, paid }) => [Number(id), Number(paid)]));
    });
    return rows.map((row) => PurchaseReception.create({
      ...row, totals: { ...row.totals, balance: row.cancellation ? 0 : money(row.totals.balance - (debits.get(row.id) ?? 0)) },
    }));
  }

  async search(criteria: PurchaseReceptionSearchCriteria): Promise<PurchaseReceptionSearchResult> {
    const [local, historicalChanges] = await Promise.all([
      this.searchLocal(criteria), readReceiptSupplierChanges({ historical: true }),
    ]);
    local.items = await this.withBalances(local.items);
    const required = criteria.limit - local.items.length;
    if (required === 0) {
      const legacy = await this.legacy.search({ ...criteria, limit: 0, offset: 0 }, historicalChanges);
      return { items: local.items, total: local.total + legacy.total };
    }
    const legacy = await this.legacy.search({
      ...criteria, offset: Math.max(0, criteria.offset - local.total), limit: required,
    }, historicalChanges);
    return { items: [...local.items, ...await this.withHistoricalCancellations(legacy.items)], total: local.total + legacy.total };
  }

  private searchLocal({ query, documentNumber, receivedAt, orderNumber, supplierReference, deliveryNote, folio, supplierCode, warehouse, offset, limit }: PurchaseReceptionSearchCriteria) {
    if (deliveryNote !== undefined || folio !== undefined) return Promise.resolve(empty);
    const conditions = ['company_id=1'];
    const parameters: Array<string | number> = [];
    const escape = (value: string) => value.replace(/[!_%]/g, '!$&');
    if (query !== undefined) {
      parameters.push('%' + escape(query) + '%');
      conditions.push(`concat_ws(' ',number,order_number,${reception}->>'supplierReference',${reception}#>>'{supplier,code}',${reception}#>>'{supplier,name}') ILIKE $1 ESCAPE '!'`);
    }
    const fields = [
      ['number', documentNumber], ['order_number', orderNumber], [`${reception}->>'supplierReference'`, supplierReference],
      [`${reception}#>>'{supplier,code}'`, supplierCode], [`${reception}->>'warehouse'`, warehouse],
    ] as const;
    for (const [field, value] of fields) {
      if (value === undefined) continue;
      parameters.push(escape(value) + '%');
      conditions.push(`${field} ILIKE $${parameters.length} ESCAPE '!'`);
    }
    if (receivedAt !== undefined) {
      parameters.push(receivedAt);
      conditions.push(`${reception}#>>'{dates,receivedAt}'=$${parameters.length}`);
    }
    const where = conditions.join(' AND ');
    const orderBy = parameters.length ? 'number,id' : 'id DESC';
    return readLocalReceptionView<PurchaseReceptionSearchResult>(empty, false, async (client, view) => {
      const comments = await purchaseReceptionCommentsAvailable(client) ? `
        SELECT d.id,d.company_id,d.number,COALESCE(c.fields->>'orderNumber',d.order_number) AS order_number,
          d.reception || jsonb_strip_nulls(jsonb_build_object(
            'orderNumber',c.fields->>'orderNumber','supplierReference',c.fields->>'supplierReference','warehouse',c.fields->>'warehouse'
          )) AS reception
        FROM (${view}) d LEFT JOIN tuvansa.purchase_reception_comments c
          ON c.company_id=d.company_id AND c.receipt_id=d.id AND c.receipt_number=d.number
          AND c.supplier_id=(d.reception#>>'{supplier,id}')::bigint` : view;
      const documents = await receiptSupplierChangesAvailable(client) ? `
        SELECT d.id,d.company_id,d.number,d.order_number,
          CASE WHEN c.receipt_id IS NULL THEN d.reception
            ELSE jsonb_set(d.reception,'{supplier}',jsonb_build_object('id',c.supplier_id,'code',c.supplier_code,'name',c.supplier_name)) END AS reception
        FROM (${comments}) d LEFT JOIN tuvansa.purchase_reception_supplier_changes c
          ON c.company_id=d.company_id AND c.receipt_id=d.id AND c.receipt_number=d.number
          AND c.original_supplier_id=(d.reception#>>'{supplier,id}')::bigint AND NOT c.historical` : comments;
      const { rows: [row] } = await client.query<{ total: string; results: PurchaseReceptionSaveResultRow[] }>(
        `WITH documents AS (${documents})
         SELECT (SELECT count(*) FROM documents WHERE ${where}) AS total,
          ARRAY(SELECT ${reception} - 'lines' FROM documents WHERE ${where}
             ORDER BY ${orderBy} OFFSET $${parameters.length + 1} LIMIT $${parameters.length + 2}) AS results`,
        [...parameters, offset, limit],
      );
      return { items: (row?.results ?? []).map((item) => PurchaseReception.create({ ...item, lines: [] })), total: Number(row?.total ?? 0) };
    });
  }

  async findAdjacent(id: number, direction: PurchaseReceptionNavigationDirection) {
    const current = await this.findById(id);
    if (!current) return null;
    const { number } = current.toPrimitives();
    const previous = direction === 'previous';
    const [local, legacy] = await Promise.all([
      readLocalReceptionView<PurchaseReceptionProps | null>(null, true, async (client, view) => {
        const { rows: [row] } = await client.query<Pick<LocalReceptionViewRecord, 'reception'>>(
          `SELECT reception FROM (${view}) documents WHERE company_id=1 AND number ${previous ? '<' : '>'} $1
           ORDER BY number ${previous ? 'DESC' : 'ASC'} LIMIT 1`, [number],
        );
        return row?.reception ?? null;
      }),
      this.legacy.findAdjacentByNumber(number, direction),
    ]);
    if (!local) return this.withHistoricalCancellation(legacy);
    const compare = legacy ? local.number.localeCompare(legacy.toPrimitives().number, 'en') : 0;
    if (legacy && (previous ? compare < 0 : compare > 0)) return this.withHistoricalCancellation(legacy);
    return this.localDetail(local);
  }

  async getPanel(id: number, key: PurchaseReceptionPanelKey): Promise<PurchaseReceptionPanelResult | null> {
    if (key === 'classifications') return this.classifications.read(id);
    if (!isLocalDocument(id)) {
      const panel = await this.legacy.getPanel(id, key);
      if (panel && key === 'pieces') return withReceiptPieces(panel);
      if (!panel || key !== 'auxiliary' || !isHistoricalRA(panel.purchaseReception.number)) return panel;
      const [[cancellation], [documentation]] = await Promise.all([
        readHistoricalReceptionCancellations({ receiptIds: [id] }),
        readPurchaseReceptionDocumentations({ sourceIds: [id] }),
      ]);
      if (!cancellation) return documentation ? {
        ...panel, source: 'postgres', items: [...panel.items, documentationMovement(documentation)],
        summary: { ...panel.summary, total: money(Number(panel.summary?.total ?? 0) - documentation.amount) },
      } : panel;
      const { result, amount, number } = cancellation;
      const movement = {
        id: result.id, date: result.date, transactionType: 'K', reference: result.reason,
        relatedDocumentId: id, charges: 0, payments: amount, signedAmount: -amount, relatedDocument: number,
        policyId: result.id, policyNumber: result.policyNumber,
      };
      return {
        ...panel, source: 'postgres', items: [...panel.items, movement],
        summary: { ...panel.summary, total: money(Number(panel.summary?.total ?? 0) - amount) },
      };
    }
    const local = await this.record('id', id);
    if (!local) return null;
    const { number, dates, orderNumber, supplierReference, cancellation, pedimento } = local.reception;
    if (key === 'pieces') {
      return withReceiptPieces({ purchaseReception: { id, number }, key, section: 'actions', button: 'Piezas', source: 'postgres', items: [] });
    }
    if (key === 'pedimento') {
      return {
        purchaseReception: { id, number }, key, section: 'actions', button: 'Pedimento', source: 'postgres', items: [],
        ...(pedimento ? { summary: { number: pedimento.number, date: pedimento.date, customsOffice: pedimento.customsOffice,
          incrementables: pedimento.incrementables } } : {}),
      };
    }
    const amount = local.principal ?? 0;
    const [payments, [documentation]] = await Promise.all([readSupplierPayments([], async (client) => {
      const reversal = supplierPaymentReversalSql(await supplierPaymentReversalsAvailable(client));
      const { rows } = await client.query<{
        id: number; date: string; number: string; amount: number; policyNumber: string;
        reversal: PurchasePostingReversalReference | null;
      }>(
        `SELECT payment.id::float8,payment.date::text,payment.number,payment.amount::float8,payment.policy_number AS "policyNumber",
                ${reversal.reference} AS reversal
         FROM tuvansa.supplier_payments AS payment ${reversal.join}
         WHERE ${paymentDocumentIdSql('payment')}=$1 AND payment.company_id=1 ORDER BY payment.id`, [id],
      );
      return rows.flatMap((row) => {
        const original = {
          id: row.id, date: row.date, transactionType: 'PP', reference: row.number, relatedDocumentId: id,
          charges: 0, payments: row.amount, signedAmount: -row.amount, relatedDocument: number,
          policyNumber: row.policyNumber, policyId: row.id,
        };
        return row.reversal ? [original, {
          ...original, id: row.reversal.id, date: row.reversal.date, transactionType: 'RP',
          charges: row.amount, payments: 0, signedAmount: row.amount,
          policyNumber: row.reversal.policyNumber, policyId: row.reversal.id,
        }] : [original];
      });
    }), readPurchaseReceptionDocumentations({ sourceIds: [id] })]);
    const charge = local.principal !== null ? [{
      id, date: dates.receivedAt, transactionType: local.movementType, reference: orderNumber || supplierReference,
      relatedDocumentId: id, charges: amount, payments: 0, signedAmount: amount, relatedDocument: number,
      policyNumber: local.policyNumber ?? '', policyId: local.policyId,
    }] : [];
    const cancelled = cancellation ? [{
      id: cancellation.id, date: cancellation.date, transactionType: local.movementType === 'GA' ? 'CG' : 'K', reference: cancellation.reason,
      relatedDocumentId: id, charges: 0, payments: amount, signedAmount: -amount, relatedDocument: number,
      policyNumber: cancellation.policyNumber, policyId: cancellation.id,
    }] : [];
    const items = [...charge, ...payments, ...cancelled, ...(documentation ? [documentationMovement(documentation)] : [])]
      .sort((left, right) => (left.date ?? '').localeCompare(right.date ?? '')
        || Number(right.id === id) - Number(left.id === id) || left.id - right.id);
    return {
      purchaseReception: { id, number }, key, section: 'actions', button: 'Auxiliar', source: 'postgres',
      items,
      summary: { total: money(items.reduce((total, row) => total + row.signedAmount, 0)) },
    };
  }
}

type PurchaseReceptionSaveResultRow = Omit<PurchaseReceptionProps, 'lines'>;
