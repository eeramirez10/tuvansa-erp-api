import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import {
  isLocalPurchaseReceptionId, readLocalPurchaseReceptions,
} from '../../../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-reception-writes.js';
import type { AccountingPoliciesDataSource } from '../../domain/datasources/accounting-policies-data-source.js';
import { AccountingPolicy, type AccountingPolicyMovement } from '../../domain/entities/accounting-policy.js';
import type {
  AccountingPolicyNavigationDirection, AccountingPolicySearchCriteria, AccountingPolicySearchResult,
} from '../../domain/repositories/accounting-policies-repository.js';
import type { LegacyMysqlAccountingPoliciesDataSource } from './legacy-mysql-accounting-policies-data-source.js';

interface ReceiptPolicyHeader {
  id: number;
  number: string;
  company: number;
  userId: number;
  date: string;
  cheque: string;
  beneficiary: string;
  concept: string;
  auditAt: string;
  exchangeRate: number;
}

interface ReceiptPolicyRecord extends ReceiptPolicyHeader {
  lines: { account: string; department: string; debit: number; credit: number }[];
}

interface AccountRow extends RowDataPacket {
  id: number;
  code: string;
  name: string;
  type: number;
}

const family = 'COMPRAS';
const headers = `
    id::float8 AS id, accounting->>'number' AS number, company_id AS company, user_id AS "userId",
    result #>> '{reception,dates,receivedAt}' AS date, number AS cheque,
    result #>> '{reception,supplier,name}' AS beneficiary,
    concat('Recepción ', number, '  Referencia ', result #>> '{reception,supplierReference}', ' O.C. ', order_number) AS concept,
    created_at::text AS "auditAt", coalesce((payable->>'exchangeRate')::numeric, 1)::float8 AS "exchangeRate"`;
const source = 'FROM tuvansa.purchase_receptions WHERE company_id = 1 AND accounting IS NOT NULL';
const money = (amount: number) => Number(amount.toFixed(2));

function receiptPolicy(header: ReceiptPolicyHeader, movements: AccountingPolicyMovement[] = []): AccountingPolicy {
  const { id, number, company, userId, date, cheque, beneficiary, concept, auditAt, exchangeRate } = header;
  const debit = money(movements.reduce((sum, line) => sum + line.debit, 0));
  const credit = money(movements.reduce((sum, line) => sum + line.credit, 0));
  return AccountingPolicy.create({
    id, number, date, cheque, company, userId, origin: family, applied: true, beneficiary, family, concept,
    amountInWords: '', report: '', auditAt, postDate: null, classifications: ['', ''], exchangeRate, usedAt: null,
    totals: { debit, credit, difference: money(debit - credit) }, movements,
  });
}

function comparePolicyNumbers(left: string, right: string): number {
  const normalizedLeft = left.toUpperCase();
  const normalizedRight = right.toUpperCase();
  return normalizedLeft < normalizedRight ? -1 : Number(normalizedLeft > normalizedRight);
}

async function policyWithMovements(record: ReceiptPolicyRecord): Promise<AccountingPolicy> {
  if (record.lines.length === 0) return receiptPolicy(record);
  const codes = [...new Set(record.lines.map(({ account }) => account))];
  // Derivada. Completa las cuentas de la póliza web con el catálogo de Contabilidad.
  const [rows] = await legacyMysqlPool.query<AccountRow[]>(
    'SELECT BSEQ AS id, BCOD AS code, BNOMBRE AS name, BTIPO AS type FROM FBENC WHERE BCOD IN (?) ORDER BY BSEQ', [codes],
  );
  const accounts = new Map<string, AccountRow>();
  for (const row of rows) {
    const code = row.code.trim();
    if (!accounts.has(code)) accounts.set(code, row);
  }
  return receiptPolicy(record, record.lines.map(({ account, department, debit, credit }, index) => {
    const details = accounts.get(account);
    return {
      id: index + 1, accountId: details?.id ?? 0, accountCode: account, accountName: details?.name ?? '',
      debit, credit, reference: '', exchangeRate: record.exchangeRate, costCenter: Number(department) || 0,
      reconciled: false, accountType: details?.type ?? 0,
    };
  }));
}

export class AccountingPoliciesWithPurchaseReceptionsDataSource implements AccountingPoliciesDataSource {
  constructor(private readonly legacy: LegacyMysqlAccountingPoliciesDataSource) {}

  private record(field: 'id' | 'number', value: number | string) {
    const filter = field === 'id' ? 'id' : "upper(accounting->>'number')";
    return readLocalPurchaseReceptions<ReceiptPolicyRecord | null>(null, async (client) => {
      const { rows: [row] } = await client.query<ReceiptPolicyRecord>(
        `SELECT ${headers}, accounting->'lines' AS lines ${source} AND ${filter} = $1`, [value],
      );
      return row ?? null;
    });
  }

  async findById(id: number) {
    if (!isLocalPurchaseReceptionId(id)) return this.legacy.findById(id);
    const local = await this.record('id', id);
    return local ? policyWithMovements(local) : null;
  }

