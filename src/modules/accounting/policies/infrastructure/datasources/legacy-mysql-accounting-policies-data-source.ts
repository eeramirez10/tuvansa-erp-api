import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { AccountingPoliciesDataSource } from '../../domain/datasources/accounting-policies-data-source.js';
import { AccountingPolicy, type AccountingPolicyMovement } from '../../domain/entities/accounting-policy.js';
import type {
  AccountingPolicyClassificationsResult,
  AccountingPolicyNavigationDirection,
  AccountingPolicySearchCriteria,
  AccountingPolicySearchResult,
} from '../../domain/repositories/accounting-policies-repository.js';

interface HeaderRow extends RowDataPacket {
  id: number; number: string; concept: string; date: string; applied: number;
  beneficiary: string; cheque: string; amountInWords: string; userId: number;
  report: string; family: string; auditAt: string; postDate: string;
  classification1: string; classification2: string; exchangeRate: number;
  usedAt: string; company: number; origin: string;
}

interface MovementRow extends RowDataPacket {
  id: number; accountId: number; accountCode: string | null; accountName: string | null;
  debit: number; credit: number; reference: string; exchangeRate: number;
  costCenter: number; reconciled: string; accountType: number;
}

interface IdentityRow extends RowDataPacket { id: number; number: string }
interface CountRow extends RowDataPacket { total: number }

const policyFilter = 'FPOLIZA.POEST = 0 AND FPOLIZA.POCIA = 1';

const selectHeader = `
  FPOLIZA.POSEQ AS id,
  FPOLIZA.PONUM AS number,
  FPOLIZA.PODESCR AS concept,
  FPOLIZA.POFECHA AS date,
  FPOLIZA.POAPLICADA AS applied,
  FPOLIZA.POBENEF AS beneficiary,
  FPOLIZA.POCHEQUE AS cheque,
  FPOLIZA.POLETRA AS amountInWords,
  FPOLIZA.POUSR AS userId,
  FPOLIZA.POREPORTE AS report,
  FPOLIZA.POFAMILIA AS family,
  FPOLIZA.POAUDIT AS auditAt,
  FPOLIZA.POPOSTFECHA AS postDate,
  FPOLIZA.POPAR1 AS classification1,
  FPOLIZA.POPAR2 AS classification2,
  FPOLIZA.POCAMBIO AS exchangeRate,
  FPOLIZA.POFUSA AS usedAt,
  FPOLIZA.POCIA AS company,
  FPOLIZA.POORIGEN AS origin
`;

const selectMovements = `
  FBANMOV.BASEQ AS id,
  FBANMOV.BSEQ AS accountId,
  FBENC.BCOD AS accountCode,
  FBENC.BNOMBRE AS accountName,
  FBANMOV.BAIMPOR AS debit,
  FBANMOV.BAIMPORNEG AS credit,
  FBANMOV.BABENEF AS reference,
  FBANMOV.BATIPOC AS exchangeRate,
  FBANMOV.BACENCOS AS costCenter,
  FBANMOV.BAOK AS reconciled,
  FBENC.BTIPO AS accountType
`;

const nullableDate = (value: string): string | null => value === '1900-12-31' || value.startsWith('1900-12-31 ') ? null : value;
const numeric = (value: unknown): number => Number(value ?? 0);

const toMovement = (row: MovementRow): AccountingPolicyMovement => ({
  id: row.id,
  accountId: row.accountId,
  accountCode: row.accountCode ?? '',
  accountName: row.accountName ?? '',
  debit: numeric(row.debit),
  credit: numeric(row.credit),
  reference: row.reference ?? '',
  exchangeRate: numeric(row.exchangeRate),
  costCenter: numeric(row.costCenter),
  reconciled: row.reconciled !== '',
  accountType: numeric(row.accountType),
});

const toPolicy = (row: HeaderRow, movements: AccountingPolicyMovement[]): AccountingPolicy => {
  const debit = movements.reduce((total, movement) => total + movement.debit, 0);
  const credit = movements.reduce((total, movement) => total + movement.credit, 0);
  return AccountingPolicy.create({
    id: row.id,
    number: row.number,
    date: nullableDate(row.date),
    cheque: row.cheque,
    company: numeric(row.company),
    origin: row.origin,
    applied: row.applied !== 0,
    beneficiary: row.beneficiary,
    family: row.family,
    concept: row.concept,
    amountInWords: row.amountInWords,
    userId: numeric(row.userId),
    report: row.report,
    auditAt: nullableDate(row.auditAt),
    postDate: nullableDate(row.postDate),
    classifications: [row.classification1, row.classification2],
    exchangeRate: numeric(row.exchangeRate),
    usedAt: nullableDate(row.usedAt),
    totals: { debit, credit, difference: debit - credit },
    movements,
  });
};

export class LegacyMysqlAccountingPoliciesDataSource implements AccountingPoliciesDataSource {
  private async movements(id: number): Promise<AccountingPolicyMovement[]> {
    const [rows] = await legacyMysqlPool.execute<MovementRow[]>(
      `SELECT ${selectMovements}
       FROM FBANMOV
       LEFT JOIN FPOLIZA ON FBANMOV.POSEQ = FPOLIZA.POSEQ
       LEFT JOIN FBENC ON FBANMOV.BSEQ = FBENC.BSEQ
       WHERE FPOLIZA.POSEQ = ?
       ORDER BY FBANMOV.BASEQ`,
      [id],
    );
    return rows.map(toMovement);
  }

