import type { RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { SupplierPanelsDataSource } from '../../domain/datasources/supplier-panels-data-source.js';
import type {
  SupplierClassificationResult,
  SupplierPanelIdentity,
  SupplierPanelKey,
  SupplierPanelResult,
} from '../../domain/repositories/supplier-panels-repository.js';

interface IdentityRow extends RowDataPacket {
  id: number;
  code: string;
  name: string;
  currentBalance: number;
}

interface ClassificationRow extends RowDataPacket {
  id: number;
  code: string;
  description: string;
  number: string;
  type: string;
}

interface SelectedClassificationsRow extends RowDataPacket {
  class1: string;
  class2: string;
  class3: string;
  class4: string;
  class5: string;
  class6: string;
  class7: string;
  class8: string;
  class9: string;
}

const classificationLabels = [
  'AGENTE', 'TIPO CLIENTE', 'SUCURSAL', '', '', 'TIPO', 'FLETE', 'TIPO DE PROVEEDOR', 'PROYECTO',
] as const;

const toRecords = (rows: RowDataPacket[]): Array<Record<string, unknown>> =>
  rows.map((row) => ({ ...row }));

export class LegacyMysqlSupplierPanelsDataSource implements SupplierPanelsDataSource {
  private async findSupplier(supplierId: number): Promise<SupplierPanelIdentity | null> {
    const [rows] = await legacyMysqlPool.execute<IdentityRow[]>(`
      SELECT PRVSEQ AS id, PRVCOD AS code, PRVNOM AS name, PRVSACT AS currentBalance
      FROM FPRV WHERE PRVSEQ = ? LIMIT 1
    `, [supplierId]);
    return rows[0] ?? null;
  }

  async findPanel(supplierId: number, key: SupplierPanelKey): Promise<SupplierPanelResult | null> {
    const supplier = await this.findSupplier(supplierId);
    if (supplier === null) return null;

    if (key === 'work-in-progress') {
      return {
        supplier,
        items: [],
        unavailableReason: 'OMNIS abrió W.I.P. sin emitir una consulta MySQL para el proveedor capturado.',
      };
    }

    if (key === 'block-status') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(`
        SELECT PRVBAJA = '1900-12-31' AS isActive,
               NULLIF(DATE(PRVBAJA), '1900-12-31') AS deactivatedAt
        FROM FPRV WHERE PRVSEQ = ? LIMIT 1
      `, [supplierId]);
      return { supplier, items: [], detail: { ...(rows[0] ?? {}) } };
    }

    if (key === 'discounts') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(`
        SELECT PRVDESC1 AS discount1, PRVDESC2 AS discount2
        FROM FPRV WHERE PRVSEQ = ? LIMIT 1
      `, [supplierId]);
      return { supplier, items: [], detail: { ...(rows[0] ?? {}) } };
    }

    if (key === 'various') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(`
        SELECT PRVBMXID AS banamexId, PRVBMXSUC AS branch,
               PRVBMXCTABANCO AS bankAccount, PRVBMXBANCO AS bankCode,
               PRVBMXCD AS city, PRVBMXEDO AS state, PRVREFCIE AS cieReference,
               PRVPASWORD AS internetPassword, PRVMULTICIA AS multiCompany,
               PRVINTERCIA AS interCompany, PRVTIEMPO AS deliveryDays,
               PRVFRECCOM AS purchaseFrequencyDays, PRVTOLERANCIA AS tolerancePercent,
               PRVTIPOIVA AS vatType, PRVRETIVA AS vatWithholdingPercent,
               PRVRETISR AS incomeTaxWithholdingPercent, PRVTIPTER AS thirdPartyType,
               PRVTIPOOPER AS operationType, PRVCATPAIS AS countryCode,
               PRVVARIOS1 AS minimum1, PRVVARIOS2 AS minimum2,
               PRVVARIOS3 AS minimum3, PRVVARIOS4 AS minimum4,
               PRVVARIOS5 AS minimum5, PRVVARIOS6 AS minimum6,
               PRVVARIOS7 AS minimum7, PRVVARIOS8 AS minimum8,
               PRVVARIOS9 AS amount1, PRVVARIOS10 AS amount2,
               PRVVARIOS11 AS amount3, PRVVARIOS12 AS amount4
        FROM FPRV WHERE PRVSEQ = ? LIMIT 1
      `, [supplierId]);
      return { supplier, items: [], detail: { ...(rows[0] ?? {}) } };
    }

    const [rows] = await this.executePanelQuery(supplierId, supplier.code, key);
    const items = toRecords(rows);
    const summary = this.buildSummary(key, items);
    return { supplier, items, ...(summary === undefined ? {} : { summary }) };
  }

  private executePanelQuery(
    supplierId: number,
    supplierCode: string,
    key: Exclude<SupplierPanelKey, 'block-status' | 'discounts' | 'various' | 'work-in-progress'>,
  ): Promise<[RowDataPacket[], unknown]> {
    switch (key) {
      case 'events':
        return legacyMysqlPool.execute<RowDataPacket[]>(`
          SELECT EVSEQ AS id, DATE(EVFECHA) AS date, EVTITULO AS title,
                 EVDESCR AS description, DATE(EVFOLLOW) AS followUpAt,
                 DATE(EVENCE) AS dueAt, EVTIPO AS type, EVRESPONSABLE AS responsible,
                 EVSOLICITA AS requestedBy, EVIMPORTANCIA AS importance,
                 EVCOMPLEJIDAD AS complexity, EVDONE AS done, EVPROYECTO AS project,
                 EVNUM AS number, EVFACTURA AS invoice, EVCOSTO AS cost,
                 EVEJECUTA AS executedBy, EVSUC AS branch, EVDEPTO AS department
          FROM FEVENTOS WHERE PRVSEQ = ? ORDER BY EVSEQ
        `, [supplierId]);
      case 'contacts':
        return legacyMysqlPool.execute<RowDataPacket[]>(`
          SELECT CONTSEQ AS id, CONTNOMBRE AS name, CONTPUESTO AS position,
                 CONTTEL1 AS phone1, CONTTEL2 AS phone2, CONTTEL3 AS fax,
                 CONTMAIL AS email, CONTOBS AS notes, DATE(CONTCUMPLE) AS birthday,
                 CONTINTERES AS interests, CONTEXT AS extension, CONTCEL AS mobile
          FROM FCONTACTOS WHERE CONTKEY = ? ORDER BY CONTSEQ
        `, [supplierCode]);
      case 'balance':
        return legacyMysqlPool.execute<RowDataPacket[]>(`
          SELECT FDOC.DSEQ AS id, DMULTICIA AS company, DNUM AS document,
                 DATE(DFECHA) AS date, DATE(DVENCE) AS dueDate,
                 DATEDIFF(CURRENT_DATE, DVENCE) AS days, DCANT AS originalAmount,
                 DCANTF AS amount, DMONEDA AS currency, DREFER AS reference,
                 DATE(DFECHAPROGR) AS scheduledAt, DPAR2 AS secondaryReference,
                 DRUTA AS route, DTIPOC AS exchangeRate, DFOLIO AS folio
          FROM FDOC LEFT JOIN FPRV ON FDOC.PRVSEQ = FPRV.PRVSEQ
          WHERE FPRV.PRVSEQ = ? AND DEST = 0 AND DMULTICIA = 1 AND DESCXC = 2
          ORDER BY FPRV.PRVSEQ, FDOC.DSEQ
        `, [supplierId]);
      case 'movements':
        return legacyMysqlPool.execute<RowDataPacket[]>(`
          SELECT FAX.ASEQ AS id, 0 AS company, DATE(AFECHA) AS date, DNUM AS document,
                 ACANT AS amount, ATIPMV AS movementType, AREFPAG AS paymentReference,
                 AUSEQ AS userId, ADIFCAMBIAR AS exchangeDifference,
                 ATIPOC AS exchangeRate, APOLIZA AS policy,
                 DREFERELLOS AS documentReference, DESCXC AS accountType,
                 DMONEDA AS currency
          FROM FAX LEFT JOIN FPRV ON FAX.PRVSEQ = FPRV.PRVSEQ
          LEFT JOIN FDOC ON FAX.DSEQ = FDOC.DSEQ
          WHERE FPRV.PRVSEQ = ? AND AMES = 1 AND DEST = 0 AND DMULTICIA = 1
          ORDER BY FPRV.PRVSEQ, FAX.ASEQ
        `, [supplierId]);
      case 'invoices':
        return legacyMysqlPool.execute<RowDataPacket[]>(`
          SELECT FDOC.DSEQ AS id, DMULTICIA AS company, DNUM AS document,
                 DATE(DFECHA) AS date, DATE(DVENCE) AS dueDate, DCANTF AS amount,
                 DREFERELLOS AS reference, DREFER AS secondaryReference,
                 DESFACT AS status, DATE(DFECHAPAGO) AS paidAt,
                 DATE(DFECHAPEDIDO) AS orderedAt
          FROM FDOC LEFT JOIN FPRV ON FDOC.PRVSEQ = FPRV.PRVSEQ
          WHERE FPRV.PRVSEQ = ? AND DESFACT IN (2, 3) AND DEST = 0 AND DMULTICIA = 1
          ORDER BY FPRV.PRVSEQ, FDOC.DSEQ
        `, [supplierId]);
      case 'ordered-products':
        return legacyMysqlPool.execute<RowDataPacket[]>(`
          SELECT FPLIN.PLSEQ AS id, ICOD AS productCode, IDESCR AS description,
                 PLCANT AS orderedQuantity, PLSURT AS fulfilledQuantity,
                 PLCANT - PLSURT AS remainingQuantity, ISTKACT AS stock,
                 PENUM AS orderNumber, DATE(PEFECHA) AS orderDate,
                 DATE(PEDATE2) AS expectedAt, PEDESDE AS source,
                 PESPEDIDO AS status, PLCLASE AS class, IUM AS unit,
                 PLPRECI AS price, PLUNIDAD AS priceUnit, PLFACTOR AS factor,
                 PLASIGNPZAS AS assignedPieces, PLASIGNADO AS assigned,
                 PEPAR2 AS notes, PEALMACEN AS warehouse
          FROM FPLIN LEFT JOIN FPRV ON FPLIN.PRVSEQ = FPRV.PRVSEQ
          LEFT JOIN FINV ON FPLIN.ISEQ = FINV.ISEQ
          LEFT JOIN FPENC ON FPLIN.PESEQ = FPENC.PESEQ
          WHERE FPRV.PRVSEQ = ? AND PESPEDIDO <> 5 AND PEMULTICIA = 1
          ORDER BY FPRV.PRVSEQ, FPLIN.PLSEQ
        `, [supplierId]);
      case 'fill-rate':
        return legacyMysqlPool.execute<RowDataPacket[]>(`
          SELECT FPENC.PESEQ AS id, PENUM AS orderNumber, DATE(PEFECHA) AS date,
                 DATE(PEVENCE) AS dueDate, PEDESDE AS source, PESURT AS fulfilled,
                 PENUMELLOS AS supplierOrder, PECANT AS amount, PEBRUTO AS gross,
                 PEDESC AS discount, PESPEDIDO AS status
          FROM FPENC LEFT JOIN FPRV ON FPENC.PRVSEQ = FPRV.PRVSEQ
          WHERE FPRV.PRVSEQ = ? AND PEMULTICIA = 1
          ORDER BY FPRV.PRVSEQ, FPENC.PESEQ
        `, [supplierId]);
      case 'quoted-products':
        return legacyMysqlPool.execute<RowDataPacket[]>(`
          SELECT FPLIN.PLSEQ AS id, ICOD AS productCode, IDESCR AS description,
                 PLCANT AS quotedQuantity, PLSURT AS fulfilledQuantity,
                 PLCANT - PLSURT AS remainingQuantity, ISTKACT AS stock,
                 PENUM AS quoteNumber, DATE(PEFECHA) AS date,
                 PLPRECI AS price, IUM AS unit
          FROM FPLIN LEFT JOIN FPRV ON FPLIN.PRVSEQ = FPRV.PRVSEQ
          LEFT JOIN FINV ON FPLIN.ISEQ = FINV.ISEQ
          LEFT JOIN FPENC ON FPLIN.PESEQ = FPENC.PESEQ
          WHERE FPRV.PRVSEQ = ? AND PESPEDIDO = 5 AND PEMULTICIA = 1
          ORDER BY FPRV.PRVSEQ, FPLIN.PLSEQ
        `, [supplierId]);
      case 'purchased-products':
        return legacyMysqlPool.execute<RowDataPacket[]>(`
          SELECT MIN(FAXINV.AISEQ) AS id, ICOD AS productCode, IDESCR AS description,
                 SUM(AICANTF) AS quantity, SUM(AICANTF * AIPRECIO) AS amount
          FROM FAXINV LEFT JOIN FPRV ON FAXINV.PRVSEQ = FPRV.PRVSEQ
          LEFT JOIN FINV ON FAXINV.ISEQ = FINV.ISEQ
          LEFT JOIN FDOC ON FAXINV.DSEQ = FDOC.DSEQ
          WHERE FPRV.PRVSEQ = ? AND DEST = 0 AND DMULTICIA = 1 AND AIMES = 1
          GROUP BY ICOD, IDESCR ORDER BY ICOD
        `, [supplierId]);
      case 'purchased-products-detail':
        return legacyMysqlPool.execute<RowDataPacket[]>(`
          SELECT FAXINV.AISEQ AS id, ICOD AS productCode, IDESCR AS description,
                 AICANTF AS quantity, AIPRECIO AS price, DNUM AS document,
                 DATE(DFECHA) AS date, AIPZAS AS pieces
          FROM FAXINV LEFT JOIN FPRV ON FAXINV.PRVSEQ = FPRV.PRVSEQ
          LEFT JOIN FINV ON FAXINV.ISEQ = FINV.ISEQ
          LEFT JOIN FDOC ON FAXINV.DSEQ = FDOC.DSEQ
          WHERE FPRV.PRVSEQ = ? AND DEST = 0 AND DMULTICIA = 1 AND AIMES = 1
          ORDER BY FPRV.PRVSEQ, FAXINV.AISEQ
        `, [supplierId]);
      case 'price-history':
        return legacyMysqlPool.execute<RowDataPacket[]>(`
          SELECT FAXINV.AISEQ AS id, ICOD AS productCode, IDESCR AS description,
                 AICANTF AS quantity, AIPRECIO AS price, DATE(DFECHA) AS date
          FROM FAXINV LEFT JOIN FPRV ON FAXINV.PRVSEQ = FPRV.PRVSEQ
          LEFT JOIN FINV ON FAXINV.ISEQ = FINV.ISEQ
          LEFT JOIN FDOC ON FAXINV.DSEQ = FDOC.DSEQ
          WHERE FPRV.PRVSEQ = ? AND DEST = 0 AND DMULTICIA = 1
            AND AIMES = 1 AND AICANTF > 1
          ORDER BY FPRV.PRVSEQ, FAXINV.AISEQ
        `, [supplierId]);
      case 'purchased-expenses':
        return legacyMysqlPool.execute<RowDataPacket[]>(`
          SELECT FBANMOV.BASEQ AS id, BCOD AS expenseCode, BNOMBRE AS description,
                 BAIMPOR AS amount, BAIMPORNEG AS negativeAmount
          FROM FBANMOV LEFT JOIN FPRV ON FBANMOV.PRVSEQ = FPRV.PRVSEQ
          LEFT JOIN FBENC ON FBANMOV.BSEQ = FBENC.BSEQ
          WHERE FPRV.PRVSEQ = ? AND BAMES = 1 AND BCOD <> PRVCTA
          ORDER BY FPRV.PRVSEQ, FBANMOV.BASEQ
        `, [supplierId]);
      case 'annual-purchases':
        return legacyMysqlPool.execute<RowDataPacket[]>(`
          SELECT MIN(FAXINV.AISEQ) AS id, ICOD AS productCode, MAX(IDESCR) AS description,
                 YEAR(DFECHA) AS year,
                 SUM(CASE WHEN MONTH(DFECHA)=1 THEN AICANTF ELSE 0 END) AS january,
                 SUM(CASE WHEN MONTH(DFECHA)=2 THEN AICANTF ELSE 0 END) AS february,
                 SUM(CASE WHEN MONTH(DFECHA)=3 THEN AICANTF ELSE 0 END) AS march,
                 SUM(CASE WHEN MONTH(DFECHA)=4 THEN AICANTF ELSE 0 END) AS april,
                 SUM(CASE WHEN MONTH(DFECHA)=5 THEN AICANTF ELSE 0 END) AS may,
                 SUM(CASE WHEN MONTH(DFECHA)=6 THEN AICANTF ELSE 0 END) AS june,
                 SUM(CASE WHEN MONTH(DFECHA)=7 THEN AICANTF ELSE 0 END) AS july,
                 SUM(CASE WHEN MONTH(DFECHA)=8 THEN AICANTF ELSE 0 END) AS august,
                 SUM(CASE WHEN MONTH(DFECHA)=9 THEN AICANTF ELSE 0 END) AS september,
                 SUM(CASE WHEN MONTH(DFECHA)=10 THEN AICANTF ELSE 0 END) AS october,
                 SUM(CASE WHEN MONTH(DFECHA)=11 THEN AICANTF ELSE 0 END) AS november,
                 SUM(CASE WHEN MONTH(DFECHA)=12 THEN AICANTF ELSE 0 END) AS december,
                 SUM(AICANTF) AS total
          FROM FAXINV LEFT JOIN FPRV ON FAXINV.PRVSEQ = FPRV.PRVSEQ
          LEFT JOIN FDOC ON FAXINV.DSEQ = FDOC.DSEQ
          LEFT JOIN FINV ON FAXINV.ISEQ = FINV.ISEQ
          WHERE FPRV.PRVSEQ = ? AND AIMES = 1 AND DEST = 0
          GROUP BY ICOD, YEAR(DFECHA) ORDER BY ICOD, year
        `, [supplierId]);
      case 'annual-purchases-summary':
        return legacyMysqlPool.execute<RowDataPacket[]>(`
          SELECT MIN(FDOC.DSEQ) AS id, YEAR(DFECHA) AS year,
                 SUM(CASE WHEN MONTH(DFECHA)=1 THEN DBRUTO-DDESC ELSE 0 END) AS january,
                 SUM(CASE WHEN MONTH(DFECHA)=2 THEN DBRUTO-DDESC ELSE 0 END) AS february,
                 SUM(CASE WHEN MONTH(DFECHA)=3 THEN DBRUTO-DDESC ELSE 0 END) AS march,
                 SUM(CASE WHEN MONTH(DFECHA)=4 THEN DBRUTO-DDESC ELSE 0 END) AS april,
                 SUM(CASE WHEN MONTH(DFECHA)=5 THEN DBRUTO-DDESC ELSE 0 END) AS may,
                 SUM(CASE WHEN MONTH(DFECHA)=6 THEN DBRUTO-DDESC ELSE 0 END) AS june,
                 SUM(CASE WHEN MONTH(DFECHA)=7 THEN DBRUTO-DDESC ELSE 0 END) AS july,
                 SUM(CASE WHEN MONTH(DFECHA)=8 THEN DBRUTO-DDESC ELSE 0 END) AS august,
                 SUM(CASE WHEN MONTH(DFECHA)=9 THEN DBRUTO-DDESC ELSE 0 END) AS september,
                 SUM(CASE WHEN MONTH(DFECHA)=10 THEN DBRUTO-DDESC ELSE 0 END) AS october,
                 SUM(CASE WHEN MONTH(DFECHA)=11 THEN DBRUTO-DDESC ELSE 0 END) AS november,
                 SUM(CASE WHEN MONTH(DFECHA)=12 THEN DBRUTO-DDESC ELSE 0 END) AS december,
                 SUM(DBRUTO-DDESC) AS total
          FROM FDOC LEFT JOIN FPRV ON FDOC.PRVSEQ = FPRV.PRVSEQ
          WHERE FPRV.PRVSEQ = ? AND DESFACT = 2 AND DEST = 0
          GROUP BY YEAR(DFECHA) ORDER BY year
        `, [supplierId]);
    }
  }

  private buildSummary(key: SupplierPanelKey, items: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
    const numericSum = (field: string) => items.reduce((total, item) => {
      const value = Number(item[field]);
      return total + (Number.isFinite(value) ? value : 0);
    }, 0);
    if (key === 'balance') return { amount: numericSum('amount'), originalAmount: numericSum('originalAmount') };
    if (key === 'purchased-products') return { amount: numericSum('amount') };
    if (key === 'purchased-expenses') return { amount: numericSum('amount'), negativeAmount: numericSum('negativeAmount') };
    return undefined;
  }

  async findClassifications(supplierId: number, position: number): Promise<SupplierClassificationResult | null> {
    const supplier = await this.findSupplier(supplierId);
    if (supplier === null) return null;
    const [selectedRows] = await legacyMysqlPool.execute<SelectedClassificationsRow[]>(`
      SELECT PRVPAR1 AS class1, PRVPAR2 AS class2, PRVPAR3 AS class3,
             PRVPAR4 AS class4, PRVPAR5 AS class5, PRVPAR6 AS class6,
             PRVPAR7 AS class7, PRVPAR8 AS class8, PRVPAR9 AS class9
      FROM FPRV WHERE PRVSEQ = ? LIMIT 1
    `, [supplierId]);
    const selected = selectedRows[0];
    if (selected === undefined) return null;
    const [options] = await legacyMysqlPool.execute<ClassificationRow[]>(`
      SELECT AGSEQ AS id, AGTNUM AS code, AGDESCR AS description,
             AGNUM AS number, AGT AS type
      FROM FAG WHERE AGT = ? AND AGTIPO IN (0, 2)
      ORDER BY AGT, AGSEQ
    `, [String(position)]);
    const selectedCodes = [selected.class1, selected.class2, selected.class3, selected.class4,
      selected.class5, selected.class6, selected.class7, selected.class8, selected.class9];
    const descriptions = new Map(options.map((option) => [option.code, option.description]));
    return {
      supplier,
      classifications: selectedCodes.map((code, index) => ({
        position: index + 1,
        label: classificationLabels[index] ?? '',
        code,
        description: descriptions.get(code) ?? '',
      })),
      selectedPosition: position,
      options: options.map((option) => ({
        id: option.id, code: option.code, description: option.description,
        number: option.number, type: option.type,
      })),
    };
  }
}
