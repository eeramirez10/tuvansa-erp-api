import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';

export async function mexicoInvoiceTransferConfiguration() {
  const [[settings], [warehouses]] = await Promise.all([
    legacyMysqlPool.execute<Array<RowDataPacket & { enabled: number }>>(
      `SELECT (SUBSTRING(CIACOMPORTA,37,1)='1' AND SUBSTRING(CIACOMPORTA,96,1)='0'
         AND EXISTS(SELECT 1 FROM FTIPMV WHERE TICLA='FA' AND TIMULTICIA=1 AND TIMODULO=4 AND TITRASPASOS<>0)
         AND EXISTS(SELECT 1 FROM FTIPMV WHERE TICLA='TA' AND TIMULTICIA=1 AND TIMODULO=2
           AND TIAFINV=1 AND TIAFCXC=-1 AND TIAFVTS=0 AND TIAFBCS=0 AND TIFISCAL=0)) AS enabled
       FROM FCIA WHERE CIASEQ=1 AND CIAALIAS='TUVANSA'`,
    ),
    legacyMysqlPool.execute<Array<RowDataPacket & { code: string; name: string }>>(
      `SELECT CATALM AS code,MIN(CATDESCR) AS name FROM FALMCAT
       WHERE CATTIPO='' AND CATMULTICIA=1 AND CATALM<>'' GROUP BY CATALM ORDER BY CATALM`,
    ),
  ]);
  return { enabled: settings[0]?.enabled === 1, warehouses: warehouses.map(({ code, name }) => ({ code, name })) };
}
