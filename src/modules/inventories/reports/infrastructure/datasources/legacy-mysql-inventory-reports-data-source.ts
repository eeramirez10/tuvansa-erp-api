import type { Pool, RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { InventoryReportsDataSource } from '../../domain/datasources/inventory-reports-data-source.js';
import type { InventoryCriteria, InventoryOptions, InventoryProductBalance } from '../../domain/entities/inventory-by-family.js';

export class LegacyMysqlInventoryReportsDataSource implements InventoryReportsDataSource {
  constructor(private readonly db: Pick<Pool, 'execute'> = legacyMysqlPool) {}
  async options(): Promise<InventoryOptions> {
    // DERIVADAS: IFAMB references FFAM.FAMTNUM, not FAMSEQ. Group catalog keys to prevent multiplication.
    const [warehouses] = await this.db.execute<RowDataPacket[]>(
      "SELECT CATALM AS code,MAX(TRIM(CATDESCR)) AS name FROM falmcat WHERE CATALM<>'' AND CATKEY=? GROUP BY CATALM ORDER BY CATALM", ['']);
    const [families] = await this.db.execute<RowDataPacket[]>(
      "SELECT TRIM(i.IFAMB) AS code,COALESCE(MAX(NULLIF(TRIM(f.FAMDESCR),'')),'Sin familia') AS name FROM finv i LEFT JOIN ffam f ON f.FAMTNUM=i.IFAMB AND f.FAMT=? GROUP BY TRIM(i.IFAMB) ORDER BY code", ['B']);
    const [company] = await this.db.execute<RowDataPacket[]>('SELECT CIANAME AS name FROM fcia WHERE CIAKEY=? ORDER BY CIASEQ LIMIT 1', [0]);
    return { company: String(company[0]?.name ?? 'TUVANSA').trim(), defaultDate: '',
      defaultWarehouse: warehouses.some(w => w.code === '01') ? '01' : 'all',
      warehouses: warehouses.map(w => ({ code: String(w.code).trim(), name: String(w.name).trim() })),
      families: families.map(f => ({ code: String(f.code).trim(), name: String(f.name).trim() })) };
  }
  async balances(criteria: InventoryCriteria): Promise<InventoryProductBalance[]> {
    const next = new Date(criteria.asOf + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
    const until = next.toISOString().slice(0, 10);
    const conditions = ['a.AIMES=1', 'a.AICANT<>0', '(d.DEST=0 OR d.DSEQ IS NULL)', '(d.DFECHA<? OR d.DFECHA IS NULL)'];
    const parameters: Array<string> = [until];
    if (criteria.warehouse !== 'all') { conditions.push('a.AIALMACEN=?'); parameters.push(criteria.warehouse); }
    if (criteria.family !== 'all') { conditions.push('TRIM(i.IFAMB)=?'); parameters.push(criteria.family); }
    // DERIVADA: reconstruct all dated movements in one aggregation, not one query per product.
    // Missing documents/sentinel dates cannot be placed on the timeline. Keep their quantities separately.
    const dated = "d.DFECHA>'1900-12-31'";
    const [rows] = await this.db.execute<RowDataPacket[]>(`SELECT /*+ MAX_EXECUTION_TIME(30000) */
      i.ISEQ AS productId,i.ICOD AS code,i.IDESCR AS description,TRIM(i.IFAMB) AS family,
      COALESCE(NULLIF(f.name,''),'Sin familia') AS familyName,
      a.AIALMACEN AS warehouse,i.USEQ AS unitId,COALESCE(NULLIF(TRIM(u.UCOD),''),'Sin UM') AS unit,
      SUM(CASE WHEN ${dated} AND a.AICANT>0 THEN a.AICANT ELSE 0 END) AS incoming,
      SUM(CASE WHEN ${dated} AND a.AICANT<0 THEN -a.AICANT ELSE 0 END) AS outgoing,
      SUM(CASE WHEN ${dated} THEN a.AICANT ELSE 0 END) AS quantity,
      MIN(CASE WHEN ${dated} THEN d.DFECHA END) AS firstDate,
      MAX(CASE WHEN ${dated} THEN d.DFECHA END) AS lastDate,
      SUM(CASE WHEN ${dated} THEN 1 ELSE 0 END) AS movements,
      SUM(CASE WHEN d.DFECHA IS NULL OR d.DFECHA<='1900-12-31' THEN 1 ELSE 0 END) AS undatedMovements,
      SUM(CASE WHEN d.DFECHA IS NULL OR d.DFECHA<='1900-12-31' THEN a.AICANT ELSE 0 END) AS undatedQuantity
      FROM faxinv a JOIN finv i ON i.ISEQ=a.ISEQ LEFT JOIN fdoc d ON d.DSEQ=a.DSEQ
      LEFT JOIN funidad u ON u.USEQ=i.USEQ
      LEFT JOIN (SELECT FAMTNUM,MAX(TRIM(FAMDESCR)) AS name FROM ffam WHERE FAMT='B' GROUP BY FAMTNUM) f ON f.FAMTNUM=i.IFAMB
      WHERE ${conditions.join(' AND ')}
      GROUP BY i.ISEQ,i.ICOD,i.IDESCR,i.IFAMB,f.name,a.AIALMACEN,i.USEQ,u.UCOD
      ORDER BY family,code,warehouse,productId`, parameters);
    return rows.map(row => ({ productId: Number(row.productId), code: String(row.code).trim(), description: String(row.description).trim(),
      family: String(row.family).trim(), familyName: String(row.familyName).trim(), warehouse: String(row.warehouse).trim(),
      unitId: Number(row.unitId), unit: String(row.unit).trim(), incoming: Number(row.incoming), outgoing: Number(row.outgoing), quantity: Number(row.quantity),
      firstDate: row.firstDate === null ? null : String(row.firstDate).slice(0, 10), lastDate: row.lastDate === null ? null : String(row.lastDate).slice(0, 10),
      movements: Number(row.movements), undatedMovements: Number(row.undatedMovements), undatedQuantity: Number(row.undatedQuantity) }));
  }
}
