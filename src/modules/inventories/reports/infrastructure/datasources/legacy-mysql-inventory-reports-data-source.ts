import type { Pool, RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import type { InventoryReportsDataSource } from '../../domain/datasources/inventory-reports-data-source.js';
import type { InventoryCriteria, InventoryOptions, InventoryProductBalance } from '../../domain/entities/inventory-by-family.js';

export class LegacyMysqlInventoryReportsDataSource implements InventoryReportsDataSource {
  private cachedOptions?: { expires: number; value: InventoryOptions };
  constructor(private readonly db: Pick<Pool, 'execute'> = legacyMysqlPool) {}
  async options(): Promise<InventoryOptions> {
    if (this.cachedOptions && this.cachedOptions.expires > Date.now()) return this.cachedOptions.value;
    // DERIVADAS: IFAMB references FFAM.FAMTNUM, not FAMSEQ. Group catalog keys to prevent multiplication.
    const [warehouses] = await this.db.execute<RowDataPacket[]>(
      "SELECT CATALM AS code,MAX(TRIM(CATDESCR)) AS name,MAX(CATMULTICIA) AS companyId FROM falmcat WHERE CATALM<>'' AND CATKEY=? GROUP BY CATALM ORDER BY CATALM", ['']);
    const [families] = await this.db.execute<RowDataPacket[]>(
      "SELECT TRIM(i.IFAMB) AS code,COALESCE(MAX(NULLIF(TRIM(f.FAMDESCR),'')),'Sin familia') AS name FROM finv i LEFT JOIN ffam f ON f.FAMTNUM=i.IFAMB AND f.FAMT=? GROUP BY TRIM(i.IFAMB) ORDER BY code", ['B']);
    const [company] = await this.db.execute<RowDataPacket[]>('SELECT CIANAME AS name FROM fcia WHERE CIAKEY=? ORDER BY CIASEQ LIMIT 1', [0]);
    const primary = warehouses.filter(w => /^0[1-7]$/.test(String(w.code).trim()) && Number(w.companyId) > 0);
    const result: InventoryOptions = { company: String(company[0]?.name ?? 'TUVANSA').trim(), defaultDate: '',
      defaultWarehouse: warehouses.some(w => w.code === '01') ? '01' : 'all',
      warehouses: warehouses.map(w => {
        const owners = primary.filter(branch => Number(branch.companyId) === Number(w.companyId));
        return { code: String(w.code).trim(), name: String(w.name).trim(), branchCode: owners.length === 1 ? String(owners[0]!.code).trim() : null };
      }),
      families: families.map(f => ({ code: String(f.code).trim(), name: String(f.name).trim() })) };
    this.cachedOptions = { expires: Date.now() + 60_000, value: result };
    return result;
  }
  async balances(criteria: InventoryCriteria): Promise<InventoryProductBalance[]> {
    const next = new Date(criteria.asOf + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
    const until = next.toISOString().slice(0, 10);
    const conditions = ['a.AIMES=1', '(a.AICANT<>0 OR a.AIREVAL<>0)', '(d.DEST=0 OR d.DSEQ IS NULL)', '(d.DFECHA<? OR d.DFECHA IS NULL)'];
    const parameters: Array<string> = [until];
    if (criteria.warehouse !== 'all') {
      if ((criteria.scope ?? 'branch') === 'branch') {
        const codes = (await this.options()).warehouses.filter(w => w.branchCode === criteria.warehouse).map(w => w.code);
        if (!codes.length) throw new ApplicationError('Sucursal sin almacenes configurados.', 'INVENTORY_REPORT_INVALID', 400);
        conditions.push(`a.AIALMACEN IN (${codes.map(() => '?').join(',')})`); parameters.push(...codes);
      } else { conditions.push('a.AIALMACEN=?'); parameters.push(criteria.warehouse); }
    }
    if (criteria.family !== 'all') { conditions.push('TRIM(i.IFAMB)=?'); parameters.push(criteria.family); }
    // DERIVADA: reconstruct all dated movements in one aggregation, not one query per product.
    // Missing documents/sentinel dates cannot be placed on the timeline. Keep their quantities separately.
    const dated = "d.DFECHA>'1900-12-31'";
    const undated = "(d.DFECHA IS NULL OR d.DFECHA<='1900-12-31')";
    const historicalAmount = 'a.AICANT*COALESCE(a.AICOSTO,0)';
    const [rows] = await this.db.execute<RowDataPacket[]>(`SELECT /*+ MAX_EXECUTION_TIME(30000) */
      i.ISEQ AS productId,i.ICOD AS code,i.IDESCR AS description,TRIM(i.IFAMB) AS family,
      COALESCE(NULLIF(f.name,''),'Sin familia') AS familyName,
      a.AIALMACEN AS warehouse,i.USEQ AS unitId,COALESCE(NULLIF(TRIM(u.UCOD),''),'Sin UM') AS unit,i.ILISTA4 AS averageCost,
      SUM(CASE WHEN ${dated} AND a.AICANT>0 THEN a.AICANT ELSE 0 END) AS incoming,
      SUM(CASE WHEN ${dated} AND a.AICANT<0 THEN -a.AICANT ELSE 0 END) AS outgoing,
      SUM(CASE WHEN ${dated} THEN a.AICANT ELSE 0 END) AS quantity,
      MIN(CASE WHEN ${dated} THEN d.DFECHA END) AS firstDate,
      MAX(CASE WHEN ${dated} THEN d.DFECHA END) AS lastDate,
      SUM(CASE WHEN ${dated} THEN 1 ELSE 0 END) AS movements,
      SUM(CASE WHEN d.DFECHA IS NULL OR d.DFECHA<='1900-12-31' THEN 1 ELSE 0 END) AS undatedMovements,
      SUM(CASE WHEN d.DFECHA IS NULL OR d.DFECHA<='1900-12-31' THEN a.AICANT ELSE 0 END) AS undatedQuantity,
      SUM(CASE WHEN (d.DFECHA IS NULL OR d.DFECHA<='1900-12-31') AND a.AICANT>0 THEN a.AICANT ELSE 0 END) AS undatedIncoming,
      SUM(CASE WHEN (d.DFECHA IS NULL OR d.DFECHA<='1900-12-31') AND a.AICANT<0 THEN -a.AICANT ELSE 0 END) AS undatedOutgoing,
      CAST(SUM(CASE WHEN ${dated} AND a.AICANT>0 THEN ${historicalAmount} ELSE 0 END) AS CHAR) AS historicalIncoming,
      CAST(SUM(CASE WHEN ${dated} AND a.AICANT<0 THEN -(${historicalAmount}) ELSE 0 END) AS CHAR) AS historicalOutgoing,
      CAST(SUM(CASE WHEN ${dated} THEN ${historicalAmount} ELSE 0 END) AS CHAR) AS historicalDated,
      CAST(SUM(CASE WHEN ${undated} THEN ${historicalAmount} ELSE 0 END) AS CHAR) AS historicalUnlinked,
      CAST(SUM(CASE WHEN ${dated} THEN COALESCE(a.AIREVAL,0) ELSE 0 END) AS CHAR) AS historicalRevaluation,
      CAST(SUM(CASE WHEN ${undated} THEN COALESCE(a.AIREVAL,0) ELSE 0 END) AS CHAR) AS historicalUndatedRevaluation,
      SUM(CASE WHEN ${dated} AND a.AICANT<>0 AND (a.AICOSTO IS NULL OR a.AICOSTO=0) THEN 1 ELSE 0 END) AS zeroCostMovements,
      SUM(CASE WHEN ${undated} AND a.AICANT<>0 AND (a.AICOSTO IS NULL OR a.AICOSTO=0) THEN 1 ELSE 0 END) AS undatedZeroCostMovements
      FROM faxinv a JOIN finv i ON i.ISEQ=a.ISEQ LEFT JOIN fdoc d ON d.DSEQ=a.DSEQ
      LEFT JOIN funidad u ON u.USEQ=i.USEQ
      LEFT JOIN (SELECT FAMTNUM,MAX(TRIM(FAMDESCR)) AS name FROM ffam WHERE FAMT='B' GROUP BY FAMTNUM) f ON f.FAMTNUM=i.IFAMB
      WHERE ${conditions.join(' AND ')}
      GROUP BY i.ISEQ,i.ICOD,i.IDESCR,i.IFAMB,f.name,a.AIALMACEN,i.USEQ,u.UCOD,i.ILISTA4
      ORDER BY family,code,warehouse,productId`, parameters);
    return rows.map(row => ({ productId: Number(row.productId), code: String(row.code).trim(), description: String(row.description).trim(),
      family: String(row.family).trim(), familyName: String(row.familyName).trim(), warehouse: String(row.warehouse).trim(),
      unitId: Number(row.unitId), unit: String(row.unit).trim(), incoming: Number(row.incoming), outgoing: Number(row.outgoing), quantity: Number(row.quantity),
      firstDate: row.firstDate === null ? null : String(row.firstDate).slice(0, 10), lastDate: row.lastDate === null ? null : String(row.lastDate).slice(0, 10),
      movements: Number(row.movements), undatedMovements: Number(row.undatedMovements), undatedQuantity: Number(row.undatedQuantity),
      undatedIncoming: Number(row.undatedIncoming ?? 0), undatedOutgoing: Number(row.undatedOutgoing ?? 0), averageCost: Number(row.averageCost ?? 0),
      historicalCosts: { incoming: String(row.historicalIncoming ?? '0'), outgoing: String(row.historicalOutgoing ?? '0'),
        dated: String(row.historicalDated ?? '0'), unlinked: String(row.historicalUnlinked ?? '0'),
        revaluation: String(row.historicalRevaluation ?? '0'), undatedRevaluation: String(row.historicalUndatedRevaluation ?? '0'),
        zeroCostMovements: Number(row.zeroCostMovements ?? 0), undatedZeroCostMovements: Number(row.undatedZeroCostMovements ?? 0) } }));
  }
}
