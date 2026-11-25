import type { RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';

export interface HistoricalSupplierBalance {
  id: number;
  company: number;
  document: string;
  date: string;
  originalAmount: number;
  amount: number;
  currency: number;
  exchangeRate: number;
  groupingStatus: string;
  activeSupplier: number;
}

// ADAPTADA: misma cuenta, compañía y estatus de EPRV#2/240.
export async function readHistoricalSupplierBalances(supplierId: number, ids?: number[]) {
  const [rows] = await legacyMysqlPool.execute<(RowDataPacket & HistoricalSupplierBalance)[]>(`
    SELECT FDOC.DSEQ AS id, DMULTICIA AS company, DNUM AS document,
           DATE(DFECHA) AS date, DATE(DVENCE) AS dueDate,
           DATEDIFF(CURRENT_DATE, DVENCE) AS days, DCANTF AS originalAmount,
           DCANT AS amount, DMONEDA AS currency, DREFER AS reference,
           DATE(DFECHAPROGR) AS scheduledAt, DPAR2 AS secondaryReference,
           DRUTA AS route, DTIPOC AS exchangeRate, DFOLIO AS folio,
           DSTATUS AS groupingStatus, (PRVBAJA = '1900-12-31') AS activeSupplier
    FROM FDOC JOIN FPRV ON FDOC.PRVSEQ = FPRV.PRVSEQ
    WHERE FPRV.PRVSEQ = ? AND DEST = 0 AND DMULTICIA = 1 AND DESCXC = 2
      ${ids ? `AND FDOC.DSEQ IN (${ids.map(() => '?').join(',')})` : ''}
    ORDER BY FDOC.DSEQ
  `, [supplierId, ...(ids ?? [])]);
  return rows;
}
