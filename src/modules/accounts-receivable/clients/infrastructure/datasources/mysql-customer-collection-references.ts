import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type {
  CustomerCollectionBank, CustomerCollectionReferences, CustomerCollectionSettings,
} from '../../domain/datasources/customer-collection-data-source.js';

interface SettingRow extends RowDataPacket, Omit<CustomerCollectionSettings, 'bankAccounts'> {}
interface BankRow extends RowDataPacket, CustomerCollectionBank {}

export class MysqlCustomerCollectionReferences implements CustomerCollectionReferences {
  async settings(companyId: number, clientId: number): Promise<CustomerCollectionSettings | null> {
    // Derivada del PA, la póliza aplicada y las cuentas efectivas del catálogo Omnis.
    const [[settings], [banks]] = await Promise.all([
      legacyMysqlPool.execute<SettingRow[]>(
        `SELECT TRIM(c.CIAPOLIZAING) AS policyType, c.CIAFI AS fiscalStart, c.CIAFF AS fiscalEnd,
                TRIM(a.BCOD) AS clientAccount, TRIM(a.BNOMBRE) AS clientAccountName
         FROM FCIA c
         JOIN FCLI cl ON cl.CLISEQ = ?
         JOIN FBENC a ON a.BCOD = COALESCE(NULLIF(TRIM(cl.CLICTA),''), TRIM(c.CIACTACXC))
           AND a.BMOVS = 1 AND a.BCIA IN (0,c.CIASEQ) AND a.BMULTICIA IN (0,c.CIASEQ)
         WHERE c.CIASEQ = ? AND c.CIAALIAS = 'TUVANSA' AND TRIM(c.CIAPOLIZAING) = '1'
           AND TRIM(c.CIACTAIVACOBRODE) = '' AND TRIM(c.CIACTAIVACOBROA) = ''
           AND cl.CLIINTERCIA = 0 AND cl.CLIMONEDA IN (0,1)
           AND TRIM(cl.CLIAPLICAR) IN ('',TRIM(cl.CLICOD))
           AND EXISTS (
             SELECT 1 FROM FTIPMV t WHERE t.TICLA = 'PA' AND t.TIMODULO = 9 AND t.TIMULTICIA IN (0,c.CIASEQ)
               AND t.TIAFCXC = -1 AND t.TIAFBCS = 1 AND t.TIAFINV = 0
           )
         ORDER BY a.BSEQ LIMIT 2`, [clientId, companyId],
      ),
      legacyMysqlPool.execute<BankRow[]>(
        `SELECT BSEQ AS id, TRIM(BCOD) AS code, TRIM(BNOMBRE) AS name FROM FBENC
         WHERE BTIPO = 0 AND BMOVS = 1 AND BDEPOS = 1 AND BMONEDA = 1
           AND BCIA IN (0,?) AND BMULTICIA IN (0,?) AND TRIM(BCOD) <> ''
         ORDER BY BCOD,BSEQ`, [companyId, companyId],
      ),
    ]);
    const [configuration] = settings;
    if (settings.length !== 1 || !configuration?.clientAccount || !configuration.fiscalStart || !configuration.fiscalEnd) return null;
    const { policyType, fiscalStart, fiscalEnd, clientAccount, clientAccountName } = configuration;
    return { policyType, fiscalStart, fiscalEnd, clientAccount, clientAccountName, bankAccounts: banks.map(({ id, code, name }) => ({ id, code, name })) };
  }
}
