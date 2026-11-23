import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type {
  SupplierPaymentBank, SupplierPaymentReferences, SupplierPaymentSettings,
} from '../../domain/datasources/supplier-payment-data-source.js';

interface ConfigurationRow extends RowDataPacket {
  policyType: string;
  supplierAccount: string;
  supplierAccountName: string;
}

interface BankRow extends RowDataPacket, SupplierPaymentBank {}

export class MysqlSupplierPaymentReferences implements SupplierPaymentReferences {
  async settings(companyId: number, supplierId: number): Promise<SupplierPaymentSettings | null> {
    const [[configuration], [banks]] = await Promise.all([
      legacyMysqlPool.execute<ConfigurationRow[]>(
        `SELECT TRIM(c.CIAPOLIZAEGR) AS policyType, TRIM(s.PRVCTA) AS supplierAccount, TRIM(a.BNOMBRE) AS supplierAccountName
         FROM FCIA c
         JOIN FPRV s ON s.PRVSEQ = ?
         JOIN FBENC a ON a.BCOD = TRIM(s.PRVCTA) AND a.BMOVS = 1 AND a.BCIA IN (0,c.CIASEQ) AND a.BMULTICIA IN (0,c.CIASEQ)
         WHERE c.CIASEQ = ? AND c.CIAALIAS = 'TUVANSA' AND TRIM(c.CIAPOLIZAEGR) = '2' AND s.PRVINTERCIA = 0
           AND EXISTS (
             SELECT 1 FROM FTIPMV t
             WHERE t.TICLA = 'PP' AND t.TIMODULO = 9 AND t.TIMULTICIA IN (0,c.CIASEQ)
               AND t.TIAFCXC = -1 AND t.TIAFBCS = -1 AND t.TIAFINV = 0
           )
           AND EXISTS (
             SELECT 1 FROM FTIPMV t
             WHERE t.TICLA = c.CIAPOLIZAEGR AND t.TIMODULO = 9 AND t.TIMULTICIA IN (0,c.CIASEQ)
           )
         ORDER BY a.BSEQ LIMIT 2`,
        [supplierId, companyId],
      ),
      legacyMysqlPool.execute<BankRow[]>(
        `SELECT BSEQ AS id, TRIM(BCOD) AS code, TRIM(BNOMBRE) AS name
         FROM FBENC
         WHERE BTIPO = 0 AND BMOVS = 1 AND BPAGOS = 1 AND BMONEDA = 1
           AND BCIA IN (0,?) AND BMULTICIA IN (0,?) AND TRIM(BCOD) <> ''
         ORDER BY BCOD,BSEQ`,
        [companyId, companyId],
      ),
    ]);
    const [rules] = configuration;
    if (!rules || configuration.length !== 1) return null;
    const { policyType, supplierAccount, supplierAccountName } = rules;
    return { policyType, supplierAccount, supplierAccountName, bankAccounts: banks.map(({ id, code, name }) => ({ id, code, name })) };
  }
}
