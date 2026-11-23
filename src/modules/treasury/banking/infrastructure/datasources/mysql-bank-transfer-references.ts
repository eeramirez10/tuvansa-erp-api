import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { BankAccountsDataSource } from '../../domain/datasources/bank-accounts-data-source.js';
import type { BankTransferReferences, BankTransferSettings } from '../../domain/datasources/bank-transfer-data-source.js';
import type { BankAccountProps } from '../../domain/entities/bank-account.js';
import { canTransfer } from '../../domain/entities/bank-transfer.js';

interface SettingsRow extends RowDataPacket, BankTransferSettings {}

export class MysqlBankTransferReferences implements BankTransferReferences {
  constructor(private readonly accounts: BankAccountsDataSource) {}

  async settings(companyId: number): Promise<BankTransferSettings | null> {
    if (companyId !== 1) return null;
    const [rows] = await legacyMysqlPool.execute<SettingsRow[]>(
      `SELECT TRIM(CIAPOLIZACONT) AS policyType, CIAFI AS fiscalStart, CIAFF AS fiscalEnd
       FROM FCIA c
       WHERE c.CIASEQ=? AND c.CIAALIAS='TUVANSA'
         AND SUBSTRING(c.CIAPLUGS,4,1)='X' AND TRIM(c.CIAPOLIZACONT)='3'
         AND EXISTS (
           SELECT 1 FROM FTIPMV t WHERE t.TICLA='3' AND t.TIMODULO=9
             AND t.TIMULTICIA IN (0,c.CIASEQ) AND t.TIAFBCS=1 AND t.TIFISCAL=0
         ) LIMIT 1`,
      [companyId],
    );
    const row = rows[0];
    return row?.fiscalStart && row.fiscalEnd ? row : null;
  }

  async account(id: number) {
    return (await this.accounts.findById(id))?.toPrimitives() ?? null;
  }

  async sources(companyId: number) {
    const limit = 250;
    const applicable: BankAccountProps[] = [];
    let offset = 0;
    for (;;) {
      const { items, total } = await this.accounts.search({ offset, limit });
      const accounts = items.map((item) => item.toPrimitives());
      applicable.push(...accounts.filter((account) => canTransfer(account, companyId, 'source')));
      offset += items.length;
      if (!items.length || offset >= total) return applicable;
    }
  }
}
