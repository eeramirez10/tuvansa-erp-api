import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { BankAccountLookup } from '../../../../treasury/banking/domain/entities/bank-account.js';
import { BankAccountsWithCatalogDataSource } from '../../../../treasury/banking/infrastructure/datasources/bank-accounts-with-catalog-data-source.js';
import { clientCatalogRecord } from './postgres-client-catalog.js';
import type { ClientCatalogRecord } from '../../domain/entities/client-catalog.js';
import type {
  CustomerCollectionReferences, CustomerCollectionSettings,
} from '../../domain/datasources/customer-collection-data-source.js';

interface SettingRow extends RowDataPacket, Omit<CustomerCollectionSettings, 'bankAccounts'> {}

export class MysqlCustomerCollectionReferences implements CustomerCollectionReferences {
  constructor(private readonly accounts: Pick<BankAccountsWithCatalogDataSource, 'postingAccounts'> = new BankAccountsWithCatalogDataSource()) {}

  async settings(companyId: number, clientId: number, bankAccountId?: number, lookup?: BankAccountLookup,
    catalog?: ClientCatalogRecord | null): Promise<CustomerCollectionSettings | null> {
    // Derivada del PA, la póliza aplicada y las cuentas efectivas del catálogo Omnis.
    const client = catalog === undefined ? await clientCatalogRecord(clientId) : catalog;
    if (client?.deleted) return null;
    const [[settings], banks] = await Promise.all([
      legacyMysqlPool.execute<SettingRow[]>(
        `SELECT TRIM(c.CIAPOLIZAING) AS policyType, c.CIAFI AS fiscalStart, c.CIAFF AS fiscalEnd,
                TRIM(a.BCOD) AS clientAccount, TRIM(a.BNOMBRE) AS clientAccountName
         FROM FCIA c
         LEFT JOIN FCLI cl ON cl.CLISEQ = ?
         JOIN FBENC a ON a.BCOD = COALESCE(NULLIF(TRIM(COALESCE(?,cl.CLICTA)),''), TRIM(c.CIACTACXC))
           AND a.BMOVS = 1 AND a.BSUBCTAS = 0 AND a.BCIA IN (0,c.CIASEQ) AND a.BMULTICIA IN (0,c.CIASEQ)
         WHERE c.CIASEQ = ? AND c.CIAALIAS = 'TUVANSA' AND TRIM(c.CIAPOLIZAING) = '1'
           AND TRIM(c.CIACTAIVACOBRODE) = '' AND TRIM(c.CIACTAIVACOBROA) = ''
           AND (cl.CLISEQ IS NOT NULL OR ?=1)
           AND COALESCE(cl.CLIINTERCIA,0)=0 AND COALESCE(cl.CLIMONEDA,1) IN (0,1)
           AND TRIM(COALESCE(?,cl.CLIAPLICAR,'')) IN ('',TRIM(COALESCE(?,cl.CLICOD,'')))
           AND EXISTS (
             SELECT 1 FROM FTIPMV t WHERE t.TICLA = 'PA' AND t.TIMODULO = 9 AND t.TIMULTICIA IN (0,c.CIASEQ)
               AND t.TIAFCXC = -1 AND t.TIAFBCS = 1 AND t.TIAFINV = 0
           )
         ORDER BY a.BSEQ LIMIT 2`, [clientId, client?.changes.accountingAccount ?? null, companyId,
          client && !client.legacy ? 1 : 0, client?.changes.applyToClientCode ?? null, client?.document.code ?? null],
      ),
      this.accounts.postingAccounts(companyId, 'deposits', bankAccountId, lookup),
    ]);
    const [configuration] = settings;
    if (settings.length !== 1 || !configuration?.clientAccount || !configuration.fiscalStart || !configuration.fiscalEnd) return null;
    const { policyType, fiscalStart, fiscalEnd, clientAccount, clientAccountName } = configuration;
    return {
      policyType, fiscalStart, fiscalEnd, clientAccount, clientAccountName,
      bankAccounts: banks.map(({ id, code, name }) => ({ id, code: code.trim(), name: name.trim() })),
    };
  }
}
