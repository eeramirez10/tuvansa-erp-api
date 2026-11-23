import type { PurchaseReceptionsDataSource } from '../../domain/datasources/purchase-receptions-data-source.js';
import { readSupplierPayments } from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import { PurchaseReception } from '../../domain/entities/purchase-reception.js';
import type {
  PurchaseReceptionNavigationDirection, PurchaseReceptionPanelKey, PurchaseReceptionPanelResult,
  PurchaseReceptionSearchCriteria, PurchaseReceptionSearchResult,
} from '../../domain/repositories/purchase-receptions-repository.js';
import type { LegacyMysqlPurchaseReceptionsDataSource } from './legacy-mysql-purchase-receptions-data-source.js';
import { isLocalPurchaseReceptionId, readLocalPurchaseReceptions, type LocalReceptionRecord } from './postgres-purchase-reception-writes.js';

const reception = "(result->'reception')";
const empty = { items: [], total: 0 };
const money = (value: number) => Number(value.toFixed(2));

export class HybridPurchaseReceptionsDataSource implements PurchaseReceptionsDataSource {
  constructor(private readonly legacy: LegacyMysqlPurchaseReceptionsDataSource) {}

  private record(field: 'id' | 'number', value: string | number) {
    return readLocalPurchaseReceptions<LocalReceptionRecord | null>(null, async (client) => {
      const { rows: [row] } = await client.query<LocalReceptionRecord>(
        `SELECT result,movement,payable,accounting FROM tuvansa.purchase_receptions WHERE company_id=1 AND ${field}=$1`, [value],
      );
      return row ?? null;
    });
  }

  async findById(id: number) {
    if (!isLocalPurchaseReceptionId(id)) return this.legacy.findById(id);
    const local = await this.record('id', id);
    if (!local) return null;
    return (await this.withBalances([PurchaseReception.create(local.result.reception)]))[0]!;
  }

  async findByNumber(number: string) {
    const local = await this.record('number', number.toUpperCase());
    if (!local) return this.legacy.findByNumber(number);
    return (await this.withBalances([PurchaseReception.create(local.result.reception)]))[0]!;
  }

  private async withBalances(items: PurchaseReception[]) {
    if (!items.length) return items;
    const rows = items.map((item) => item.toPrimitives());
    const debits = await readSupplierPayments(new Map<number, number>(), async (client) => {
      const { rows: found } = await client.query<{ id: string; paid: string }>(
        'SELECT receipt_id AS id, sum(amount) AS paid FROM tuvansa.supplier_payments WHERE receipt_id=ANY($1::bigint[]) GROUP BY receipt_id',
        [rows.map(({ id }) => id)],
      );
      return new Map(found.map(({ id, paid }) => [Number(id), Number(paid)]));
    });
    return rows.map((row) => PurchaseReception.create({
      ...row, totals: { ...row.totals, balance: money(row.totals.balance - (debits.get(row.id) ?? 0)) },
    }));
  }

  async search(criteria: PurchaseReceptionSearchCriteria): Promise<PurchaseReceptionSearchResult> {
    const local = await this.searchLocal(criteria);
    local.items = await this.withBalances(local.items);
    const required = criteria.limit - local.items.length;
    if (required === 0) {
      const legacy = await this.legacy.search({ ...criteria, limit: 0, offset: 0 });
      return { items: local.items, total: local.total + legacy.total };
    }
    const legacy = await this.legacy.search({
      ...criteria, offset: Math.max(0, criteria.offset - local.total), limit: required,
    });
    return { items: [...local.items, ...legacy.items], total: local.total + legacy.total };
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
    return readLocalPurchaseReceptions<PurchaseReceptionSearchResult>(empty, async (client) => {
      const { rows: [row] } = await client.query<{ total: string; results: PurchaseReceptionSaveResultRow[] }>(
        `SELECT (SELECT count(*) FROM tuvansa.purchase_receptions WHERE ${where}) AS total,
          ARRAY(SELECT ${reception} - 'lines' FROM tuvansa.purchase_receptions WHERE ${where}
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
      readLocalPurchaseReceptions<LocalReceptionRecord['result'] | null>(null, async (client) => {
        const { rows: [row] } = await client.query<Pick<LocalReceptionRecord, 'result'>>(
          `SELECT result FROM tuvansa.purchase_receptions WHERE company_id=1 AND number ${previous ? '<' : '>'} $1
           ORDER BY number ${previous ? 'DESC' : 'ASC'} LIMIT 1`, [number],
        );
        return row?.result ?? null;
      }),
      this.legacy.findAdjacentByNumber(number, direction),
    ]);
    if (!local) return legacy;
    const compare = legacy ? local.reception.number.localeCompare(legacy.toPrimitives().number, 'en') : 0;
    if (legacy && (previous ? compare < 0 : compare > 0)) return legacy;
    return (await this.withBalances([PurchaseReception.create(local.reception)]))[0]!;
  }

  async getPanel(id: number, key: PurchaseReceptionPanelKey): Promise<PurchaseReceptionPanelResult | null> {
    if (!isLocalPurchaseReceptionId(id)) return this.legacy.getPanel(id, key);
    const local = await this.record('id', id);
    if (!local) return null;
    const { number, dates, orderNumber, classifications } = local.result.reception;
    if (key === 'classifications') {
      return this.legacy.classificationPanel({ id, number }, classifications, 'postgres');
    }
    const amount = local.payable?.amount ?? 0;
    const payments = await readSupplierPayments<Record<string, unknown>[]>([], async (client) => {
      const { rows } = await client.query<{ id: string; date: string; number: string; amount: string; policyNumber: string }>(
        `SELECT id::text,date::text,number,amount::text,policy_number AS "policyNumber"
         FROM tuvansa.supplier_payments WHERE receipt_id=$1 AND company_id=1 ORDER BY id`, [id],
      );
      return rows.map((row) => ({
        id: Number(row.id), date: row.date, transactionType: 'PP', reference: row.number, relatedDocumentId: id,
        charges: 0, payments: Number(row.amount), signedAmount: -Number(row.amount), relatedDocument: number,
        policyNumber: row.policyNumber, policyId: Number(row.id),
      }));
    });
    const charge = local.payable ? [{
      id, date: dates.receivedAt, transactionType: local.movement.header.type, reference: orderNumber,
      relatedDocumentId: id, charges: amount, payments: 0, signedAmount: amount, relatedDocument: number,
      policyNumber: local.accounting?.number ?? '', policyId: local.accounting ? id : null,
    }] : [];
    return {
      purchaseReception: { id, number }, key, section: 'actions', button: 'Auxiliar', source: 'postgres',
      items: [...charge, ...payments],
      summary: { total: money(amount + payments.reduce((total, row) => total + Number(row.signedAmount), 0)) },
    };
  }
}

type PurchaseReceptionSaveResultRow = Omit<LocalReceptionRecord['result']['reception'], 'lines'>;
