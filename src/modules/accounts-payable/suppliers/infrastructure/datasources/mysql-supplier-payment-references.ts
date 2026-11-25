import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { BankAccountLookup } from '../../../../treasury/banking/domain/entities/bank-account.js';
import { BankAccountsWithCatalogDataSource } from '../../../../treasury/banking/infrastructure/datasources/bank-accounts-with-catalog-data-source.js';
import { supplierCatalogRecord } from './postgres-supplier-catalog-data-source.js';
import type {
  SupplierPaymentBank, SupplierPaymentCatalogTerms, SupplierPaymentLiability, SupplierPaymentReferences, SupplierPaymentSettings,
} from '../../domain/datasources/supplier-payment-data-source.js';

interface ConfigurationRow extends RowDataPacket {
  policyType: string;
  supplierAccount: string;
  supplierAccountName: string;
}

export class MysqlSupplierPaymentReferences implements SupplierPaymentReferences {
  constructor(private readonly accounts: Pick<BankAccountsWithCatalogDataSource, 'postingAccounts'> = new BankAccountsWithCatalogDataSource()) {}

  private async banks(companyId: number, selectedBankId?: number, lookup?: BankAccountLookup): Promise<SupplierPaymentBank[]> {
    const found = await this.accounts.postingAccounts(companyId, 'payments', selectedBankId, lookup);
    return found.map(({ id, code, name }) => ({ id, code: code.trim(), name: name.trim() }));
  }

  async settings(companyId: number, supplierId: number, selectedBankId?: number, lookup?: BankAccountLookup,
    liability?: SupplierPaymentLiability | null, catalog?: SupplierPaymentCatalogTerms | null): Promise<SupplierPaymentSettings | null> {
    const supplier = catalog === undefined ? await supplierCatalogRecord(supplierId) : null;
    if (supplier?.deleted) return null;
    const terms = catalog ?? (supplier ? { accountCode: supplier.supplier.fiscal.accountingAccount, intercompany: supplier.intercompany } : null);
    if (terms?.intercompany) return null;
    const supplierSource = terms ? '' : 'JOIN FPRV s ON s.PRVSEQ=?';
    const supplierAccountSql = terms ? '?' : 'TRIM(s.PRVCTA)';
    const settingsParams = terms ? [liability?.code ?? null, terms.accountCode, companyId] : [supplierId, liability?.code ?? null, companyId];
    const [[configuration], bankAccounts] = await Promise.all([
      legacyMysqlPool.execute<ConfigurationRow[]>(
        `SELECT TRIM(c.CIAPOLIZAEGR) AS policyType, TRIM(a.BCOD) AS supplierAccount, TRIM(a.BNOMBRE) AS supplierAccountName
         FROM FCIA c
         ${supplierSource}
         JOIN FBENC a ON a.BCOD = coalesce(?,${supplierAccountSql}) AND a.BMOVS = 1
          AND a.BCIA IN (0,c.CIASEQ) AND a.BMULTICIA IN (0,c.CIASEQ)
         WHERE c.CIASEQ = ? AND c.CIAALIAS = 'TUVANSA' AND TRIM(c.CIAPOLIZAEGR) = '2' ${terms ? '' : 'AND s.PRVINTERCIA=0'}
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
        settingsParams,
      ),
      this.banks(companyId, selectedBankId, lookup),
    ]);
    const [rules] = configuration;
    if (!rules || configuration.length !== 1) return null;
    const { policyType, supplierAccount, supplierAccountName } = rules;
    return { policyType, supplierAccount, supplierAccountName: liability?.name || supplierAccountName, bankAccounts };
  }
}
