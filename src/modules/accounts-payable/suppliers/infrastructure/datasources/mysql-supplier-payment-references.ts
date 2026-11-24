import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { BankAccountsDataSource } from '../../../../treasury/banking/domain/datasources/bank-accounts-data-source.js';
import type { BankAccountLookup } from '../../../../treasury/banking/domain/entities/bank-account.js';
import { permitsBankPosting } from '../../../../treasury/banking/domain/entities/bank-posting-role.js';
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

interface BankIdRow extends RowDataPacket { id: number }

export class MysqlSupplierPaymentReferences implements SupplierPaymentReferences {
  constructor(private readonly accounts: Pick<BankAccountsDataSource, 'findById'> = new BankAccountsWithCatalogDataSource()) {}

  private async banks(companyId: number, selectedBankId?: number, lookup?: BankAccountLookup): Promise<SupplierPaymentBank[]> {
    const ids = selectedBankId === undefined ? await this.nativeCandidates(companyId) : [selectedBankId];
    const find: BankAccountLookup = lookup ?? (async (id) => (await this.accounts.findById(id))?.toPrimitives() ?? null);
    const found = await Promise.all(ids.map(find));
    return found.flatMap((account) => account && permitsBankPosting(account, companyId, 'payments')
      ? [{ id: account.id, code: account.code.trim(), name: account.name.trim() }] : []);
  }

  private async nativeCandidates(companyId: number): Promise<number[]> {
    // El permiso de pagos se lee del catálogo efectivo porque Cambio lo puede editar.
    const [rows] = await legacyMysqlPool.execute<BankIdRow[]>(
      `SELECT BSEQ AS id FROM FBENC
       WHERE BTIPO = 0 AND BMOVS = 1 AND BMONEDA = 1
         AND BCIA IN (0,?) AND BMULTICIA IN (0,?) AND TRIM(BCOD) <> ''
       ORDER BY BCOD,BSEQ`,
      [companyId, companyId],
    );
    return rows.map(({ id }) => id);
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
    return { policyType, supplierAccount, supplierAccountName: liability?.name ?? supplierAccountName, bankAccounts };
  }
}
