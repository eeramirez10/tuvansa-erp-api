import type { RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { BankAccountsDataSource } from '../../domain/datasources/bank-accounts-data-source.js';
import { BankAccount, type BankAccountMonthlyValues, type BankAccountNature, type BankAccountSystemType } from '../../domain/entities/bank-account.js';
import type {
  BankAccountNavigationDirection,
  BankAccountSearchCriteria,
  BankAccountSearchResult,
} from '../../domain/repositories/bank-accounts-repository.js';

interface BankAccountRow extends RowDataPacket {
  BSEQ: number;
  BCOD: string;
  BFAM: string;
  BCTA: string;
  BSUCURSAL: string;
  BNOMBRE: string;
  BNATUR: string | number;
  BTIPO: number;
  BMONEDA: number;
  BSALDOR1: number;
  BSALDOB1: number;
  BS100: number;
  BSALDOTR1: number;
  BSALDOMONEDA1: number;
  BSALDOMONEDA1MS12: number;
  BSALDOANTMONEDA1: number;
  BGERENTE: string;
  BTELEFONO: string;
  BNUMCLI: string;
  BCONTROL: string | number;
  BCHEQNUM: number;
  BDEPNUM: number;
  BTRANSFNUM: number;
  BSUBCTAS: string | number;
  BNOPOLIZA: string | number;
  BREPORTE: string;
  BMOVS: string | number;
  BPRESUP: string | number;
  BCIA: number;
  BDEPOS: string | number;
  BPAGOS: string | number;
  BMULTICIA: number;
  BPRORRA1: number;
  BPRORRA2: number;
  BPRORRA3: number;
  BPRORRA4: number;
  BFISCALINFLA: number;
  BDEDUCIETU: string | number;
  BNODEDUCIIVA: string | number;
  BALTA: string;
  [key: string]: unknown;
}

interface CountRow extends RowDataPacket { total: number }
interface IdCodeRow extends RowDataPacket { id: number; code: string }

const eligible = "COALESCE(BGERENTE, '') <> 'T'";
const numberValue = (value: unknown): number => Number(value ?? 0);
const booleanValue = (value: unknown): boolean => value === 1 || value === '1' || value === 'T' || value === 'X';
const nullableDate = (value: string): string | null => value === '' || value === '1900-12-31' ? null : value;

const systemType = (value: number): BankAccountSystemType => {
  if (value === 0) return 'bank';
  if (value === 1) return 'expense';
  return 'other';
};

const nature = (value: string | number): BankAccountNature => value === 1 || value === '1' || value === 'A' ? 'creditor' : 'debtor';

const currencyName = (value: number): string => value === 2 ? 'DOLARES' : 'PESOS';

const monthlyValues = (row: BankAccountRow, startMonth: number): BankAccountMonthlyValues[] => {
  const currencyPrefix = row.BMONEDA === 2 ? 2 : 1;
  return Array.from({ length: 12 }, (_, index) => {
    const absoluteMonth = startMonth + index;
    const suffix = String(absoluteMonth).padStart(2, '0');
    return {
      month: index + 1,
      balance: numberValue(row[`BS${currencyPrefix}${suffix}`]),
      charges: numberValue(row[`BSC${currencyPrefix}${suffix}`]),
      credits: numberValue(row[`BSA${currencyPrefix}${suffix}`]),
      budget: numberValue(row[`BSP${suffix}`]),
    };
  });
};

const toBankAccount = (row: BankAccountRow): BankAccount => BankAccount.create({
  id: row.BSEQ,
  code: row.BCOD,
  family: row.BFAM,
  accountNumber: row.BCTA,
  branch: row.BSUCURSAL,
  name: row.BNOMBRE,
  nature: nature(row.BNATUR),
  systemType: systemType(row.BTIPO),
  currency: { id: row.BMONEDA, name: currencyName(row.BMONEDA) },
  balances: {
    current: row.BSALDOR1,
    bank: row.BSALDOB1,
    previous: row.BS100,
    inTransit: row.BSALDOTR1,
  },
  currencyBalances: {
    current: row.BSALDOMONEDA1,
    month12: row.BSALDOMONEDA1MS12,
    previous: row.BSALDOANTMONEDA1,
  },
  control: {
    manager: row.BGERENTE,
    phone: row.BTELEFONO,
    customerNumber: String(row.BNUMCLI ?? ''),
    controlEnabled: booleanValue(row.BCONTROL),
    nextCheckNumber: row.BCHEQNUM,
    nextDepositNumber: row.BDEPNUM,
    nextTransferNumber: row.BTRANSFNUM,
    subAccounts: booleanValue(row.BSUBCTAS),
    preventJournalEntries: booleanValue(row.BNOPOLIZA),
    format: row.BREPORTE,
    movements: booleanValue(row.BMOVS),
    budgetable: booleanValue(row.BPRESUP),
    company: row.BCIA,
    deposits: booleanValue(row.BDEPOS),
    payments: booleanValue(row.BPAGOS),
    multiCompany: row.BMULTICIA,
  },
  prorationPercentages: {
    sales: row.BPRORRA1,
    inventory: row.BPRORRA2,
    distribution: row.BPRORRA3,
    advance: row.BPRORRA4,
  },
  fiscalReports: {
    annualInflationAdjustment: row.BFISCALINFLA,
    deductibleIetu: booleanValue(row.BDEDUCIETU),
    nonDeductibleVat: booleanValue(row.BNODEDUCIIVA),
  },
  createdAt: nullableDate(row.BALTA),
  ledger: {
    firstPeriod: monthlyValues(row, 1),
    secondPeriod: monthlyValues(row, 13),
  },
});

export class LegacyMysqlBankAccountsDataSource implements BankAccountsDataSource {
  private async byId(bankAccountId: number): Promise<BankAccountRow | undefined> {
    const [rows] = await legacyMysqlPool.execute<BankAccountRow[]>(
      `SELECT FBENC.* FROM FBENC WHERE BSEQ = ? AND ${eligible} LIMIT 1`,
      [bankAccountId],
    );
    return rows[0];
  }

  async findById(bankAccountId: number): Promise<BankAccount | null> {
    const row = await this.byId(bankAccountId);
    return row === undefined ? null : toBankAccount(row);
  }

  async findByCode(code: string): Promise<BankAccount | null> {
    const [rows] = await legacyMysqlPool.execute<BankAccountRow[]>(
      `SELECT FBENC.* FROM FBENC WHERE BCOD = ? AND ${eligible} ORDER BY BSEQ LIMIT 1`,
      [code],
    );
    return rows[0] === undefined ? null : toBankAccount(rows[0]);
  }

  async findFirst(): Promise<BankAccount | null> {
    const [rows] = await legacyMysqlPool.execute<IdCodeRow[]>(
      `SELECT BSEQ AS id, BCOD AS code FROM FBENC WHERE ${eligible} ORDER BY BCOD, BSEQ LIMIT 1`,
    );
    return rows[0] === undefined ? null : this.findById(rows[0].id);
  }

  async findAdjacent(bankAccountId: number, direction: BankAccountNavigationDirection): Promise<BankAccount | null> {
    const [currentRows] = await legacyMysqlPool.execute<IdCodeRow[]>(
      'SELECT BSEQ AS id, BCOD AS code FROM FBENC WHERE BSEQ = ? LIMIT 1',
      [bankAccountId],
    );
    const current = currentRows[0];
    if (current === undefined) return null;
    const operator = direction === 'previous' ? '<' : '>';
    const order = direction === 'previous' ? 'DESC' : 'ASC';
    const [rows] = await legacyMysqlPool.execute<IdCodeRow[]>(
      `SELECT BSEQ AS id, BCOD AS code
         FROM FBENC
        WHERE ${eligible} AND BCOD ${operator} ?
        ORDER BY BCOD ${order}, BSEQ ${order}
        LIMIT 1`,
      [current.code],
    );
    return rows[0] === undefined ? null : this.findById(rows[0].id);
  }

  async search(criteria: BankAccountSearchCriteria): Promise<BankAccountSearchResult> {
    const conditions = [eligible];
    const parameters: Array<string | number> = [];
    if (criteria.query !== undefined) {
      conditions.push('(BCOD LIKE ? OR BCTA LIKE ? OR UPPER(BNOMBRE) LIKE UPPER(?))');
      parameters.push(`${criteria.query}%`, `%${criteria.query}%`, `%${criteria.query}%`);
    }
    if (criteria.code !== undefined) { conditions.push('BCOD LIKE ?'); parameters.push(`${criteria.code}%`); }
    if (criteria.accountNumber !== undefined) { conditions.push('BCTA LIKE ?'); parameters.push(`%${criteria.accountNumber}%`); }
    if (criteria.name !== undefined) { conditions.push('UPPER(BNOMBRE) LIKE UPPER(?)'); parameters.push(`%${criteria.name}%`); }
    const where = conditions.join(' AND ');
    const [rows] = await legacyMysqlPool.execute<BankAccountRow[]>(
      `SELECT FBENC.* FROM FBENC WHERE ${where} ORDER BY BCOD, BSEQ LIMIT ? OFFSET ?`,
      [...parameters, criteria.limit, criteria.offset],
    );
    const [countRows] = await legacyMysqlPool.execute<CountRow[]>(
      `SELECT COUNT(*) AS total FROM FBENC WHERE ${where}`,
      parameters,
    );
    return { items: rows.map(toBankAccount), total: countRows[0]?.total ?? 0 };
  }
}
