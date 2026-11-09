import type { Pool, RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import type { CollectionCommissionsDataSource } from '../../domain/datasources/collection-commissions-data-source.js';
import type { CollectionCriteria, CollectionInputs, CollectionOptions } from '../../domain/entities/collection-commissions.js';

export class LegacyMysqlCollectionCommissionsDataSource implements CollectionCommissionsDataSource {
  constructor(private readonly db: Pick<Pool, 'execute' | 'getConnection'> = legacyMysqlPool) {}
  async options(): Promise<CollectionOptions> {
    const [warehouses] = await this.db.execute<RowDataPacket[]>(
      'SELECT CATALM code,MAX(TRIM(CATDESCR)) name,MAX(CATMULTICIA) companyId FROM falmcat WHERE CATKEY=? GROUP BY CATALM ORDER BY CATALM', ['']);
    const [agents] = await this.db.execute<RowDataPacket[]>(
      'SELECT TRIM(AGTNUM) code,MAX(TRIM(AGDESCR)) name FROM fag WHERE AGT=? GROUP BY TRIM(AGTNUM) ORDER BY code', ['1']);
    const [company] = await this.db.execute<RowDataPacket[]>('SELECT CIANAME name FROM fcia WHERE CIAKEY=? ORDER BY CIASEQ LIMIT 1', [0]);
    return { company: String(company[0]?.name ?? 'TUVANSA').trim(), defaultFrom: '', defaultTo: '',
      branches: warehouses.filter(w => /^0[1-7]$/.test(String(w.code))).map(w => ({ code: String(w.code), name: String(w.name),
        warehouses: String(w.code) === '01' ? ['01', '15'] : warehouses.filter(a => Number(a.companyId) === Number(w.companyId)).map(a => String(a.code)) })),
      agents: agents.map(a => ({ code: String(a.code), name: String(a.name) })) };
  }

  async read(criteria: CollectionCriteria, warehouses?: string[]): Promise<CollectionInputs> {
    const next = new Date(criteria.to + 'T00:00:00Z'); next.setUTCDate(next.getUTCDate() + 1);
    const params: Array<string | number> = [criteria.from, next.toISOString().slice(0, 10), 4];
    let filter = '';
    if (warehouses) { filter += ` AND d.DALMACEN IN (${warehouses.map(() => '?').join(',')})`; params.push(...warehouses); }
    if (criteria.agent !== 'all') { filter += ' AND TRIM(d.DPAR1)=?'; params.push(criteria.agent); }
    // DERIVADA from supplied methods 211/213. PA qualifies the invoice; D movements
    // only contribute returns within the same payment-date interval. NOT EXISTS
    // excludes entire service/mixed invoices without multiplying collection rows.
    const sql = `WITH period AS (
      SELECT a.DSEQ,a.AFECHA,a.ATIPMV,a.ACANT,d.DPORCIVA
      FROM fax a JOIN fdoc d ON d.DSEQ=a.DSEQ
      WHERE a.AFECHA>=? AND a.AFECHA<? AND (a.ATIPMV='PA' OR LEFT(a.ATIPMV,1)='D')
        AND d.DCANCELADA=0 AND LEFT(d.DNUM,2)<>'AF' AND LEFT(d.DNUM,1)='F' AND d.DESFACT=1
        AND NOT EXISTS (SELECT 1 FROM faxinv serviceLine JOIN finv serviceProduct ON serviceProduct.ISEQ=serviceLine.ISEQ
          WHERE serviceLine.DSEQ=d.DSEQ AND serviceProduct.ITIPO=?)${filter}
    ), collected AS (
      SELECT DSEQ,MIN(CASE WHEN ATIPMV='PA' THEN AFECHA END) firstPaymentDate,
        MAX(CASE WHEN ATIPMV='PA' THEN AFECHA END) lastPaymentDate,SUM(ATIPMV='PA') paymentCount,
        CAST(CAST(SUM(CASE WHEN ATIPMV='PA' THEN ACANT/NULLIF(1+DPORCIVA/100,0) ELSE 0 END) AS DECIMAL(38,8)) AS CHAR) payments,
        CAST(CAST(SUM(CASE WHEN LEFT(ATIPMV,1)='D' THEN ACANT/NULLIF(1+DPORCIVA/100,0) ELSE 0 END) AS DECIMAL(38,8)) AS CHAR) returns,
        SUM(DPORCIVA IS NULL OR DPORCIVA=-100) invalidVatCount
      FROM period GROUP BY DSEQ HAVING SUM(ATIPMV='PA')>0
    )
    SELECT /*+ MAX_EXECUTION_TIME(30000) */ d.DSEQ id,d.DNUM number,d.DFECHA date,c.firstPaymentDate,c.lastPaymentDate,
      COALESCE(f.CLICOD,'') customerCode,COALESCE(f.CLINOM,d.DCLINOM) customerName,
      TRIM(d.DPAR1) agentCode,COALESCE(NULLIF(g.name,''),'Sin agente identificado') agentName,d.DALMACEN warehouse,d.DMONEDA currency,d.DMULTICIA companyId,
      CAST(d.DBRUTO AS CHAR) subtotal,c.payments,c.returns,CAST(d.DCOSTOFLETE AS CHAR) freight,
      IF(f.CLITARJETA='Nuevo','Nuevo','') newCustomer,COALESCE(f.CLITARJETA,'') customerStatusRaw,c.paymentCount,c.invalidVatCount
    FROM collected c JOIN fdoc d ON d.DSEQ=c.DSEQ LEFT JOIN fcli f ON f.CLISEQ=d.CLISEQ
    LEFT JOIN (SELECT TRIM(AGTNUM) code,MAX(TRIM(AGDESCR)) name FROM fag WHERE AGT='1' GROUP BY TRIM(AGTNUM)) g ON g.code=TRIM(d.DPAR1)
    ORDER BY agentCode,d.DNUM,d.DSEQ LIMIT 10001`;
    const connection = await this.db.getConnection();
    try {
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const [rows] = await connection.execute<RowDataPacket[]>(sql, params);
      if (rows.length > 10000) throw new ApplicationError('El reporte excede 10,000 facturas. Reduce el periodo o selecciona sucursal/agente.', 'COLLECTION_COMMISSIONS_TOO_LARGE', 413);
      const invoices: CollectionInputs['invoices'] = rows.map(r => ({ id: Number(r.id), number: String(r.number).trim(), date: String(r.date),
        firstPaymentDate: String(r.firstPaymentDate), lastPaymentDate: String(r.lastPaymentDate), customerCode: String(r.customerCode).trim(),
        customerName: String(r.customerName).trim(), agentCode: String(r.agentCode).trim(), agentName: String(r.agentName).trim(), warehouse: String(r.warehouse).trim(),
        currency: Number(r.currency), companyId: Number(r.companyId), subtotal: String(r.subtotal), payments: Number(r.invalidVatCount) ? null : r.payments === null ? null : String(r.payments),
        returns: Number(r.invalidVatCount) ? null : r.returns === null ? null : String(r.returns), freight: String(r.freight), newCustomer: String(r.newCustomer), customerStatusRaw: String(r.customerStatusRaw ?? ''),
        paymentCount: Number(r.paymentCount), invalidVatCount: Number(r.invalidVatCount) }));
      let movements: CollectionInputs['movements'] = [], products: CollectionInputs['products'] = [];
      if (invoices.length) {
        const ids = invoices.map(r => r.id), placeholders = ids.map(() => '?').join(',');
        const [movementsRows] = await connection.execute<RowDataPacket[]>(`SELECT /*+ MAX_EXECUTION_TIME(30000) */ a.ASEQ id,a.DSEQ invoiceId,
          a.AFECHA date,a.ATIPMV type,CAST(a.ACANT AS CHAR) amount,CAST(d.DPORCIVA AS CHAR) vatRate,
          CAST(CAST(a.ACANT/NULLIF(1+d.DPORCIVA/100,0) AS DECIMAL(38,8)) AS CHAR) withoutVat,a.AREFPAG reference
          FROM fax a JOIN fdoc d ON d.DSEQ=a.DSEQ WHERE a.DSEQ IN (${placeholders}) AND a.AFECHA>=? AND a.AFECHA<?
            AND (a.ATIPMV='PA' OR LEFT(a.ATIPMV,1)='D') ORDER BY a.AFECHA,a.ASEQ LIMIT 100001`, [...ids, criteria.from, next.toISOString().slice(0, 10)]);
        const [productRows] = await connection.execute<RowDataPacket[]>(`SELECT /*+ MAX_EXECUTION_TIME(30000) */ a.AISEQ id,a.DSEQ invoiceId,a.ISEQ productId,
          COALESCE(i.ICOD,'') code,COALESCE(i.IDESCR,'Producto no disponible') description,COALESCE(i.IFAMB,'') family,
          CAST(a.AICANT AS CHAR) quantity,CAST(a.AICANTF AS CHAR) billedQuantity,CAST(a.AIPRECIO AS CHAR) price,
          CAST(a.AICOSTO AS CHAR) unitCost,a.AIMES applied,a.AITIPMV movementType,COALESCE(i.ILUGAR,'') location,i.ITIPO typeId FROM faxinv a LEFT JOIN finv i ON i.ISEQ=a.ISEQ
          WHERE a.DSEQ IN (${placeholders}) ORDER BY a.DSEQ,a.AISEQ LIMIT 100001`, ids);
        if (movementsRows.length > 100000 || productRows.length > 100000) throw new ApplicationError('El detalle excede 100,000 filas. Reduce los filtros.', 'COLLECTION_COMMISSIONS_TOO_LARGE', 413);
        movements = movementsRows.map(r => ({ id: Number(r.id), invoiceId: Number(r.invoiceId), date: String(r.date), type: String(r.type), amount: String(r.amount),
          vatRate: String(r.vatRate), withoutVat: r.withoutVat === null ? null : String(r.withoutVat), reference: String(r.reference).trim() }));
        products = productRows.map(r => ({ id: Number(r.id), invoiceId: Number(r.invoiceId), productId: Number(r.productId), code: String(r.code).trim(),
          description: String(r.description).trim(), family: String(r.family).trim(), quantity: String(r.quantity), billedQuantity: String(r.billedQuantity),
          price: String(r.price), unitCost: String(r.unitCost), applied: Number(r.applied), movementType: String(r.movementType).trim(), location: String(r.location).trim(),
          typeId: r.typeId === null ? null : Number(r.typeId) }));
      }
      await connection.commit();
      return { invoices, movements, products };
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
}
