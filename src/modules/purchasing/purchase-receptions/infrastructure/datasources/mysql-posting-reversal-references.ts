import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { PostingReversalFiscalWindow, PostingReversalReferences } from '../../domain/datasources/purchase-posting-reversal-data-source.js';

interface PeriodRow extends RowDataPacket, PostingReversalFiscalWindow {}

export class MysqlPostingReversalReferences implements PostingReversalReferences {
  async fiscalWindow(companyId: number) {
    if (companyId !== 1) return null;
    const [rows] = await legacyMysqlPool.execute<PeriodRow[]>(
      `SELECT CIAFI AS fiscalStart,CIAFF AS fiscalEnd FROM FCIA
       WHERE CIASEQ=? AND CIAALIAS='TUVANSA' AND SUBSTRING(CIAPLUGS,4,1)='X' LIMIT 1`, [companyId],
    );
    const period = rows[0];
    return period?.fiscalStart && period.fiscalStart >= '1901-01-01' && period.fiscalEnd >= period.fiscalStart ? period : null;
  }
}
