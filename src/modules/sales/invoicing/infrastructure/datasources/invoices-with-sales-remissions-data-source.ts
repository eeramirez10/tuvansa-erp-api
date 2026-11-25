import { postgresConfigured, type PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { customerAllowed, customerScope } from '../../../../../shared/infrastructure/http/customer-scope.js';
import { customerCollectionsAvailable, joinRemissionCollections } from '../../../../accounts-receivable/clients/infrastructure/datasources/customer-collections-reads.js';
import type { InvoicesDataSource } from '../../domain/datasources/invoices-data-source.js';
import { Invoice, type InvoiceProps } from '../../domain/entities/invoice.js';
import type { InvoiceNavigationDirection, InvoiceSearchCriteria, InvoiceSearchResult } from '../../domain/repositories/invoices-repository.js';
import type { LegacyMysqlInvoicesDataSource } from './legacy-mysql-invoices-data-source.js';
import { isLocalSalesRemissionId, readSalesRemissions } from './postgres-sales-remissions.js';
import { remissionCancellationSql, salesRemissionCancellationsAvailable } from './sales-remission-cancellation-reads.js';
import { readHistoricalSalesRemissionCancellations } from './historical-sales-remission-cancellation-reads.js';
import { customerCollectionReversalsAvailable } from '../../../../accounts-receivable/clients/infrastructure/datasources/customer-collection-reversal-reads.js';
import { salesTicketConversionSql } from './sales-ticket-conversion-reads.js';

const empty = { items: [], total: 0 };
type InvoiceHeader = Omit<InvoiceProps, 'lines'>;

interface SalesRemissionInvoice {
  invoice: InvoiceProps;
  charge: number;
}

interface InvoiceCollectionRow<T extends InvoiceHeader> {
  invoice: T;
  charge: number;
  paid: number;
  lastPaymentAt: string | null;
  cancellation: InvoiceProps['cancellation'] | null;
}

const collectionFields = `remission.charge::float8 AS charge, collections.paid::float8 AS paid,
  collections.last_payment_date::text AS "lastPaymentAt"`;

async function remissionScope(client: PostgresClient) {
  const join = joinRemissionCollections(await customerCollectionsAvailable(client), await customerCollectionReversalsAvailable(client));
  const cancellation = remissionCancellationSql(await salesRemissionCancellationsAvailable(client));
  const conversion = await salesTicketConversionSql(client);
  return {
    from: `FROM tuvansa.sales_remissions AS remission ${join} ${cancellation.join} ${conversion.join} WHERE remission.company_id = 1`,
    fields: `${collectionFields},${cancellation.result} AS cancellation`,
    ...conversion,
  };
}

function withCollectionTotals<T extends InvoiceHeader>({ invoice, charge, paid, lastPaymentAt, cancellation }: InvoiceCollectionRow<T>): T {
  if (cancellation) return { ...invoice, canceled: true, status: 'CANCELADA', cancellation, totals: { ...invoice.totals, balance: 0 } };
  if (paid === 0) return invoice;
  const balance = Math.max(0, Number((charge - paid).toFixed(2)));
  return {
    ...invoice,
    totals: { ...invoice.totals, paid, balance },
    dates: { ...invoice.dates, paidAt: balance === 0 ? lastPaymentAt : invoice.dates.paidAt },
  };
}

function readLocalInvoice(field: 'id' | 'number', value: number | string): Promise<SalesRemissionInvoice | null> {
  return readSalesRemissions<SalesRemissionInvoice | null>(null, async (client) => {
    const { from, fields, number, invoice } = await remissionScope(client);
    const filter = field === 'id' ? 'remission.id = $1' : `(${number} = $1 OR remission.number = $1)`;
    const { rows: [row] } = await client.query<InvoiceCollectionRow<InvoiceProps>>(
      `SELECT ${invoice} AS invoice, ${fields} ${from} AND ${filter}`, [value],
    );
    return row && customerAllowed(row.invoice.customer.id) ? { invoice: withCollectionTotals(row), charge: row.charge } : null;
  });
}

function localCustomerFilter(invoice: string, values: Array<string | number | number[]>) {
  const scope = customerScope.getStore();
  if (!scope) return '';
  values.push([...scope]);
  return ` AND (${invoice}#>>'{customer,id}')::bigint = ANY($${values.length}::bigint[])`;
}

export function readSalesRemissionInvoice(id: number) {
  return readLocalInvoice('id', id);
}

function compare(leftNumber: string, rightNumber: string): number {
  const left = leftNumber.toUpperCase();
  const right = rightNumber.toUpperCase();
  return left < right ? -1 : Number(left > right);
}

export class InvoicesWithSalesRemissionsDataSource implements InvoicesDataSource {
  constructor(private readonly legacy: LegacyMysqlInvoicesDataSource) {}

  private async withHistoricalCancellations(items: Invoice[]) {
    const configured = postgresConfigured();
    const candidates = items.map((item) => item.toPrimitives());
    const invoiceIds = candidates.filter(({ cancellationAvailable }) => cancellationAvailable).map(({ id }) => id);
    if (!invoiceIds.length) return items;
    const adjustments = configured ? await readHistoricalSalesRemissionCancellations({ invoiceIds }) : [];
    const results = new Map(adjustments.map(({ invoiceId, result }) => [invoiceId, result]));
    return candidates.map((invoice, index) => {
      if (!invoice.cancellationAvailable) return items[index]!;
      const cancellation = results.get(invoice.id);
      return Invoice.create(cancellation ? {
        ...invoice, canceled: true, status: 'CANCELADA', cancellation, totals: { ...invoice.totals, balance: 0 },
      } : { ...invoice, cancellationAvailable: configured });
    });
  }

  private async withHistoricalCancellation(invoice: Invoice | null) {
    return invoice ? (await this.withHistoricalCancellations([invoice]))[0]! : null;
  }

  async findById(id: number) {
    if (!isLocalSalesRemissionId(id)) return this.withHistoricalCancellation(await this.legacy.findById(id));
    const local = await readSalesRemissionInvoice(id);
    return local ? Invoice.create(local.invoice) : null;
  }

  async findByNumber(number: string) {
    const local = await readLocalInvoice('number', number.toUpperCase());
    return local ? Invoice.create(local.invoice) : this.withHistoricalCancellation(await this.legacy.findByNumber(number));
  }

  async findFirst() {
    const [local, legacy] = await Promise.all([
      this.browseLocal(null, 'next'), this.legacy.findFirst(),
    ]);
    if (!local || (legacy && compare(legacy.toPrimitives().number, local.number) <= 0)) return this.withHistoricalCancellation(legacy);
    return Invoice.create(local);
  }

  async findAdjacent(id: number, direction: InvoiceNavigationDirection) {
    const number = isLocalSalesRemissionId(id)
      ? (await readSalesRemissionInvoice(id))?.invoice.number ?? null
      : await this.legacy.findNumberById(id);
    if (number === null) return null;

    const [local, legacy] = await Promise.all([
      this.browseLocal(number, direction), this.legacy.findAdjacentByNumber(number, direction),
    ]);
    if (!local) return this.withHistoricalCancellation(legacy);
    if (legacy) {
      const order = compare(legacy.toPrimitives().number, local.number);
      if (direction === 'previous' ? order >= 0 : order <= 0) return this.withHistoricalCancellation(legacy);
    }
    return Invoice.create(local);
  }

  private browseLocal(number: string | null, direction: InvoiceNavigationDirection) {
    const previous = direction === 'previous';
    const order = previous ? 'DESC' : 'ASC';
    return readSalesRemissions<InvoiceProps | null>(null, async (client) => {
      const { from, fields, number: currentNumber, invoice } = await remissionScope(client);
      const filter = number === null ? '' : `AND ${currentNumber} ${previous ? '<' : '>'} $1`;
      const values: Array<string | number[]> = number === null ? [] : [number.toUpperCase()];
      const customers = localCustomerFilter(invoice, values);
      const { rows: [row] } = await client.query<InvoiceCollectionRow<InvoiceProps>>(
        `SELECT ${invoice} AS invoice, ${fields} ${from} ${filter}${customers}
         ORDER BY ${currentNumber} ${order}, remission.id ${order} LIMIT 1`,
        values,
      );
      return row ? withCollectionTotals(row) : null;
    });
  }

  private searchLocal(criteria: InvoiceSearchCriteria, limit: number) {
    return readSalesRemissions<{ items: InvoiceHeader[]; total: number }>(empty, async (client) => {
      const { from, fields, number, issuedAt, invoice } = await remissionScope(client);
      const conditions: string[] = [];
      const values: Array<string | number | number[]> = [];
      if (criteria.query !== undefined) {
        values.push(`%${criteria.query}%`);
        conditions.push(`(${number} ILIKE $1 OR remission.number ILIKE $1 OR order_number ILIKE $1
          OR ${invoice}->>'customerOrderNumber' ILIKE $1
          OR ${invoice}#>>'{customer,code}' ILIKE $1 OR ${invoice}#>>'{customer,name}' ILIKE $1)`);
      }
      const prefixes = [
        [[number, 'remission.number'], criteria.invoiceNumber], [['order_number'], criteria.orderNumber],
        [[`${invoice}->>'customerOrderNumber'`], criteria.customerOrderNumber],
        [[`${invoice}->>'deliveryNote'`], criteria.deliveryNote],
        [[`${invoice}->>'folio'`], criteria.folio],
        [[`${invoice}#>>'{customer,code}'`], criteria.customerCode],
        [[`${invoice}->>'warehouseSeal'`], criteria.warehouseSeal],
      ] as const;
      for (const [expressions, value] of prefixes) {
        if (value === undefined) continue;
        values.push(`${value}%`);
        conditions.push(`(${expressions.map((field) => `${field} ILIKE $${values.length}`).join(' OR ')})`);
      }
      if (criteria.issuedAt !== undefined) {
        values.push(criteria.issuedAt);
        conditions.push(`${issuedAt} = $${values.length}::date`);
      }
      if (criteria.amount !== undefined) {
        values.push(criteria.amount);
        conditions.push(`remission.charge = $${values.length}`);
      }
      const where = (conditions.length === 0 ? '' : `AND ${conditions.join(' AND ')}`) + localCustomerFilter(invoice, values);
      values.push(limit);
      // Derivada. Busca el encabezado de las remisiones web con los filtros de Facturación.
      const { rows: [row] } = await client.query<{ items: InvoiceCollectionRow<InvoiceHeader>[]; total: number }>(
        `WITH matched AS (
           SELECT remission.id, ${number} AS number, ${invoice} - 'lines' AS invoice, ${fields} ${from} ${where}
         )
         SELECT count(*)::float8 AS total,
                ARRAY(SELECT to_jsonb(matched) FROM matched ORDER BY number, id LIMIT $${values.length}) AS items FROM matched`,
        values,
      );
      return row ? { items: row.items.map(withCollectionTotals), total: row.total } : empty;
    });
  }

  async search(criteria: InvoiceSearchCriteria): Promise<InvoiceSearchResult> {
    const { offset, limit } = criteria;
    const local = await this.searchLocal(criteria, offset + limit);
    if (local.total === 0) {
      const result = await this.legacy.search(criteria);
      return { ...result, items: await this.withHistoricalCancellations(result.items) };
    }

    // Antecede a la página todo documento legacy con índice menor a offset menos el total local.
    const legacyOffset = Math.max(offset - local.total, 0);
    const legacy = await this.legacy.search({ ...criteria, offset: legacyOffset, limit: offset + limit - legacyOffset });
    const merged = [
      ...local.items.map((header) => {
        const invoice = Invoice.create({ ...header, lines: [] });
        return { number: header.number, id: header.id, invoice };
      }),
      ...legacy.items.map((invoice) => {
        const { number, id } = invoice.toPrimitives();
        return { number, id, invoice };
      }),
    ].sort((left, right) => compare(left.number, right.number) || left.id - right.id);
    return {
      items: await this.withHistoricalCancellations(merged.slice(offset - legacyOffset, offset + limit - legacyOffset).map(({ invoice }) => invoice)),
      total: Number(legacy.total) + local.total,
    };
  }
}