  async findByNumber(number: string) {
    const local = await this.record('number', number.toUpperCase());
    return local ? policyWithMovements(local) : this.legacy.findByNumber(number);
  }

  private searchLocal(criteria: AccountingPolicySearchCriteria, filtered: boolean, offset: number, limit: number) {
    if (criteria.applied === false) return Promise.resolve({ items: [], total: 0 });
    const conditions = [];
    const values: (string | number)[] = [];
    if (criteria.query !== undefined) {
      values.push(`%${criteria.query}%`);
      conditions.push('(number ILIKE $1 OR concept ILIKE $1 OR beneficiary ILIKE $1 OR cheque ILIKE $1)');
    }
    for (const [field, filter] of [['number', criteria.number], ['cheque', criteria.cheque]] as const) {
      if (filter === undefined) continue;
      values.push(`${filter}%`);
      conditions.push(`${field} ILIKE $${values.length}`);
    }
    if (criteria.family !== undefined) {
      values.push(`${criteria.family}%`);
      conditions.push(`'${family}' ILIKE $${values.length}`);
    }
    if (criteria.date !== undefined) {
      values.push(criteria.date);
      conditions.push(`date = $${values.length}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const order = filtered ? 'upper(number), id' : 'id DESC';
    values.push(offset, limit);
    return readLocalPurchaseReceptions<{ items: ReceiptPolicyHeader[]; total: number }>({ items: [], total: 0 }, async (client) => {
      // Derivada. Proyecta las pólizas guardadas al recibir una orden de compra.
      const { rows: [row] } = await client.query<{ items: ReceiptPolicyHeader[]; total: string }>(
        `WITH policies AS (SELECT ${headers} ${source}),
              matched AS (SELECT * FROM policies ${where})
         SELECT (SELECT count(*) FROM matched) AS total,
                ARRAY(SELECT to_jsonb(matched) FROM matched
                      ORDER BY ${order} OFFSET $${values.length - 1} LIMIT $${values.length}) AS items`, values,
      );
      return { items: row?.items ?? [], total: Number(row?.total ?? 0) };
    });
  }

  async search(criteria: AccountingPolicySearchCriteria): Promise<AccountingPolicySearchResult> {
    const { offset, limit } = criteria;
    const filtered = [criteria.query, criteria.number, criteria.date, criteria.applied, criteria.family, criteria.cheque]
      .some((value) => value !== undefined);
    const local = await this.searchLocal(criteria, filtered, filtered ? 0 : offset, filtered ? offset + limit : limit);
    if (local.total === 0) return this.legacy.search(criteria);
    if (!filtered) {
      // Local ids follow legacy ids in the default newest-first order.
      const legacy = await this.legacy.search({ ...criteria, offset: Math.max(offset - local.total, 0), limit: limit - local.items.length });
      return { items: [...local.items.map((header) => receiptPolicy(header)), ...legacy.items], total: local.total + legacy.total };
    }

    // Every legacy row before this offset is also before the requested combined page.
    const legacyOffset = Math.max(offset - local.total, 0);
    const legacy = await this.legacy.search({ ...criteria, offset: legacyOffset, limit: offset + limit - legacyOffset });
    const merged = [
      ...local.items.map((header) => ({ id: header.id, number: header.number, entity: receiptPolicy(header) })),
      ...legacy.items.map((entity) => {
        const { id, number } = entity.toPrimitives();
        return { id, number, entity };
      }),
    ].sort((left, right) => comparePolicyNumbers(left.number, right.number) || left.id - right.id);
    return {
      items: merged.slice(offset - legacyOffset, offset + limit - legacyOffset).map(({ entity }) => entity),
      total: local.total + legacy.total,
    };
  }

  async findAdjacent(id: number, direction: AccountingPolicyNavigationDirection) {
    const number = isLocalPurchaseReceptionId(id)
      ? (await this.record('id', id))?.number ?? null
      : await this.legacy.findNumberById(id);
    if (number === null) return null;
    const previous = direction === 'previous';
    const [local, legacy] = await Promise.all([
      readLocalPurchaseReceptions<ReceiptPolicyRecord | null>(null, async (client) => {
        const { rows: [row] } = await client.query<ReceiptPolicyRecord>(
          `SELECT ${headers}, accounting->'lines' AS lines ${source}
           AND upper(accounting->>'number') ${previous ? '<' : '>'} $1
           ORDER BY upper(accounting->>'number') ${previous ? 'DESC' : 'ASC'}, id ${previous ? 'DESC' : 'ASC'} LIMIT 1`,
          [number.toUpperCase()],
        );
        return row ?? null;
      }),
      this.legacy.findAdjacentByNumber(number, direction),
    ]);

    if (!local) return legacy;
    if (legacy) {
      const comparison = comparePolicyNumbers(local.number, legacy.toPrimitives().number);
      if (previous ? comparison < 0 : comparison > 0) return legacy;
    }
    return policyWithMovements(local);
  }

  async getClassifications(id: number) {
    if (!isLocalPurchaseReceptionId(id)) return this.legacy.getClassifications(id);
    const local = await this.record('id', id);
    return local ? this.legacy.getClassificationCatalog(receiptPolicy(local)) : null;
  }
}
