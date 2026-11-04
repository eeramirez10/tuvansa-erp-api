import type { Pool, RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { SalesReportsDataSource } from '../../domain/datasources/sales-reports-data-source.js';
import type { SalesBalance, SalesCriteria, SalesOptions } from '../../domain/entities/sales-by-family.js';
export class LegacyMysqlSalesReportsDataSource implements SalesReportsDataSource {
  constructor(private readonly db: Pick<Pool, 'execute'> = legacyMysqlPool) {}
  async options(): Promise<SalesOptions> {
    // DERIVADAS: report catalogs, product type fixed by the requested report.
    const [branches] = await this.db.execute<RowDataPacket[]>("SELECT CATALM code,MAX(TRIM(CATDESCR)) name,MAX(CATMULTICIA) companyId FROM falmcat WHERE CATKEY=? AND CATALM IN ('01','02','03','04','05','06','07') AND CATMULTICIA>0 GROUP BY CATALM ORDER BY CATALM", ['']);
    const [families] = await this.db.execute<RowDataPacket[]>("SELECT TRIM(i.IFAMB) code,COALESCE(MAX(NULLIF(TRIM(f.FAMDESCR),'')),'Sin familia') name FROM finv i LEFT JOIN ffam f ON f.FAMTNUM=i.IFAMB AND f.FAMT='B' WHERE i.ITIPO=? GROUP BY TRIM(i.IFAMB) ORDER BY code", [1]);
    const [company] = await this.db.execute<RowDataPacket[]>('SELECT CIANAME name FROM fcia WHERE CIAKEY=? ORDER BY CIASEQ LIMIT 1', [0]);
    return { company: String(company[0]?.name ?? 'TUVANSA').trim(), defaultFrom: '', defaultTo: '', defaultBranch: branches.some(b => b.code === '01') ? '01' : 'all',
      branches: branches.map(b => ({ code: String(b.code).trim(), name: String(b.name).trim(), companyId: Number(b.companyId) })),
      families: families.map(f => ({ code: String(f.code).trim(), name: String(f.name).trim() })) };
  }
  async balances(criteria: SalesCriteria, companyId?: number): Promise<SalesBalance[]> {
    const next = new Date(criteria.to + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
    const parameters: Array<string | number> = [1, criteria.from, next.toISOString().slice(0, 10)];
    let filter = '';
    if (companyId !== undefined) { filter += ' AND d.DMULTICIA=?'; parameters.push(companyId); }
    if (criteria.family !== 'all') { filter += ' AND TRIM(i.IFAMB)=?'; parameters.push(criteria.family); }
    // DERIVADA: invoice-only sales at the recorded AIPRECIO requested by the user.
    // DITIPMV can retain FA after invoicing; classify the actual DNUM folio.
    const amount = 'a.AICANTF*a.AIPRECIO';
    const [rows] = await this.db.execute<RowDataPacket[]>(`SELECT /*+ MAX_EXECUTION_TIME(30000) */ i.ISEQ productId,i.ICOD code,i.IDESCR description,
      TRIM(i.IFAMB) family,COALESCE(NULLIF(f.name,''),'Sin familia') familyName,d.DMULTICIA companyId,
      COALESCE(NULLIF(TRIM(u.UCOD),''),'Sin UM') unit,CAST(SUM(a.AICANTF) AS CHAR) quantity,
      CAST(SUM(COALESCE(${amount},0)) AS CHAR) gross,COUNT(*) movements,MIN(d.DFECHA) firstDate,MAX(d.DFECHA) lastDate,
      GROUP_CONCAT(DISTINCT a.AITIPMV ORDER BY a.AITIPMV SEPARATOR ',') movementTypes,
      SUM(a.AIPRECIO IS NULL) missingPrices
      FROM faxinv a JOIN fdoc d ON d.DSEQ=a.DSEQ JOIN finv i ON i.ISEQ=a.ISEQ JOIN fcli c ON c.CLISEQ=a.CLISEQ AND c.CLISEQ<>0
      LEFT JOIN funidad u ON u.USEQ=i.USEQ
      LEFT JOIN (SELECT FAMTNUM,MAX(TRIM(FAMDESCR)) name FROM ffam WHERE FAMT='B' GROUP BY FAMTNUM) f ON f.FAMTNUM=i.IFAMB
      WHERE i.ITIPO=? AND d.DFECHA>=? AND d.DFECHA<? AND a.AIMES=1 AND d.DEST=0 AND d.DESFACT=1
      AND d.DOTROSTXT<>'POS' AND d.DCONTROLPOS=0 AND a.AICANTF>0${filter}
      AND EXISTS (SELECT 1 FROM ftipmv t WHERE t.TICLA=LEFT(d.DNUM,2)
        AND t.TIFISCAL=1 AND t.TIAFVTS=1 AND t.TIMODULO=4)
      GROUP BY i.ISEQ,i.ICOD,i.IDESCR,i.IFAMB,f.name,d.DMULTICIA,u.UCOD ORDER BY family,code,companyId,productId`, parameters);
    return rows.map(r => ({ productId: Number(r.productId), code: String(r.code).trim(), description: String(r.description).trim(), family: String(r.family).trim(),
      familyName: String(r.familyName).trim(), companyId: Number(r.companyId), unit: String(r.unit).trim(), quantity: String(r.quantity), gross: String(r.gross),
      movements: Number(r.movements), firstDate: String(r.firstDate).slice(0, 10), lastDate: String(r.lastDate).slice(0, 10), movementTypes: String(r.movementTypes), missingPrices: Number(r.missingPrices) }));
  }
}
