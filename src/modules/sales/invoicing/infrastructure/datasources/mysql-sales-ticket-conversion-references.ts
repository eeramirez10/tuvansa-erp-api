import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { SalesTicketConversionSettings } from '../../domain/datasources/sales-ticket-conversion-data-source.js';

export async function mexicoSalesTicketConversionSettings(): Promise<SalesTicketConversionSettings | null> {
  // Derivada de MFACT/86 y /322. La remisión web estándar usa IVA de 16% y un cargo en pesos.
  const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & SalesTicketConversionSettings>>(
    `SELECT c.CIAFI AS fiscalStart,c.CIAFF AS fiscalEnd FROM FCIA c
       JOIN FTIPMV fa ON fa.TIMULTICIA=c.CIASEQ AND fa.TIMODULO=4 AND fa.TICLA='FA'
       JOIN FTIPMV fe ON fe.TIMULTICIA=c.CIASEQ AND fe.TIMODULO=4 AND fe.TICLA=fa.TICONVERTIR
     WHERE c.CIASEQ=1 AND c.CIAALIAS='TUVANSA' AND fa.TIFISCAL=0 AND fe.TICLA='FE' AND fe.TIFISCAL=1
       AND fa.TIAFINV=-1 AND fe.TIAFINV=fa.TIAFINV
       AND fa.TIAFCXC=1 AND fe.TIAFCXC=fa.TIAFCXC
       AND fa.TIAFVTS=1 AND fe.TIAFVTS=fa.TIAFVTS AND fa.TIIVA0=16 AND fe.TIIVA0=fa.TIIVA0
     LIMIT 2`,
  );
  return rows.length === 1 ? rows[0]! : null;
}
