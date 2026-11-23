import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type {
  ExpenseAccount, ExpenseCatalogEntry, ExpenseProduct, ExpenseReferences, ExpenseSettings, ExpenseSupplier, ExpenseTax,
} from '../../domain/datasources/purchase-expense-data-source.js';

interface SettingsRow extends RowDataPacket {
  fiscalStart: string;
  fiscalEnd: string;
  vat0: number;
  vat1: number;
  vat2: number;
  vat: string;
  vatWithholding: string;
  incomeWithholding: string;
}

interface AccountRow extends RowDataPacket, ExpenseAccount {}
interface CatalogRow extends RowDataPacket, ExpenseCatalogEntry {}
interface SupplierRow extends RowDataPacket, ExpenseSupplier {}
interface ProductRow extends RowDataPacket, Omit<ExpenseProduct, 'vatExempt' | 'retentionsEligible'> {
  vatExempt: number;
  retentionsEligible: number;
}

// Each fallback is a verified TUVANSA account for this tax. It still requires an explicit selection.
const observedTaxAccounts: Record<ExpenseTax, string> = {
  vat: '1119001', vatWithholding: '2016013', incomeWithholding: '2016018',
};

export class MysqlPurchaseExpenseReferences implements ExpenseReferences {
  async settings(companyId: number): Promise<ExpenseSettings | null> {
    if (companyId !== 1) return null;
    const [rows] = await legacyMysqlPool.execute<SettingsRow[]>(
      `SELECT c.CIAFI AS fiscalStart,c.CIAFF AS fiscalEnd,
         t.TIIVA0 AS vat0,t.TIIVA1 AS vat1,t.TIIVA2 AS vat2,
         TRIM(c.CIACTAIVAPAGOACRDE) AS vat,TRIM(c.CIACTARETIVADE) AS vatWithholding,
         TRIM(c.CIACTARETISRDE) AS incomeWithholding
       FROM FCIA c JOIN FTIPMV t ON t.TICLA='GA' AND t.TIMULTICIA=c.CIASEQ AND t.TIMODULO=7
       WHERE c.CIASEQ=? AND c.CIAALIAS='TUVANSA' AND SUBSTRING(c.CIAPLUGS,4,1)='X'
         AND t.TIAFCXC=1 AND t.TIAFBCS=0 AND t.TIFISCAL=1 AND TRIM(c.CIAPOLIZACONT)='3'
         AND EXISTS (SELECT 1 FROM FTIPMV p WHERE p.TICLA='3' AND p.TIMODULO=9
           AND p.TIMULTICIA IN (0,c.CIASEQ) AND p.TIFISCAL=0)
       ORDER BY t.TISEQ LIMIT 1`, [companyId],
    );
    const row = rows[0];
    if (!row || row.fiscalStart < '1901-01-01' || row.fiscalEnd < row.fiscalStart) return null;

    const roles = Object.keys(observedTaxAccounts) as ExpenseTax[];
    const [[costCenters], accounts] = await Promise.all([
      legacyMysqlPool.execute<CatalogRow[]>(
        `SELECT TRIM(CATCOD) AS code,TRIM(CATDESCR) AS name FROM FALMCAT
         WHERE CATKEY=CONCAT('CEN',TRIM(CATCOD)) AND CATCOD REGEXP '^[1-9][0-9]* *$'
           AND CATCIA IN (0,?) ORDER BY CAST(CATCOD AS UNSIGNED),CATSEQ`, [companyId],
      ),
      this.accounts(companyId, roles.flatMap((role) => [row[role], observedTaxAccounts[role]])),
    ]);
    const defaultTaxAccounts = { vat: null, vatWithholding: null, incomeWithholding: null } as ExpenseSettings['defaultTaxAccounts'];
    const taxAccounts: ExpenseSettings['taxAccounts'] = { vat: [], vatWithholding: [], incomeWithholding: [] };
    for (const role of roles) {
      const configured = accounts.get(row[role]);
      const observed = accounts.get(observedTaxAccounts[role]);
      defaultTaxAccounts[role] = configured ?? null;
      const available = configured ?? observed;
      if (available) taxAccounts[role].push(available);
    }
    return {
      fiscalStart: row.fiscalStart, fiscalEnd: row.fiscalEnd, vatRates: [row.vat0, row.vat1, row.vat2],
      costCenters: [{ code: '0', name: 'Sin centro de costo' }, ...costCenters], defaultTaxAccounts, taxAccounts,
    };
  }

  async supplier(companyId: number, code: string): Promise<ExpenseSupplier | null> {
    const [rows] = await legacyMysqlPool.execute<SupplierRow[]>(
      `SELECT PRVSEQ AS id,TRIM(PRVCOD) AS code,TRIM(PRVNOM) AS name,PRVTIPOIVA AS vatType,
         PRVRETIVA AS vatWithholdingRate,PRVRETISR AS incomeWithholdingRate,PRVPLAZO AS terms,
         TRIM(PRVCTA) AS accountCode
       FROM FPRV WHERE PRVCOD=? AND PRVBAJA='1900-12-31' AND PRVMULTICIA IN (0,?)
         AND PRVMONEDA IN (0,1) AND PRVINTERCIA=0 ORDER BY PRVSEQ LIMIT 1`, [code, companyId],
    );
    return rows[0] ?? null;
  }

  async product(code: string): Promise<ExpenseProduct | null> {
    const [rows] = await legacyMysqlPool.execute<ProductRow[]>(
      `SELECT ISEQ AS id,TRIM(ICOD) AS code,TRIM(IDESCR) AS name,IPORCIVA<>0 AS vatExempt,
         IRETIVA>0 AS retentionsEligible,TRIM(ICTA) AS accountCode
       FROM FINV WHERE ICOD=? AND ITIPO=4 AND IINACTIVO=0 AND IBAJA='1900-12-31'
         AND IPORCIEPES=0 AND IFIJOIEPS=0 ORDER BY ISEQ LIMIT 1`, [code],
    );
    const row = rows[0];
    return row ? { ...row, vatExempt: Boolean(row.vatExempt), retentionsEligible: Boolean(row.retentionsEligible) } : null;
  }

  async accounts(companyId: number, codes: string[]): Promise<Map<string, ExpenseAccount>> {
    const distinct = [...new Set(codes.filter(Boolean))];
    if (!distinct.length) return new Map();
    const [rows] = await legacyMysqlPool.execute<AccountRow[]>(
      `SELECT BSEQ AS id,TRIM(BCOD) AS code,TRIM(BNOMBRE) AS name FROM FBENC
       WHERE BCOD IN (${distinct.map(() => '?').join(',')}) AND BMOVS=1 AND BNOPOLIZA=0
         AND BTIPO IN (1,2) AND BCIA IN (0,?) AND BMULTICIA IN (0,?) ORDER BY BSEQ DESC`,
      [...distinct, companyId, companyId],
    );
    return new Map(rows.map((row) => [row.code, row]));
  }

  async existingReference(references: string[]): Promise<string | null> {
    if (!references.length) return null;
    // ERECEP#12/412 uses a global FDOC lookup, including documents from other movement types.
    const [rows] = await legacyMysqlPool.execute<(RowDataPacket & { reference: string })[]>(
      `SELECT TRIM(DREFERELLOS) AS reference FROM FDOC
       WHERE DREFERELLOS IN (${references.map(() => '?').join(',')}) LIMIT 1`, references,
    );
    return rows[0]?.reference ?? null;
  }
}
