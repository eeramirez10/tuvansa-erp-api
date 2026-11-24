import type { InvoiceProps } from '../../../../sales/invoicing/domain/entities/invoice.js';
import { readSalesRemissions } from '../../../../sales/invoicing/infrastructure/datasources/postgres-sales-remissions.js';
import { remissionCancellationSql, salesRemissionCancellationsAvailable } from '../../../../sales/invoicing/infrastructure/datasources/sales-remission-cancellation-reads.js';
import type { ClientBalanceDataSource } from '../../domain/datasources/client-balance-data-source.js';
import type { ClientMovementsDataSource } from '../../domain/datasources/client-movements-data-source.js';
import { ClientBalanceDocument } from '../../domain/entities/client-balance-document.js';
import { ClientMovement, type ClientMovementProps } from '../../domain/entities/client-movement.js';
import type { ClientBalanceResult, ClientBalanceSearchCriteria } from '../../domain/repositories/client-balance-repository.js';
import type { ClientMovementSearchCriteria, ClientMovementsResult } from '../../domain/repositories/client-movements-repository.js';
import { customerCollectionsAvailable, joinRemissionCollections } from './customer-collections-reads.js';
import { customerCollectionReversalSql, customerCollectionReversalsAvailable } from './customer-collection-reversal-reads.js';
import type { LegacyMysqlClientMovementsDataSource } from './legacy-mysql-client-movements-data-source.js';
import { clientCatalogRecord } from './postgres-client-catalog.js';

const catalogIdentity = (document: { id: number; code: string; name: string }, currentBalance = 0) => ({
  id: document.id, code: document.code, name: document.name, currentBalance,
});

type InvoiceHeader = Omit<InvoiceProps, 'lines'>;

interface BalanceCharge {
  invoice: InvoiceHeader;
  issuedAt: string;
  remaining: number;
  dueAt: string;
  daysOverdue: number;
}

interface LocalMovement {
  id: number;
  invoice: InvoiceHeader;
  date: string;
  amount: number;
  remaining: number;
  movementType: string;
  paymentReference: string;
  policy: string;
  receiptNumber: number;
  collectionNumber: string | null;
  collectionReversal: ClientMovementProps['collectionReversal'] | null;
  isCollectionReversal: boolean;
  userId: number;
  runningBalance: number;
}

const invoice = "((remission.result->'invoice') - 'lines')";
const today = "(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City')::date";
export const clientMoney = (value: number): number => Math.round(value * 100) / 100;

export interface SalesRemissionCustomerTotals {
  balance: number;
  lastPurchaseAt: string | null;
  lastPaymentAt: string | null;
}

