import type { Pool, RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import type { CollectionCommissionsDataSource } from '../../domain/datasources/collection-commissions-data-source.js';
import type { CollectionAdjustment, CollectionCriteria, CollectionInputs, CollectionInvoiceInput, CollectionOptions } from '../../domain/entities/collection-commissions.js';

function invoiceRow(r: RowDataPacket): CollectionInvoiceInput {
  return { id: Number(r.id), number: String(r.number).trim(), canceled: Number(r.canceled) === 1, date: String(r.date),
    firstPaymentDate: String(r.firstPaymentDate), lastPaymentDate: String(r.lastPaymentDate), customerCode: String(r.customerCode).trim(),
    customerName: String(r.customerName).trim(), agentCode: String(r.agentCode).trim(), agentName: String(r.agentName).trim(), warehouse: String(r.warehouse).trim(),
    currency: Number(r.currency), companyId: Number(r.companyId), subtotal: String(r.subtotal), payments: Number(r.invalidVatCount) ? null : r.payments === null ? null : String(r.payments),
    returns: Number(r.invalidVatCount) ? null : r.returns === null ? null : String(r.returns), freight: String(r.freight), newCustomer: String(r.newCustomer), customerStatusRaw: String(r.customerStatusRaw ?? ''),
    paymentCount: Number(r.paymentCount), invalidVatCount: Number(r.invalidVatCount) };
}

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
    const filterParams: Array<string | number> = [];
    let filter = '', warehouseFilter = '';
    if (warehouses) { warehouseFilter = ` AND d.DALMACEN IN (${warehouses.map(() => '?').join(',')})`; filter = warehouseFilter; filterParams.push(...warehouses); }
    const customerFilter = criteria.customerId === undefined ? '' : ' AND d.CLISEQ=?';
    filter += customerFilter;
    if (criteria.customerId !== undefined) filterParams.push(criteria.customerId);
    if (criteria.agent !== 'all') { filter += ' AND TRIM(d.DPAR1)=?'; filterParams.push(criteria.agent); }
    params.push(...filterParams);
    // DERIVADA: PA is aggregated once per invoice. D/C/K are separate dated
    // events below, so returns cannot be counted here and again as adjustments.
    const sql = `WITH period AS (
      SELECT a.DSEQ,a.AFECHA,a.ATIPMV,a.ACANT,d.DPORCIVA
      FROM fax a JOIN fdoc d ON d.DSEQ=a.DSEQ
      WHERE a.AFECHA>=? AND a.AFECHA<? AND a.ATIPMV='PA'
        AND LEFT(d.DNUM,2)<>'AF' AND LEFT(d.DNUM,1)='F' AND d.DESFACT=1
        AND NOT EXISTS (SELECT 1 FROM faxinv serviceLine JOIN finv serviceProduct ON serviceProduct.ISEQ=serviceLine.ISEQ
          WHERE serviceLine.DSEQ=d.DSEQ AND serviceProduct.ITIPO=?)${filter}
    ), collected AS (
      SELECT DSEQ,MIN(CASE WHEN ATIPMV='PA' THEN AFECHA END) firstPaymentDate,
        MAX(CASE WHEN ATIPMV='PA' THEN AFECHA END) lastPaymentDate,SUM(ATIPMV='PA') paymentCount,
        CAST(CAST(SUM(CASE WHEN ATIPMV='PA' THEN ACANT/NULLIF(1+DPORCIVA/100,0) ELSE 0 END) AS DECIMAL(38,8)) AS CHAR) payments,
        '0.00000000' returns,
        SUM(DPORCIVA IS NULL OR DPORCIVA=-100) invalidVatCount
      FROM period GROUP BY DSEQ HAVING SUM(ATIPMV='PA')>0
    )
    SELECT /*+ MAX_EXECUTION_TIME(30000) */ d.DSEQ id,d.DNUM number,d.DCANCELADA canceled,d.DFECHA date,c.firstPaymentDate,c.lastPaymentDate,
      COALESCE(f.CLICOD,'') customerCode,COALESCE(f.CLINOM,d.DCLINOM) customerName,
      TRIM(d.DPAR1) agentCode,COALESCE(NULLIF(g.name,''),'Sin agente identificado') agentName,d.DALMACEN warehouse,d.DMONEDA currency,d.DMULTICIA companyId,
      CAST(d.DBRUTO AS CHAR) subtotal,c.payments,c.returns,CAST(d.DCOSTOFLETE AS CHAR) freight,
      IF(f.CLITARJETA='Nuevo','Nuevo','') newCustomer,COALESCE(f.CLITARJETA,'') customerStatusRaw,c.paymentCount,c.invalidVatCount
    FROM collected c JOIN fdoc d ON d.DSEQ=c.DSEQ LEFT JOIN fcli f ON f.CLISEQ=d.CLISEQ
    LEFT JOIN (SELECT TRIM(AGTNUM) code,MAX(TRIM(AGDESCR)) name FROM fag WHERE AGT='1' GROUP BY TRIM(AGTNUM)) g ON g.code=TRIM(d.DPAR1)
    ORDER BY agentCode,d.DNUM,d.DSEQ LIMIT 10001`;
    // Each ASEQ owns one adjustment. K on an F document needs an earlier PA;
    // D/C credits do not need a PA in the selected period. Own credit postings
    // take precedence over a second application to an invoice's auxiliary.
    const adjustmentSql = `WITH events AS (
      SELECT a.ASEQ,a.DSEQ,a.AFECHA,a.ATIPMV,a.ACANT,a.AREFPAG,
        CASE WHEN a.ATIPMV='K' OR LEFT(d.DNUM,1) IN ('C','D') THEN d.DSEQ ELSE
          (SELECT CASE WHEN COUNT(*)=1 THEN MIN(x.DSEQ) END FROM fdoc x
           WHERE x.DNUM=a.AREFPAG AND x.DMULTICIA=d.DMULTICIA AND x.CLISEQ=d.CLISEQ AND LEFT(x.DNUM,1) IN ('C','D')) END sourceId
      FROM fax a JOIN fdoc d ON d.DSEQ=a.DSEQ
      WHERE a.AFECHA>=? AND a.AFECHA<? AND d.DESFACT=1${warehouseFilter}${customerFilter} AND (
        (a.ATIPMV='K' AND LEFT(d.DNUM,1)='F' AND a.ACANT<0 AND EXISTS
          (SELECT 1 FROM fax paid WHERE paid.DSEQ=d.DSEQ AND paid.ATIPMV='PA' AND paid.ACANT<0 AND paid.AFECHA<=a.AFECHA))
        OR (LEFT(a.ATIPMV,1) IN ('D','C') AND a.ACANT<0 AND LEFT(d.DNUM,1) IN ('F','D','C'))
        OR (a.ATIPMV='K' AND LEFT(d.DNUM,1) IN ('D','C') AND a.ACANT>0)
      )
    ), salesAgents AS (
      SELECT TRIM(AGTNUM) code,MAX(TRIM(AGDESCR)) name FROM fag WHERE AGT='1' GROUP BY TRIM(AGTNUM)
    ), creditCustomers AS (
      SELECT DISTINCT d.CLISEQ customerId,d.DMULTICIA companyId
      FROM events e JOIN fdoc d ON d.DSEQ=e.DSEQ
      WHERE LEFT(e.ATIPMV,1)='C' OR (e.ATIPMV='K' AND LEFT(d.DNUM,1)='C')
    ), creditAgents AS (
      SELECT c.customerId,c.companyId,
        (SELECT TRIM(x.DPAR1) FROM fdoc x
         WHERE x.CLISEQ=c.customerId AND x.DMULTICIA=c.companyId AND LEFT(x.DNUM,1)='F'
           AND x.DESFACT=1 AND x.DCANCELADA=0 AND x.DBRUTO>0 AND x.DFECHA<?
           AND EXISTS (SELECT 1 FROM salesAgents validAgent WHERE validAgent.code=TRIM(x.DPAR1) AND validAgent.code<>'')
         ORDER BY x.DFECHA DESC,x.DSEQ DESC LIMIT 1) billingAgent,
        (SELECT NULLIF(TRIM(f.CLIPAR1),'') FROM fcli f
         WHERE f.CLISEQ=c.customerId AND EXISTS (SELECT 1 FROM salesAgents validAgent WHERE validAgent.code=TRIM(f.CLIPAR1))) catalogAgent
      FROM creditCustomers c
    ), assigned AS (
      SELECT e.*,CASE WHEN LEFT(e.ATIPMV,1)='C' OR (e.ATIPMV='K' AND LEFT(d.DNUM,1)='C')
        THEN COALESCE(NULLIF(TRIM(r.DPAR1),''),TRIM(d.DPAR1)) ELSE TRIM(d.DPAR1) END originalAgentCode,
        CASE WHEN ca.customerId IS NOT NULL THEN COALESCE(ca.billingAgent,ca.catalogAgent,NULLIF(TRIM(r.DPAR1),''),TRIM(d.DPAR1)) ELSE TRIM(d.DPAR1) END agentCode,
        CASE WHEN ca.billingAgent IS NOT NULL THEN 'latest-invoice' WHEN ca.catalogAgent IS NOT NULL THEN 'customer-catalog' ELSE 'document' END agentAssignment
      FROM events e JOIN fdoc d ON d.DSEQ=e.DSEQ LEFT JOIN fdoc r ON r.DSEQ=e.sourceId
      LEFT JOIN creditAgents ca ON ca.customerId=d.CLISEQ AND ca.companyId=d.DMULTICIA
        AND (LEFT(e.ATIPMV,1)='C' OR (e.ATIPMV='K' AND LEFT(d.DNUM,1)='C'))
    ) SELECT /*+ MAX_EXECUTION_TIME(30000) */ d.DSEQ id,
      CASE WHEN LEFT(d.DNUM,1)='F' AND e.ATIPMV<>'K' THEN COALESCE(r.DNUM,NULLIF(e.AREFPAG,''),d.DNUM) ELSE d.DNUM END number,
      d.DCANCELADA canceled,COALESCE(r.DFECHA,d.DFECHA) date,e.AFECHA firstPaymentDate,e.AFECHA lastPaymentDate,
      COALESCE(f.CLICOD,'') customerCode,COALESCE(f.CLINOM,d.DCLINOM) customerName,e.agentCode,
      COALESCE(NULLIF(g.name,''),'Sin agente identificado') agentName,d.DALMACEN warehouse,d.DMONEDA currency,d.DMULTICIA companyId,
      e.originalAgentCode,COALESCE(NULLIF(og.name,''),'Sin agente identificado') originalAgentName,e.agentAssignment,
      CAST(COALESCE(r.DBRUTO,d.DBRUTO) AS CHAR) subtotal,'0.00000000' payments,'0.00000000' returns,'0.00' freight,
      IF(f.CLITARJETA='Nuevo','Nuevo','') newCustomer,COALESCE(f.CLITARJETA,'') customerStatusRaw,0 paymentCount,
      IF(d.DPORCIVA IS NULL OR d.DPORCIVA=-100,1,0) invalidVatCount,
      e.ASEQ movementId,e.ATIPMV movementType,e.sourceId sourceDocumentId,
      CAST(CAST(e.ACANT/NULLIF(1+d.DPORCIVA/100,0) AS DECIMAL(38,8)) AS CHAR) adjustmentAmount,
      CASE WHEN e.ATIPMV='K' AND LEFT(d.DNUM,1)='F' THEN 'cancellation'
           WHEN e.ATIPMV='K' THEN 'adjustment-reversal'
           WHEN LEFT(e.ATIPMV,1)='D' THEN 'return' ELSE 'credit-note' END adjustmentKind,
      CASE WHEN LEFT(d.DNUM,1)='F' THEN d.DNUM WHEN LEFT(d.DREFER,1)='F' THEN d.DREFER END relatedInvoiceNumber,
      CAST(CAST(COALESCE(NULLIF(r.DBRUTO,0),
        (SELECT SUM(ABS(original.ACANT)/NULLIF(1+r.DPORCIVA/100,0)) FROM fax original WHERE original.DSEQ=r.DSEQ
          AND ((LEFT(r.DNUM,1)='F' AND original.ATIPMV=r.DITIPMV)
            OR (LEFT(r.DNUM,1) IN ('D','C') AND LEFT(original.ATIPMV,1)=LEFT(r.DNUM,1))))) AS DECIMAL(38,8)) AS CHAR) sourceSubtotal
    FROM assigned e JOIN fdoc d ON d.DSEQ=e.DSEQ LEFT JOIN fdoc r ON r.DSEQ=e.sourceId
    LEFT JOIN fcli f ON f.CLISEQ=d.CLISEQ
    LEFT JOIN salesAgents g ON g.code=e.agentCode LEFT JOIN salesAgents og ON og.code=e.originalAgentCode
    WHERE NOT EXISTS (SELECT 1 FROM faxinv serviceLine JOIN finv serviceProduct ON serviceProduct.ISEQ=serviceLine.ISEQ
      WHERE serviceLine.DSEQ=d.DSEQ AND serviceProduct.ITIPO=?)
      AND NOT EXISTS (SELECT 1 FROM faxinv serviceLine JOIN finv serviceProduct ON serviceProduct.ISEQ=serviceLine.ISEQ
      WHERE serviceLine.DSEQ=e.sourceId AND serviceProduct.ITIPO=?)
      AND NOT (LEFT(d.DNUM,1)='F' AND LEFT(e.ATIPMV,1) IN ('D','C') AND e.sourceId IS NOT NULL AND EXISTS
          (SELECT 1 FROM fax posted WHERE posted.DSEQ=e.sourceId AND LEFT(posted.ATIPMV,1)=LEFT(e.ATIPMV,1) AND posted.ACANT<0))${criteria.agent === 'all' ? '' : ' AND e.agentCode=?'}
    ORDER BY agentCode,e.AFECHA,e.ASEQ LIMIT 10001`;
    const connection = await this.db.getConnection();
    try {
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      const [rows] = await connection.execute<RowDataPacket[]>(sql, params);
      const [adjustments] = await connection.execute<RowDataPacket[]>(adjustmentSql, [criteria.from, next.toISOString().slice(0, 10), ...(warehouses ?? []), ...(criteria.customerId === undefined ? [] : [criteria.customerId]), next.toISOString().slice(0, 10), 4, 4, ...(criteria.agent === 'all' ? [] : [criteria.agent])]);
      if (rows.length + adjustments.length > 10000) throw new ApplicationError('El reporte excede 10,000 documentos/ajustes. Reduce el periodo o selecciona sucursal/agente.', 'COLLECTION_COMMISSIONS_TOO_LARGE', 413);
      const invoices: CollectionInputs['invoices'] = [...rows.map(invoiceRow), ...adjustments.map(r => ({ ...invoiceRow(r),
        agentAttribution: { originalCode: String(r.originalAgentCode ?? r.agentCode).trim(), originalName: String(r.originalAgentName ?? r.agentName).trim(), source: r.agentAssignment ?? 'document' }, adjustment: {
        movementId: Number(r.movementId), kind: String(r.adjustmentKind) as CollectionAdjustment['kind'],
        date: String(r.lastPaymentDate), amount: r.adjustmentAmount === null ? null : String(r.adjustmentAmount), movementType: String(r.movementType).trim(),
        sourceDocumentId: r.sourceDocumentId === null ? null : Number(r.sourceDocumentId), sourceSubtotal: r.sourceSubtotal === null ? null : String(r.sourceSubtotal),
        relatedInvoiceNumber: r.relatedInvoiceNumber === null ? null : String(r.relatedInvoiceNumber).trim(),
      } }))];
      let movements: CollectionInputs['movements'] = [], products: CollectionInputs['products'] = [];
      if (invoices.length) {
        const ids = [...new Set(invoices.map(r => r.id))], placeholders = ids.map(() => '?').join(',');
        const [movementsRows] = await connection.execute<RowDataPacket[]>(`SELECT /*+ MAX_EXECUTION_TIME(30000) */ a.ASEQ id,a.DSEQ invoiceId,
          a.AFECHA date,a.ATIPMV type,CAST(a.ACANT AS CHAR) amount,CAST(d.DPORCIVA AS CHAR) vatRate,
          CAST(CAST(a.ACANT/NULLIF(1+d.DPORCIVA/100,0) AS DECIMAL(38,8)) AS CHAR) withoutVat,a.AREFPAG reference
          FROM fax a JOIN fdoc d ON d.DSEQ=a.DSEQ WHERE a.DSEQ IN (${placeholders}) AND a.AFECHA>=? AND a.AFECHA<?
            AND (a.ATIPMV IN ('PA','K') OR LEFT(a.ATIPMV,1) IN ('D','C')) ORDER BY a.AFECHA,a.ASEQ LIMIT 100001`, [...ids, criteria.from, next.toISOString().slice(0, 10)]);
        const productIds = [...new Set([...ids, ...invoices.flatMap(r => r.adjustment?.sourceDocumentId ? [r.adjustment.sourceDocumentId] : [])])];
        const [productRows] = await connection.execute<RowDataPacket[]>(`SELECT /*+ MAX_EXECUTION_TIME(30000) */ a.AISEQ id,a.DSEQ invoiceId,a.ISEQ productId,
          COALESCE(i.ICOD,'') code,COALESCE(i.IDESCR,'Producto no disponible') description,COALESCE(i.IFAMB,'') family,
          CAST(a.AICANT AS CHAR) quantity,CAST(a.AICANTF AS CHAR) billedQuantity,CAST(a.AIPRECIO AS CHAR) price,
          CAST(a.AICOSTO AS CHAR) unitCost,a.AIMES applied,a.AITIPMV movementType,COALESCE(i.ILUGAR,'') location,i.ITIPO typeId FROM faxinv a LEFT JOIN finv i ON i.ISEQ=a.ISEQ
          WHERE a.DSEQ IN (${productIds.map(() => '?').join(',')}) ORDER BY a.DSEQ,a.AISEQ LIMIT 100001`, productIds);
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
