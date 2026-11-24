import type { RowDataPacket } from 'mysql2/promise';
import { env } from '../../../../../config/env.js';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { InventoryAdjustmentCapture } from '../../domain/repositories/inventory-adjustments-repository.js';

export interface AdjustmentProduct {
  id: number;
  code: string;
  description: string;
  unit: string;
  cost: number;
  transferCost: number;
  active: boolean;
  simple: boolean;
  incompatibility?: string;
  legacyOnHand: number;
  legacyAssigned: number;
}

type References = Omit<InventoryAdjustmentCapture, 'writable'>;

const company = 1;
const warehouseScope = env.PURCHASE_ORDER_WAREHOUSES ?? ['01', '11', '12', '13'];
const localDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });

export class MysqlInventoryAdjustmentReferences {
  async capture(): Promise<References> {
    // EI/SI de EINV#3 y TR de EINV#17/401–402. Se habilita el TR ordinario de un folio de TUVANSA.
    const [[settings], [types], [warehouses]] = await Promise.all([
      legacyMysqlPool.execute<(RowDataPacket & { warehouse: string; supportsTransfer: number })[]>(
        `SELECT CIAALM AS warehouse,(CIANOCOSTOS=0 AND SUBSTRING(CIACOMPORTA,42,1)='1'
           AND SUBSTRING(CIACOMPORTA,45,1)='1' AND SUBSTRING(CIACOMPORTA,75,1)='0'
           AND SUBSTRING(CIACOMPORTA,94,1)='0') AS supportsTransfer FROM FCIA
         WHERE CIASEQ=? AND CIAALIAS='TUVANSA' AND SUBSTRING(CIACOMPORTA,37,1)='1' LIMIT 1`, [company],
      ),
      legacyMysqlPool.execute<(RowDataPacket & References['types'][number])[]>(
        `SELECT TICLA AS code,TIDESCR AS name,IF(TICLA='TR',0,TIAFINV) AS sign FROM FTIPMV
         WHERE ((TICLA='EI' AND TIAFINV=1) OR (TICLA='SI' AND TIAFINV=-1) OR (TICLA='TR' AND TIAFINV=1 AND TIFISCAL=0))
           AND TIMODULO=2 AND TIMULTICIA IN (0,?) AND TIAFCXC=0 AND TIAFVTS=0 AND TIAFBCS=0 AND TITRASPASOS=0
         ORDER BY TICLA, TIMULTICIA DESC, TISEQ`, [company],
      ),
      legacyMysqlPool.execute<(RowDataPacket & References['warehouses'][number])[]>(
        `SELECT CATALM AS code, CATDESCR AS name FROM FALMCAT
         WHERE CATTIPO='' AND CATMULTICIA=? AND CATALM<>'' ORDER BY CATALM,CATSEQ`, [company],
      ),
    ]);
    const companySettings = settings[0];
    const validWarehouses = warehouses.filter((row, index) => warehouseScope.includes(row.code)
      && warehouses.findIndex(({ code }) => code === row.code) === index).map(({ code, name }) => ({ code, name }));
    const validTypes = types.filter((row, index) => types.findIndex(({ code }) => code === row.code) === index
      && (row.code !== 'TR' || (companySettings?.supportsTransfer && validWarehouses.length > 1)))
      .map(({ code, name, sign }) => ({ code, name, sign }));
    const reason = !companySettings || !validTypes.length
      ? 'La configuración de entradas y salidas de inventario de TUVANSA no está disponible.'
      : validWarehouses.length ? null : 'No hay un almacén disponible para la captura.';
    return {
      reason,
      defaultDate: localDate.format(),
      defaultWarehouse: validWarehouses.find(({ code }) => code === companySettings?.warehouse)?.code ?? validWarehouses[0]?.code ?? '',
      types: validTypes,
      warehouses: validWarehouses,
    };
  }

  async products(warehouse: string, ids: number[]): Promise<Map<number, AdjustmentProduct>> {
    const [rows] = await legacyMysqlPool.execute<(RowDataPacket & AdjustmentProduct)[]>(
      `SELECT I.ISEQ AS id, I.ICOD AS code, I.IDESCR AS description, I.IUM AS unit,
         I.ILISTA5+I.IADVALOREM AS cost,I.ILISTA4+I.IADVALOREM AS transferCost,
         (I.IBAJA IS NULL OR I.IBAJA<'1901-01-01') AND I.IINACTIVO=0 AS active,
         I.INOCAPAS=1 AND I.IPORCARANC=0 AND I.ICT=0 AND I.ICONTROLPZAS=0 AND I.ITIPO IN (0,1,3) AS simple,
         COALESCE(SUM(A.ALMCANT),0) AS legacyOnHand, COALESCE(SUM(A.ALMASIGNADO),0) AS legacyAssigned
       FROM FINV I LEFT JOIN FALM A ON A.ISEQ=I.ISEQ AND A.ALMNUM=?
       WHERE I.ISEQ IN (${ids.map(() => '?').join(',')})
       GROUP BY I.ISEQ,I.ICOD,I.IDESCR,I.IUM,I.ILISTA5,I.ILISTA4,I.IADVALOREM,I.IBAJA,I.IINACTIVO,
         I.INOCAPAS,I.IPORCARANC,I.ICT,I.ICONTROLPZAS,I.ITIPO`, [warehouse, ...ids],
    );
    return new Map(rows.map((row) => [Number(row.id), row]));
  }

  async documentExists(number: string): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>('SELECT DSEQ FROM FDOC WHERE DNUM=? LIMIT 1', [number]);
    return rows.length > 0;
  }
}
