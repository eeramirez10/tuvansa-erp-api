import type { InvoiceProps } from '../../../../sales/invoicing/domain/entities/invoice.js';
import { readSalesRemissions } from '../../../../sales/invoicing/infrastructure/datasources/postgres-sales-remissions.js';
import type { ClientBalanceDataSource } from '../../domain/datasources/client-balance-data-source.js';
import type { ClientMovementsDataSource } from '../../domain/datasources/client-movements-data-source.js';
import { ClientBalanceDocument } from '../../domain/entities/client-balance-document.js';
import { ClientMovement } from '../../domain/entities/client-movement.js';
import type { ClientBalanceResult, ClientBalanceSearchCriteria } from '../../domain/repositories/client-balance-repository.js';
import type { ClientMovementSearchCriteria, ClientMovementsResult } from '../../domain/repositories/client-movements-repository.js';
import type { LegacyMysqlClientMovementsDataSource } from './legacy-mysql-client-movements-data-source.js';

type InvoiceHeader = Omit<InvoiceProps, 'lines'>;

interface RemissionCharge {
  invoice: InvoiceHeader;
  issuedAt: string;
  charge: number;
}

interface BalanceCharge extends RemissionCharge {
  dueAt: string;
  daysOverdue: number;
}

interface MovementCharge extends RemissionCharge {
  userId: number;
  runningBalance: number;
}

const invoice = "((result->'invoice') - 'lines')";
const scope = 'FROM tuvansa.sales_remissions WHERE company_id = 1 AND charge > 0';
const today = "(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City')::date";
export const clientMoney = (value: number): number => Math.round(value * 100) / 100;

export interface SalesRemissionCustomerTotals {
  balance: number;
  lastPurchaseAt: string | null;
}

export function salesRemissionCustomerTotals(customerIds: number[]): Promise<Map<number, SalesRemissionCustomerTotals>> {
  if (customerIds.length === 0) return Promise.resolve(new Map());
  return readSalesRemissions(new Map<number, SalesRemissionCustomerTotals>(), async (client) => {
    // Derivada. Completa CLISACT y CLIULTCOM con las remisiones de la empresa del catálogo.
    const { rows } = await client.query<{ id: number } & SalesRemissionCustomerTotals>(
      `SELECT customer_id::float8 AS id, sum(charge)::float8 AS balance, max(issued_at)::text AS "lastPurchaseAt"
       FROM tuvansa.sales_remissions WHERE company_id = 1 AND customer_id = ANY($1::bigint[])
       GROUP BY customer_id`, [customerIds],
    );
    return new Map(rows.map(({ id, ...totals }) => [id, totals]));
  });
}

type BalancePage = ClientBalanceResult['summary'] & { items: BalanceCharge[]; total: number };
const emptyBalance: BalancePage = {
  totalBalance: 0, overdueBalance: 0, notDueBalance: 0,
  documentCount: 0, overdueDocumentCount: 0, notDueDocumentCount: 0,
  items: [], total: 0,
};