  private async header(where: string, parameters: Array<string | number>): Promise<AccountingPolicy | null> {
    const [rows] = await legacyMysqlPool.execute<HeaderRow[]>(
      `SELECT ${selectHeader}
       FROM FPOLIZA
       WHERE ${policyFilter} AND ${where}
       ORDER BY FPOLIZA.POSEQ DESC LIMIT 1`,
      parameters,
    );
    const row = rows[0];
    return row === undefined ? null : toPolicy(row, await this.movements(row.id));
  }

  findById(id: number): Promise<AccountingPolicy | null> {
    return this.header('FPOLIZA.POSEQ = ?', [id]);
  }

  findByNumber(number: string): Promise<AccountingPolicy | null> {
    return this.header('FPOLIZA.PONUM = ?', [number]);
  }

  async search(criteria: AccountingPolicySearchCriteria): Promise<AccountingPolicySearchResult> {
    const conditions = [policyFilter];
    const parameters: Array<string | number> = [];
    if (criteria.query !== undefined) {
      conditions.push('(UPPER(FPOLIZA.PONUM) LIKE UPPER(?) OR UPPER(FPOLIZA.PODESCR) LIKE UPPER(?) OR UPPER(FPOLIZA.POBENEF) LIKE UPPER(?) OR UPPER(FPOLIZA.POCHEQUE) LIKE UPPER(?))');
      parameters.push(...Array(4).fill(`%${criteria.query}%`));
    }
    if (criteria.number !== undefined) { conditions.push('FPOLIZA.PONUM LIKE ?'); parameters.push(`${criteria.number}%`); }
    if (criteria.date !== undefined) { conditions.push('FPOLIZA.POFECHA = ?'); parameters.push(criteria.date); }
    if (criteria.applied !== undefined) { conditions.push('FPOLIZA.POAPLICADA = ?'); parameters.push(criteria.applied ? 1 : 0); }
    if (criteria.family !== undefined) { conditions.push('FPOLIZA.POFAMILIA LIKE ?'); parameters.push(`${criteria.family}%`); }
    if (criteria.cheque !== undefined) { conditions.push('FPOLIZA.POCHEQUE LIKE ?'); parameters.push(`${criteria.cheque}%`); }
    const where = conditions.join(' AND ');
    const hasFilters = Object.keys(criteria).some((key) => !['offset', 'limit'].includes(key));
    const order = hasFilters ? 'FPOLIZA.PONUM, FPOLIZA.POSEQ' : 'FPOLIZA.POSEQ DESC';
    const [rows] = await legacyMysqlPool.execute<HeaderRow[]>(
      `SELECT ${selectHeader} FROM FPOLIZA
       WHERE ${where}
       ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...parameters, criteria.limit, criteria.offset],
    );
    const [countRows] = await legacyMysqlPool.execute<CountRow[]>(
      `SELECT COUNT(*) AS total FROM FPOLIZA WHERE ${where}`,
      parameters,
    );
    return { items: rows.map((row) => toPolicy(row, [])), total: countRows[0]?.total ?? 0 };
  }

  async findAdjacent(id: number, direction: AccountingPolicyNavigationDirection): Promise<AccountingPolicy | null> {
    const [currentRows] = await legacyMysqlPool.execute<IdentityRow[]>(
      `SELECT POSEQ AS id, PONUM AS number FROM FPOLIZA WHERE ${policyFilter} AND POSEQ = ? LIMIT 1`,
      [id],
    );
    const current = currentRows[0];
    if (current === undefined) return null;
    const operator = direction === 'previous' ? '<' : '>';
    const order = direction === 'previous' ? 'DESC' : 'ASC';
    const [rows] = await legacyMysqlPool.execute<IdentityRow[]>(
      `SELECT POSEQ AS id, PONUM AS number FROM FPOLIZA
       WHERE ${policyFilter} AND PONUM ${operator} ?
       ORDER BY PONUM ${order}, POSEQ ${order} LIMIT 1`,
      [current.number],
    );
    return rows[0] === undefined ? null : this.findById(rows[0].id);
  }

  async getClassifications(id: number): Promise<AccountingPolicyClassificationsResult | null> {
    const policy = await this.findById(id);
    if (policy === null) return null;
    const primitive = policy.toPrimitives();
    const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
      `SELECT FAG.AGNUM AS code, FAG.AGDESCR AS description, FAG.AGTNUM AS compositeCode
       FROM FAG
       WHERE FAG.AGT = '4' AND FAG.AGTIPO = 3
       ORDER BY FAG.AGT, FAG.AGSEQ`,
    );
    return {
      policy: { id: primitive.id, number: primitive.number },
      key: 'classifications', section: 'actions', button: 'Clasificar', source: 'mysql',
      items: rows.map((row) => ({ ...row })),
      summary: { current: primitive.classifications },
    };
  }
}
