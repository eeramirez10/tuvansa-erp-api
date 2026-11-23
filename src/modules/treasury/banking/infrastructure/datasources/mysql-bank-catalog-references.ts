import type { RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { BankCatalogReferences } from '../../domain/datasources/bank-catalog-data-source.js';
import { LegacyMysqlBankAccountsDataSource } from './legacy-mysql-bank-accounts-data-source.js';

interface RulesRow extends RowDataPacket {
  level1: number; level2: number; level3: number; level4: number; level5: number; level6: number; level7: number;
  accounting: string;
}

export class MysqlBankCatalogReferences implements BankCatalogReferences {
  constructor(private readonly accounts = new LegacyMysqlBankAccountsDataSource()) {}

  findById(id: number) { return this.accounts.findById(id); }

  async rules() {
    const [rows] = await legacyMysqlPool.execute<RulesRow[]>(
      `SELECT CIACONNIV1 AS level1,CIACONNIV2 AS level2,CIACONNIV3 AS level3,
              CIACONNIV4 AS level4,CIACONNIV5 AS level5,CIACONNIV6 AS level6,CIACONNIV7 AS level7,
              substring(CIAPLUGS,4,1) AS accounting FROM FCIA LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return { accounting: false, codeLengths: [] };
    const codeLengths = [row.level1, row.level2, row.level3, row.level4, row.level5, row.level6, row.level7]
      .filter((length) => length > 0 && length <= 16);
    return { codeLengths: [...new Set(codeLengths)], accounting: row.accounting === 'X' };
  }

  async codeExists(code: string): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>('SELECT 1 FROM FBENC WHERE BCOD = ? LIMIT 1', [code]);
    return rows.length > 0;
  }

  async hasMovements(id: number): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>('SELECT 1 FROM FBANMOV WHERE BSEQ = ? LIMIT 1', [id]);
    return rows.length > 0;
  }

  async hasBalances(id: number): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
      `SELECT 1 FROM FBENC WHERE BSEQ = ? AND (BS100<>0 OR BS200<>0
         OR BSALDOR1<>0 OR BSALDOR2<>0 OR BSALDOB1<>0 OR BSALDOB2<>0 OR BSALDOTR1<>0 OR BSALDOTR2<>0) LIMIT 1`, [id],
    );
    return rows.length > 0;
  }

  async hasChildren(code: string): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
      'SELECT 1 FROM FBENC WHERE BCOD > ? AND BCOD LIKE ? ORDER BY BCOD LIMIT 1', [code, `${code}%`],
    );
    return rows.length > 0;
  }

  async parent(code: string) {
    const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & { id: number; movements: number }>>(
      'SELECT BSEQ AS id, BMOVS AS movements FROM FBENC WHERE BCOD = ? ORDER BY BSEQ LIMIT 1', [code],
    );
    return rows[0] ? { id: Number(rows[0].id), movements: Number(rows[0].movements) > 0 } : null;
  }
}