function balancePage(criteria: ClientBalanceSearchCriteria, offset: number, limit: number): Promise<BalancePage> {
  const values: (string | number)[] = [criteria.clientId];
  const conditions: string[] = [];
  if (criteria.dueStatus === 'overdue') conditions.push(`"dueAt" < ${today}`);
  if (criteria.dueStatus === 'notDue') conditions.push(`"dueAt" >= ${today}`);
  if (criteria.query !== undefined) {
    values.push(`%${criteria.query}%`);
    conditions.push(`(number ILIKE $2 OR order_number ILIKE $2 OR invoice->>'customerOrderNumber' ILIKE $2
      OR invoice->>'deliveryNote' ILIKE $2)`);
  }
  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  values.push(offset, limit);
  return readSalesRemissions(emptyBalance, async (client) => {
    // Derivada. Mantiene el resumen de todos los documentos y los filtros de la página Saldo.
    const { rows: [row] } = await client.query<BalancePage>(
      `WITH ledger AS (
         SELECT id, number, order_number, ${invoice} AS invoice, issued_at AS "issuedAt",
                charge, coalesce((result #>> '{invoice,dates,dueAt}')::date, issued_at) AS "dueAt"
         ${scope} AND customer_id = $1
       ), matches AS (SELECT * FROM ledger ${where})
       SELECT coalesce(sum(charge), 0)::float8 AS "totalBalance",
              coalesce(sum(charge) FILTER (WHERE "dueAt" < ${today}), 0)::float8 AS "overdueBalance",
              coalesce(sum(charge) FILTER (WHERE "dueAt" >= ${today}), 0)::float8 AS "notDueBalance",
              count(*)::float8 AS "documentCount",
              count(*) FILTER (WHERE "dueAt" < ${today})::float8 AS "overdueDocumentCount",
              count(*) FILTER (WHERE "dueAt" >= ${today})::float8 AS "notDueDocumentCount",
              (SELECT count(*)::float8 FROM matches) AS total,
              ARRAY(SELECT jsonb_build_object(
                'invoice', invoice, 'issuedAt', "issuedAt", 'charge', charge, 'dueAt', "dueAt",
                'daysOverdue', greatest(${today} - "dueAt", 0))
              FROM matches ORDER BY id OFFSET $${values.length - 1} LIMIT $${values.length}) AS items
       FROM ledger`, values,
    );
    return row ?? emptyBalance;
  });
}

function balanceDocument({ invoice, charge, issuedAt, dueAt, daysOverdue }: BalanceCharge) {
  return ClientBalanceDocument.create({
    id: invoice.id, number: invoice.number, date: issuedAt, dueDate: dueAt, daysOverdue, sign: 'charge',
    amountInBaseCurrency: clientMoney(charge), amount: clientMoney(invoice.totals.total),
    currency: { id: invoice.currency.id, name: invoice.currency.name }, exchangeRate: invoice.currency.exchangeRate,
    reference: invoice.orderNumber, scheduledDate: null, appliesToClientCode: invoice.customer.code,
    branchId: invoice.branch || null, deliveryReceipt: invoice.deliveryNote, deliveryReceiptDate: invoice.dates.deliveryNoteAt,
    customerOrder: invoice.customerOrderNumber, internalReference: '', status: invoice.status, isCanceled: invoice.canceled,
  });
}

export class ClientBalanceWithSalesRemissionsDataSource implements ClientBalanceDataSource {
  constructor(private readonly legacy: ClientBalanceDataSource) {}

  async searchByClient(criteria: ClientBalanceSearchCriteria): Promise<ClientBalanceResult | null> {
    const base = await this.legacy.searchByClient(criteria);
    if (!base) return null;
    const local = await balancePage(criteria, Math.max(0, criteria.offset - base.total), criteria.limit - base.items.length);
    if (local.documentCount === 0) return base;

    const summary = base.summary;
    return {
      client: { ...base.client, currentBalance: clientMoney(base.client.currentBalance + local.totalBalance) },
      items: [...base.items, ...local.items.map(balanceDocument)], total: base.total + local.total,
      summary: {
        totalBalance: clientMoney(summary.totalBalance + local.totalBalance),
        overdueBalance: clientMoney(summary.overdueBalance + local.overdueBalance),
        notDueBalance: clientMoney(summary.notDueBalance + local.notDueBalance),
        documentCount: summary.documentCount + local.documentCount,
        overdueDocumentCount: summary.overdueDocumentCount + local.overdueDocumentCount,
        notDueDocumentCount: summary.notDueDocumentCount + local.notDueDocumentCount,
      },
    };
  }
}

interface MovementPage {
  totalBalance: number;
  openingBalance: number;
  netMovement: number;
  movementCount: number;
  items: MovementCharge[];
  preceding: Record<string, number>;
}

const emptyMovements: MovementPage = {
  totalBalance: 0, openingBalance: 0, netMovement: 0, movementCount: 0, items: [], preceding: {},
};

