import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { BankAccountProps } from '../../../../treasury/banking/domain/entities/bank-account.js';
import { BankAccountsWithCatalogDataSource } from '../../../../treasury/banking/infrastructure/datasources/bank-accounts-with-catalog-data-source.js';
import type { ManualPolicyAccount, ManualPolicyReferences, ManualPolicySettings } from '../../domain/datasources/manual-policy-data-source.js';

interface SettingsRow extends RowDataPacket {
  fiscalStart: string;
  fiscalEnd: string;
  periodYear: number | string;
}
interface CenterRow extends RowDataPacket { code: number; name: string }

const chartAccount = (data: BankAccountProps): ManualPolicyAccount => ({
  id: data.id, code: data.code, name: data.name, type: data.systemType === 'bank' ? 0 : data.systemType === 'expense' ? 1 : 2,
  nature: data.nature === 'creditor' ? 1 : 0,
});
const companyAccount = ({ control }: BankAccountProps) => [0, 1].includes(control.company) && [0, 1].includes(control.multiCompany);
const authorized = (data: BankAccountProps) => companyAccount(data) && !data.control.subAccounts && !data.control.preventJournalEntries
  && (data.systemType === 'bank' ? data.currency.id === 1 : [0, 1].includes(data.currency.id));

export class MysqlManualPolicyReferences implements ManualPolicyReferences {
  constructor(private readonly chart = new BankAccountsWithCatalogDataSource()) {}

  async settings(): Promise<ManualPolicySettings | null> {
    const [[companies], [centers]] = await Promise.all([
      legacyMysqlPool.query<SettingsRow[]>(`SELECT c.CIAFI AS fiscalStart,c.CIAFF AS fiscalEnd,c.CIAPERIODO AS periodYear,
        c.CIACONNIV1,c.CIACONNIV2,c.CIACONNIV3,c.CIACONNIV4,c.CIACONNIV5,c.CIACONNIV6,c.CIACONNIV7,c.CIACONNIV8
        FROM FCIA c WHERE c.CIASEQ=1 AND c.CIAALIAS='TUVANSA' AND SUBSTRING(c.CIAPLUGS,4,1)='X'
        AND TRIM(c.CIAPOLIZACONT)='3' AND EXISTS (SELECT 1 FROM FTIPMV t
          WHERE t.TICLA='3' AND t.TIMULTICIA IN (0,1) AND t.TIFISCAL=0 AND TRIM(t.TIUSUARIOS)='') LIMIT 1`),
      legacyMysqlPool.query<CenterRow[]>(`SELECT CAST(CATCOD AS UNSIGNED) AS code,TRIM(CATDESCR) AS name FROM FALMCAT
        WHERE CATKEY=CONCAT('CEN',TRIM(CATCOD)) AND CATCOD REGEXP '^[1-9][0-9]* *$' AND CATCIA IN (0,1)
        ORDER BY CAST(CATCOD AS UNSIGNED),CATSEQ`),
    ]);
    const row = companies[0];
    if (!row || row.fiscalStart < '1901-01-01' || row.fiscalEnd < row.fiscalStart) return null;
    const periodYear = Number(row.periodYear);
    const levels = Array.from({ length: 8 }, (_, index) => Number(row[`CIACONNIV${index + 1}`])).filter((length) => length > 0);
    if (!Number.isInteger(periodYear) || levels.length < 2) return null;
    return { fiscalStart: row.fiscalStart, fiscalEnd: row.fiscalEnd, periodYear, levels,
      costCenters: [{ code: 0, name: 'Sin centro de costo' }, ...centers] };
  }

  async search(query: string) {
    const { items } = await this.chart.search({ query, offset: 0, limit: 100 });
    return items.map((item) => item.toPrimitives()).filter(authorized).slice(0, 30).map(chartAccount);
  }

  async accounts(codes: string[], levels: number[], lookup?: (code: string) => Promise<BankAccountProps | null>) {
    const prefixes = (code: string) => levels.filter((length) => length < code.length).map((length) => code.slice(0, length));
    const allCodes = [...new Set(codes.flatMap((code) => [code, ...prefixes(code)]))];
    const records = new Map<string, BankAccountProps | null>();
    if (lookup) {
      for (const code of allCodes) records.set(code, await lookup(code));
    } else {
      const found = await Promise.all(allCodes.map((code) => this.chart.findByCode(code)));
      allCodes.forEach((code, index) => records.set(code, found[index]?.toPrimitives() ?? null));
    }
    const result = new Map<string, { account: ManualPolicyAccount; parents: ManualPolicyAccount[] }>();
    for (const code of codes) {
      const leaf = records.get(code);
      const ancestors = prefixes(code).map((prefix) => records.get(prefix));
      if (!leaf || !authorized(leaf) || !levels.includes(code.length) || ancestors.some((ancestor) => !ancestor || !companyAccount(ancestor))) continue;
      result.set(code, { account: chartAccount(leaf), parents: ancestors.map((ancestor) => chartAccount(ancestor!)) });
    }
    return result;
  }
}
