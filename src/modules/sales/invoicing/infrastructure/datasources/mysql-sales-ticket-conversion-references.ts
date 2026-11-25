import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';

export async function mexicoSalesTicketConversionConfigured(): Promise<boolean> {
  // Derivada de MFACT/86 y /322. La remisión web estándar usa IVA de 16% y un cargo en pesos.
  const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
    `SELECT 1 FROM FCIA c
       JOIN FTIPMV fa ON fa.TIMULTICIA=c.CIASEQ AND fa.TIMODULO=4 AND fa.TICLA='FA'
       JOIN FTIPMV fe ON fe.TIMULTICIA=c.CIASEQ AND fe.TIMODULO=4 AND fe.TICLA=fa.TICONVERTIR
     WHERE c.CIASEQ=1 AND c.CIAALIAS='TUVANSA' AND fa.TIFISCAL=0 AND fe.TICLA='FE' AND fe.TIFISCAL=1
       AND fa.TIAFINV=-1 AND fe.TIAFINV=fa.TIAFINV
       AND fa.TIAFCXC=1 AND fe.TIAFCXC=fa.TIAFCXC
       AND fa.TIAFVTS=1 AND fe.TIAFVTS=fa.TIAFVTS AND fa.TIIVA0=16 AND fe.TIIVA0=fa.TIIVA0
     LIMIT 2`,
  );
  return rows.length === 1;
}