function movementPage(
  criteria: ClientMovementSearchCriteria, base: ClientMovementsResult,
): Promise<MovementPage> {
  const cutoffs = [...new Set(base.items.map((item) => item.toPrimitives().date.slice(0, 10)))];
  return readSalesRemissions(emptyMovements, async (client) => {
    // Derivada. Incluye las remisiones anteriores al período en la apertura y conserva la fecha para el saldo acumulado.
    const { rows: [row] } = await client.query<MovementPage>(
      `WITH ledger AS (
         SELECT id, ${invoice} AS invoice, issued_at, charge, user_id AS "userId",
                sum(charge) OVER (ORDER BY issued_at, id ROWS UNBOUNDED PRECEDING) AS "runningBalance"
         ${scope} AND customer_id = $1
       ), period AS (
         SELECT * FROM ledger WHERE ($2::date IS NULL OR issued_at >= $2) AND ($3::date IS NULL OR issued_at <= $3)
       )
       SELECT coalesce(sum(charge), 0)::float8 AS "totalBalance",
              coalesce(sum(charge) FILTER (WHERE issued_at < $2::date), 0)::float8 AS "openingBalance",
              (SELECT coalesce(sum(charge), 0)::float8 FROM period) AS "netMovement",
              (SELECT count(*)::float8 FROM period) AS "movementCount",
              ARRAY(SELECT jsonb_build_object('invoice',invoice,'issuedAt',issued_at,'charge',charge,
                       'userId',"userId",'runningBalance',"runningBalance")
                    FROM period ORDER BY id OFFSET $4 LIMIT $5) AS items,
              (SELECT coalesce(jsonb_object_agg(cutoffs.date::text,
                (SELECT coalesce(sum(charge), 0) FROM ledger WHERE issued_at < cutoffs.date)), '{}'::jsonb)
                FROM unnest($6::date[]) AS cutoffs(date)) AS preceding
       FROM ledger`,
      [criteria.clientId, criteria.dateFrom ?? null, criteria.dateTo ?? null, Math.max(0, criteria.offset - base.summary.movementCount),
        criteria.limit - base.items.length, cutoffs],
    );
    return row ?? emptyMovements;
  });
}

function movementDocument({ invoice, issuedAt, charge, runningBalance, userId }: MovementCharge, legacyBalance: number) {
  return ClientMovement.create({
    id: invoice.id, date: issuedAt, movementType: { code: invoice.movementType, description: 'Remisión' },
    amount: clientMoney(charge), runningBalance: clientMoney(legacyBalance + runningBalance),
    paymentReference: invoice.orderNumber, exchangeRate: invoice.currency.exchangeRate,
    policy: '', receiptNumber: 0, userId, document: {
      id: invoice.id, number: invoice.number, date: issuedAt, dueDate: invoice.dates.dueAt,
      reference: invoice.orderNumber, amount: invoice.totals.total, currencyId: invoice.currency.id, isCanceled: invoice.canceled,
    },
  });
}

export class ClientMovementsWithSalesRemissionsDataSource implements ClientMovementsDataSource {
  constructor(private readonly legacy: LegacyMysqlClientMovementsDataSource) {}

  async searchByClient(criteria: ClientMovementSearchCriteria): Promise<ClientMovementsResult | null> {
    const base = await this.legacy.searchByClient(criteria);
    if (!base) return null;
    const local = await movementPage(criteria, base);
    if (local.totalBalance === 0) return base;

    const legacyBalances = await this.legacy.balanceThroughDates(criteria.clientId, [...new Set(local.items.map(({ issuedAt }) => issuedAt))]);
    const items = base.items.map((item) => {
      const movement = item.toPrimitives();
      const preceding = local.preceding[movement.date.slice(0, 10)] ?? 0;
      return preceding === 0 ? item : ClientMovement.create({
        ...movement, runningBalance: clientMoney(movement.runningBalance + preceding),
      });
    });
    const openingBalance = clientMoney(base.summary.openingBalance + local.openingBalance);
    const netMovement = clientMoney(base.summary.netMovement + local.netMovement);
    return {
      client: { ...base.client, currentBalance: clientMoney(base.client.currentBalance + local.totalBalance) },
      summary: {
        openingBalance, netMovement, closingBalance: clientMoney(openingBalance + netMovement),
        charges: clientMoney(base.summary.charges + local.netMovement), credits: base.summary.credits,
        movementCount: base.summary.movementCount + local.movementCount,
      },
      items: [...items, ...local.items.map((entry) => movementDocument(entry, legacyBalances.get(entry.issuedAt) ?? 0))],
    };
  }
}