export function salesRemissionCustomerTotals(customerIds: number[]): Promise<Map<number, SalesRemissionCustomerTotals>> {
  if (customerIds.length === 0) return Promise.resolve(new Map());
  return readSalesRemissions(new Map<number, SalesRemissionCustomerTotals>(), async (client) => {
    const join = joinRemissionCollections(await customerCollectionsAvailable(client), await customerCollectionReversalsAvailable(client));
    const cancellation = remissionCancellationSql(await salesRemissionCancellationsAvailable(client));
    // Derivada. Completa el saldo y las fechas de compra y pago de la ficha del cliente.
    const { rows } = await client.query<{ id: number } & SalesRemissionCustomerTotals>(
      `SELECT remission.customer_id::float8 AS id, sum(remission.charge - collections.paid)::float8 AS balance,
              max(remission.issued_at)::text AS "lastPurchaseAt", max(collections.last_payment_date)::text AS "lastPaymentAt"
       FROM tuvansa.sales_remissions AS remission ${join} ${cancellation.join}
       WHERE remission.company_id = 1 AND remission.customer_id = ANY($1::bigint[]) AND NOT (${cancellation.canceled})
       GROUP BY remission.customer_id`, [customerIds],
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
    const join = joinRemissionCollections(await customerCollectionsAvailable(client), await customerCollectionReversalsAvailable(client));
    const cancellation = remissionCancellationSql(await salesRemissionCancellationsAvailable(client));
    // Derivada. Saldo considera el importe pendiente de cada documento con cargo.
    const { rows: [row] } = await client.query<BalancePage>(
      `WITH ledger AS (
         SELECT remission.id, remission.number, remission.order_number, ${invoice} AS invoice,
                remission.issued_at AS "issuedAt", remission.charge - collections.paid AS remaining,
                coalesce((remission.result #>> '{invoice,dates,dueAt}')::date, remission.issued_at) AS "dueAt"
         FROM tuvansa.sales_remissions AS remission ${join} ${cancellation.join}
         WHERE remission.company_id = 1 AND remission.customer_id = $1 AND remission.charge > collections.paid AND NOT (${cancellation.canceled})
       ), matches AS (SELECT * FROM ledger ${where})
       SELECT coalesce(sum(remaining), 0)::float8 AS "totalBalance",
              coalesce(sum(remaining) FILTER (WHERE "dueAt" < ${today}), 0)::float8 AS "overdueBalance",
              coalesce(sum(remaining) FILTER (WHERE "dueAt" >= ${today}), 0)::float8 AS "notDueBalance",
              count(*)::float8 AS "documentCount",
              count(*) FILTER (WHERE "dueAt" < ${today})::float8 AS "overdueDocumentCount",
              count(*) FILTER (WHERE "dueAt" >= ${today})::float8 AS "notDueDocumentCount",
              (SELECT count(*)::float8 FROM matches) AS total,
              ARRAY(SELECT jsonb_build_object(
                'invoice', invoice, 'issuedAt', "issuedAt", 'remaining', remaining, 'dueAt', "dueAt",
                'daysOverdue', greatest(${today} - "dueAt", 0))
              FROM matches ORDER BY id OFFSET $${values.length - 1} LIMIT $${values.length}) AS items
       FROM ledger`, values,
    );
    return row ?? emptyBalance;
  });
}

function balanceDocument({ invoice, remaining, issuedAt, dueAt, daysOverdue }: BalanceCharge) {
  return ClientBalanceDocument.create({
    id: invoice.id, number: invoice.number, date: issuedAt, dueDate: dueAt, daysOverdue, sign: 'charge',
    remissionId: invoice.id, canCollect: true,
    amountInBaseCurrency: clientMoney(remaining), amount: clientMoney(invoice.totals.total),
    currency: { id: invoice.currency.id, name: invoice.currency.name }, exchangeRate: invoice.currency.exchangeRate,
    reference: invoice.orderNumber, scheduledDate: null, appliesToClientCode: invoice.customer.code,
    branchId: invoice.branch || null, deliveryReceipt: invoice.deliveryNote, deliveryReceiptDate: invoice.dates.deliveryNoteAt,
    customerOrder: invoice.customerOrderNumber, internalReference: '', status: invoice.status, isCanceled: invoice.canceled,
  });
}

export class ClientBalanceWithSalesRemissionsDataSource implements ClientBalanceDataSource {
  constructor(private readonly legacy: ClientBalanceDataSource) {}

  async searchByClient(criteria: ClientBalanceSearchCriteria): Promise<ClientBalanceResult | null> {
    const record = await clientCatalogRecord(criteria.clientId);
    if (record?.deleted) return null;
    const base: ClientBalanceResult | null = record && !record.legacy ? {
      client: catalogIdentity(record.document), items: [], total: 0,
      summary: { totalBalance: 0, overdueBalance: 0, notDueBalance: 0, documentCount: 0, overdueDocumentCount: 0, notDueDocumentCount: 0 },
    } : await this.legacy.searchByClient(criteria);
    if (!base) return null;
    if (record?.legacy) base.client = catalogIdentity(record.document, base.client.currentBalance);
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
  entryCount: number;
  openingBalance: number;
  charges: number;
  credits: number;
  netMovement: number;
  movementCount: number;
  items: LocalMovement[];
  preceding: Record<string, number>;
}

const emptyMovements: MovementPage = {
  totalBalance: 0, entryCount: 0, openingBalance: 0, charges: 0, credits: 0, netMovement: 0,
  movementCount: 0, items: [], preceding: {},
};

const collectionMovements = (withReversals: boolean) => {
  const reversal = customerCollectionReversalSql(withReversals);
  return `UNION ALL
  SELECT collection.id, remission.invoice, collection.date AS movement_date, -collection.amount AS amount,
         remission.remaining, collection.movement_type,
         coalesce(nullif(collection.reference, ''), collection.number) AS payment_reference,
         collection.policy_number AS policy, collection.receipt_number,
         collection.number AS collection_number, collection.user_id, collection.created_at,${reversal.reference},false
  FROM tuvansa.customer_collections AS collection ${reversal.join}
  JOIN remissions AS remission ON remission.id = collection.remission_id
  WHERE collection.company_id = 1 AND collection.client_id = $1`;
};

const collectionReversalMovements = `UNION ALL
  SELECT reversal.id,remission.invoice,reversal.date,collection.amount,remission.remaining,'PA',
         concat('REV ',collection.policy_number),reversal.policy_number,0,reversal.number,reversal.user_id,reversal.created_at,NULL::jsonb,true
  FROM tuvansa.customer_collection_reversals reversal
  JOIN tuvansa.customer_collections collection ON collection.id=reversal.collection_id AND collection.company_id=reversal.company_id
  JOIN remissions remission ON remission.id=collection.remission_id
  WHERE collection.company_id=1 AND collection.client_id=$1`;

const cancellationMovements = `UNION ALL
  SELECT cancellation.id,remission.invoice,cancellation.date,-remission.charge,0,'K',remission.invoice->>'number',
         ''::text,0,NULL::text,cancellation.user_id,cancellation.created_at,NULL::jsonb,false
  FROM tuvansa.sales_remission_cancellations cancellation
  JOIN remissions remission ON remission.id=cancellation.remission_id WHERE cancellation.company_id=1`;

function movementPage(criteria: ClientMovementSearchCriteria, base: ClientMovementsResult): Promise<MovementPage> {
  const cutoffs = [...new Set(base.items.map((item) => item.toPrimitives().date.slice(0, 10)))];
  return readSalesRemissions(emptyMovements, async (client) => {
    const hasCollections = await customerCollectionsAvailable(client);
    const hasCollectionReversals = hasCollections && await customerCollectionReversalsAvailable(client);
    const join = joinRemissionCollections(hasCollections, hasCollectionReversals);
    const hasCancellations = await salesRemissionCancellationsAvailable(client);
    const cancellation = remissionCancellationSql(hasCancellations);
    // Derivada. Los cargos y abonos se ordenan por fecha e inserción para calcular el saldo de cada movimiento.
    const { rows: [row] } = await client.query<MovementPage>(
      `WITH remissions AS (
         SELECT remission.id, CASE WHEN ${cancellation.canceled} THEN ${invoice} || jsonb_build_object('canceled',true) ELSE ${invoice} END AS invoice,
                remission.issued_at, remission.order_number, remission.charge,
                CASE WHEN ${cancellation.canceled} THEN 0 ELSE remission.charge - collections.paid END AS remaining, remission.user_id,
                coalesce(audit.created_at, remission.issued_at::timestamp AT TIME ZONE 'America/Mexico_City') AS created_at
         FROM tuvansa.sales_remissions AS remission
         LEFT JOIN tuvansa.order_changes AS audit
           ON audit.order_id = remission.order_id AND audit.revision = remission.order_revision
         ${join} ${cancellation.join}
         WHERE remission.company_id = 1 AND remission.customer_id = $1 AND remission.charge > 0
       ), entries AS (
         SELECT id, invoice, issued_at AS movement_date, charge AS amount, remaining,
                invoice->>'movementType' AS movement_type, order_number AS payment_reference,
                ''::text AS policy, 0 AS receipt_number, NULL::text AS collection_number, user_id, created_at,
                NULL::jsonb AS collection_reversal,false AS is_collection_reversal
         FROM remissions
         ${hasCollections ? collectionMovements(hasCollectionReversals) : ''}
         ${hasCollectionReversals ? collectionReversalMovements : ''}
         ${hasCancellations ? cancellationMovements : ''}
       ), ledger AS (
         SELECT *, sum(amount) OVER (ORDER BY movement_date, created_at, id ROWS UNBOUNDED PRECEDING) AS running_balance
         FROM entries
       ), period AS (
         SELECT * FROM ledger WHERE ($2::date IS NULL OR movement_date >= $2) AND ($3::date IS NULL OR movement_date <= $3)
       )
       SELECT coalesce(sum(amount), 0)::float8 AS "totalBalance",
              count(*)::float8 AS "entryCount",
              coalesce(sum(amount) FILTER (WHERE movement_date < $2::date), 0)::float8 AS "openingBalance",
              (SELECT coalesce(sum(amount) FILTER (WHERE amount > 0), 0)::float8 FROM period) AS charges,
              (SELECT coalesce(-sum(amount) FILTER (WHERE amount < 0), 0)::float8 FROM period) AS credits,
              (SELECT coalesce(sum(amount), 0)::float8 FROM period) AS "netMovement",
              (SELECT count(*)::float8 FROM period) AS "movementCount",
              ARRAY(SELECT jsonb_build_object(
                      'id', id, 'invoice', invoice, 'date', movement_date, 'amount', amount, 'remaining', remaining,
                      'movementType', movement_type, 'paymentReference', payment_reference, 'policy', policy,
                      'receiptNumber', receipt_number, 'collectionNumber', collection_number, 'userId', user_id,
                      'collectionReversal',collection_reversal,'isCollectionReversal',is_collection_reversal,
                      'runningBalance', running_balance)
                    FROM period ORDER BY movement_date, created_at, id OFFSET $4 LIMIT $5) AS items,
              (SELECT coalesce(jsonb_object_agg(cutoffs.date::text,
                (SELECT coalesce(sum(amount), 0) FROM ledger WHERE movement_date < cutoffs.date)), '{}'::jsonb)
                FROM unnest($6::date[]) AS cutoffs(date)) AS preceding
       FROM ledger`,
      [criteria.clientId, criteria.dateFrom ?? null, criteria.dateTo ?? null, Math.max(0, criteria.offset - base.summary.movementCount),
        criteria.limit - base.items.length, cutoffs],
    );
    return row ?? emptyMovements;
  });
}

function movementDocument(entry: LocalMovement, legacyBalance: number) {
  const { id, invoice, date, amount, remaining, runningBalance, userId, policy, paymentReference, receiptNumber, collectionNumber } = entry;
  return ClientMovement.create({
    id, date, movementType: { code: entry.movementType, description: entry.isCollectionReversal ? 'Reversión de cobro'
      : collectionNumber ? 'Cobro' : entry.movementType === 'K' ? 'Cancelación de remisión' : 'Remisión' },
    amount: clientMoney(amount), runningBalance: clientMoney(legacyBalance + runningBalance),
    paymentReference, exchangeRate: invoice.currency.exchangeRate, policy, receiptNumber, userId,
    ...(collectionNumber ? { policyId: id, collectionNumber, canReverseCollection: !entry.isCollectionReversal && !entry.collectionReversal,
      isCollectionReversal: entry.isCollectionReversal } : {}),
    ...(entry.collectionReversal ? { collectionReversal: entry.collectionReversal } : {}),
    document: {
      id: invoice.id, number: invoice.number, date: invoice.dates.issuedAt, dueDate: invoice.dates.dueAt,
      reference: invoice.orderNumber, amount: remaining, currencyId: invoice.currency.id, isCanceled: invoice.canceled,
    },
  });
}

export class ClientMovementsWithSalesRemissionsDataSource implements ClientMovementsDataSource {
  constructor(private readonly legacy: LegacyMysqlClientMovementsDataSource) {}

  async searchByClient(criteria: ClientMovementSearchCriteria): Promise<ClientMovementsResult | null> {
    const record = await clientCatalogRecord(criteria.clientId);
    if (record?.deleted) return null;
    const base: ClientMovementsResult | null = record && !record.legacy ? {
      client: catalogIdentity(record.document), items: [],
      summary: { openingBalance: 0, charges: 0, credits: 0, netMovement: 0, closingBalance: 0, movementCount: 0 },
    } : await this.legacy.searchByClient(criteria);
    if (!base) return null;
    if (record?.legacy) base.client = catalogIdentity(record.document, base.client.currentBalance);
    const local = await movementPage(criteria, base);
    if (local.entryCount === 0) return base;

    const legacyBalances = record && !record.legacy ? new Map<number | string, number>()
      : await this.legacy.balanceThroughDates(criteria.clientId, [...new Set(local.items.map(({ date }) => date))]);
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
        charges: clientMoney(base.summary.charges + local.charges), credits: clientMoney(base.summary.credits + local.credits),
        movementCount: base.summary.movementCount + local.movementCount,
      },
      items: [...items, ...local.items.map((entry) => movementDocument(entry, legacyBalances.get(entry.date) ?? 0))],
    };
  }
}
