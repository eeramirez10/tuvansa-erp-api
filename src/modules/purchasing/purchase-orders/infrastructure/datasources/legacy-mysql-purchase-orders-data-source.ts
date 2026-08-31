import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { PurchaseOrdersDataSource } from '../../domain/datasources/purchase-orders-data-source.js';
import { PurchaseOrder, type PurchaseOrderLine, type PurchaseOrderProps } from '../../domain/entities/purchase-order.js';
import type {
  PurchaseOrderNavigationDirection,
  PurchaseOrderPanelKey,
  PurchaseOrderPanelResult,
  PurchaseOrderSearchCriteria,
  PurchaseOrderSearchResult,
} from '../../domain/repositories/purchase-orders-repository.js';

interface HeaderRow extends RowDataPacket {
  id: number; number: string; supplierOrderNumber: string; supplierId: number;
  supplierCode: string | null; supplierName: string | null; documentType: number;
  status: string; branch: number; department: string; orderedAt: string;
  fromDate: string; dueAt: string; warehouse: string; initial: number;
  taxPercentage: number; subtotal: number; discount: number; exciseTax: number;
  freight: number; insurance: number; other: number; tax: number; total: number;
  classification1: string; classification2: string; classification3: string;
  classification4: string; classification5: string; classification6: string;
  classification7: string; classification8: string; classification9: string;
}

interface LineRow extends RowDataPacket, PurchaseOrderLine {}
interface CountRow extends RowDataPacket { total: number }
interface IdentityRow extends RowDataPacket { id: number; number: string; supplierId: number }

const selectHeader = `
  FPENC.PESEQ AS id,
  PENUM AS number,
  PENUMELLOS AS supplierOrderNumber,
  FPENC.PRVSEQ AS supplierId,
  FPRV.PRVCOD AS supplierCode,
  FPRV.PRVNOM AS supplierName,
  PESPEDIDO AS documentType,
  PESTATUS AS status,
  PESUCURSAL AS branch,
  PEDEPTO AS department,
  PEFECHA AS orderedAt,
  PEDESDE AS fromDate,
  PEVENCE AS dueAt,
  PEALMACEN AS warehouse,
  PEINICIAL AS initial,
  PEPORCIVA AS taxPercentage,
  PEBRUTO AS subtotal,
  PEDESC AS discount,
  PEIEPES AS exciseTax,
  PEFLETE AS freight,
  PESEGURO AS insurance,
  PEOTRO AS other,
  PEIVA AS tax,
  PECANT AS total,
  PEPAR1 AS classification1,
  PEPAR2 AS classification2,
  PEPAR3 AS classification3,
  PEPAR4 AS classification4,
  PEPAR5 AS classification5,
  PEPAR6 AS classification6,
  PEPAR7 AS classification7,
  PEPAR8 AS classification8,
  PEPAR9 AS classification9
`;

const selectLines = `
  FPLIN.PLSEQ AS id,
  FPLIN.ISEQ AS productId,
  COALESCE(FINV.ICOD, '') AS productCode,
  COALESCE(FINV.IDESCR, '') AS description,
  PLCANT AS ordered,
  PLSURT AS fulfilled,
  (PLCANT - PLSURT) AS remaining,
  PLUNIDAD AS unit,
  PLCLASE AS classCode,
  PLSUC AS branch,
  PLPRECI AS price,
  PLDESC AS discount,
  PLMONEDA AS currencyId,
  (COALESCE(FINV.ICONFIRMADO, 0) <> 0) AS confirmed,
  COALESCE(FINV.ICODPRV, '') AS observations,
  PLASIGNADO AS assigned,
  PLASIGNPZAS AS piecesAssignment,
  PLFACTOR AS factor,
  COALESCE(FINV.ICODPRV, '') AS supplierProductCode
`;

const nullableDate = (value: string): string | null => value === '1900-12-31' ? null : value;
const documentKind = (value: number): PurchaseOrderProps['documentKind'] =>
  value === 5 ? 'order' : value === 2 ? 'quote' : 'unknown';

const toPurchaseOrder = (row: HeaderRow, lines: PurchaseOrderLine[]): PurchaseOrder => PurchaseOrder.create({
  id: row.id,
  number: row.number,
  supplierOrderNumber: row.supplierOrderNumber,
  supplier: { id: row.supplierId, code: row.supplierCode ?? '', name: row.supplierName ?? '' },
  documentKind: documentKind(row.documentType),
  status: row.status,
  branch: Number(row.branch),
  department: row.department,
  dates: {
    orderedAt: nullableDate(row.orderedAt),
    from: nullableDate(row.fromDate),
    dueAt: nullableDate(row.dueAt),
  },
  warehouse: row.warehouse,
  initial: row.initial === 1,
  taxPercentage: Number(row.taxPercentage),
  classifications: [
    row.classification1, row.classification2, row.classification3,
    row.classification4, row.classification5, row.classification6,
    row.classification7, row.classification8, row.classification9,
  ],
  totals: {
    assigned: lines.reduce((total, line) => total + Number(line.assigned), 0),
    ordered: lines.reduce((total, line) => total + Number(line.ordered), 0),
    fulfilled: lines.reduce((total, line) => total + Number(line.fulfilled), 0),
    remaining: lines.reduce((total, line) => total + Number(line.remaining), 0),
    subtotal: Number(row.subtotal), discount: Number(row.discount),
    exciseTax: Number(row.exciseTax), freight: Number(row.freight),
    insurance: Number(row.insurance), other: Number(row.other),
    tax: Number(row.tax), total: Number(row.total),
  },
  lines,
});

const rowsToItems = (rows: RowDataPacket[]): Array<Record<string, unknown>> =>
  rows.map((row) => ({ ...row }));

const panelMetadata: Record<PurchaseOrderPanelKey, { button: string }> = {
  receipts: { button: 'Auxiliar' },
  classifications: { button: 'Clasificar' },
  comments: { button: 'Comentarios' },
};

export class LegacyMysqlPurchaseOrdersDataSource implements PurchaseOrdersDataSource {
  private async lines(id: number): Promise<PurchaseOrderLine[]> {
    const [rows] = await legacyMysqlPool.execute<LineRow[]>(
      `SELECT ${selectLines}
       FROM FPLIN
       LEFT JOIN FINV ON FPLIN.ISEQ = FINV.ISEQ
       WHERE FPLIN.PESEQ = ?
       ORDER BY FPLIN.PLSEQ`,
      [id],
    );
    return rows.map((row) => ({ ...row, confirmed: Boolean(row.confirmed) }));
  }

  private async header(where: string, parameters: Array<string | number>): Promise<PurchaseOrder | null> {
    const [rows] = await legacyMysqlPool.execute<HeaderRow[]>(
      `SELECT ${selectHeader}
       FROM FPENC
       LEFT JOIN FPRV ON FPENC.PRVSEQ = FPRV.PRVSEQ
       WHERE PESPEDIDO IN (2, 5) AND ${where}
       ORDER BY FPENC.PESEQ DESC LIMIT 1`,
      parameters,
    );
    const row = rows[0];
    return row === undefined ? null : toPurchaseOrder(row, await this.lines(row.id));
  }

  findById(id: number): Promise<PurchaseOrder | null> {
    return this.header('FPENC.PESEQ = ?', [id]);
  }

  findByNumber(number: string): Promise<PurchaseOrder | null> {
    return this.header('FPENC.PENUM = ?', [number]);
  }

  async search(criteria: PurchaseOrderSearchCriteria): Promise<PurchaseOrderSearchResult> {
    const conditions = ['PESPEDIDO IN (2, 5)'];
    const parameters: Array<string | number> = [];
    if (criteria.query !== undefined) {
      conditions.push('(UPPER(PENUM) LIKE UPPER(?) OR UPPER(PENUMELLOS) LIKE UPPER(?) OR UPPER(PRVCOD) LIKE UPPER(?) OR UPPER(PRVNOM) LIKE UPPER(?))');
      parameters.push(...Array(4).fill(`%${criteria.query}%`));
    }
    if (criteria.orderNumber !== undefined) { conditions.push('PENUM LIKE ?'); parameters.push(`${criteria.orderNumber}%`); }
    if (criteria.supplierOrderNumber !== undefined) { conditions.push('PENUMELLOS LIKE ?'); parameters.push(`${criteria.supplierOrderNumber}%`); }
    if (criteria.supplierCode !== undefined) { conditions.push('PRVCOD LIKE ?'); parameters.push(`${criteria.supplierCode}%`); }
    if (criteria.orderedAt !== undefined) { conditions.push('PEFECHA = ?'); parameters.push(criteria.orderedAt); }
    if (criteria.dueAt !== undefined) { conditions.push('PEVENCE = ?'); parameters.push(criteria.dueAt); }
    if (criteria.agent !== undefined) { conditions.push('PEPAR1 LIKE ?'); parameters.push(`${criteria.agent}%`); }
    if (criteria.documentType !== undefined) { conditions.push('PESPEDIDO = ?'); parameters.push(criteria.documentType); }
    const where = conditions.join(' AND ');
    const [rows] = await legacyMysqlPool.execute<HeaderRow[]>(
      `SELECT ${selectHeader}
       FROM FPENC
       LEFT JOIN FPRV ON FPENC.PRVSEQ = FPRV.PRVSEQ
       WHERE ${where}
       ORDER BY PENUM, FPENC.PESEQ
       LIMIT ? OFFSET ?`,
      [...parameters, criteria.limit, criteria.offset],
    );
    const [countRows] = await legacyMysqlPool.execute<CountRow[]>(
      `SELECT COUNT(*) AS total
       FROM FPENC LEFT JOIN FPRV ON FPENC.PRVSEQ = FPRV.PRVSEQ
       WHERE ${where}`,
      parameters,
    );
    return { items: rows.map((row) => toPurchaseOrder(row, [])), total: countRows[0]?.total ?? 0 };
  }

  async findAdjacent(id: number, direction: PurchaseOrderNavigationDirection): Promise<PurchaseOrder | null> {
    const [currentRows] = await legacyMysqlPool.execute<IdentityRow[]>(
      'SELECT PESEQ AS id, PENUM AS number, PRVSEQ AS supplierId FROM FPENC WHERE PESEQ = ? AND PESPEDIDO IN (2, 5) LIMIT 1',
      [id],
    );
    const current = currentRows[0];
    if (current === undefined) return null;
    const operator = direction === 'previous' ? '<' : '>';
    const order = direction === 'previous' ? 'DESC' : 'ASC';
    const [rows] = await legacyMysqlPool.execute<IdentityRow[]>(
      `SELECT PESEQ AS id, PENUM AS number, PRVSEQ AS supplierId
       FROM FPENC
       WHERE PESPEDIDO IN (2, 5) AND PENUM ${operator} ?
       ORDER BY PENUM ${order}, PESEQ ${order} LIMIT 1`,
      [current.number],
    );
    return rows[0] === undefined ? null : this.findById(rows[0].id);
  }

  async getPanel(id: number, key: PurchaseOrderPanelKey): Promise<PurchaseOrderPanelResult | null> {
    const [identityRows] = await legacyMysqlPool.execute<IdentityRow[]>(
      'SELECT PESEQ AS id, PENUM AS number, PRVSEQ AS supplierId FROM FPENC WHERE PESEQ = ? AND PESPEDIDO IN (2, 5) LIMIT 1',
      [id],
    );
    const identity = identityRows[0];
    if (identity === undefined) return null;

    let items: Array<Record<string, unknown>>;
    let summary: Record<string, unknown> | undefined;

    if (key === 'receipts') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT DNUM AS document, DFECHA AS date
         FROM FDOC
         WHERE DREFER = ? AND DEST = 0 AND DMULTICIA = 1
         ORDER BY DREFER, FDOC.DSEQ`,
        [identity.number],
      );
      items = rowsToItems(rows);
    } else if (key === 'classifications') {
      const purchaseOrder = await this.findById(id);
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT AGT AS classifier, AGNUM AS code, AGDESCR AS description, AGTNUM AS compositeCode
         FROM FAG
         WHERE AGT BETWEEN '1' AND '9' AND AGTIPO IN (0, 2)
         ORDER BY AGT, FAG.AGSEQ`,
      );
      items = rowsToItems(rows);
      summary = { current: purchaseOrder?.toPrimitives().classifications ?? [] };
    } else {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT FCOMENT.COMSEQ AS id, COMSEQFACT AS sequenceReference,
          COML1 AS comments, COML2 AS line2, COML3 AS line3, COML4 AS line4,
          COMLETRA AS amountInWords, COMCAJA AS boxes, COML5 AS line5,
          COMDNUM AS supplierDocumentNumber, COMDES AS description,
          COMCAJA2 AS createdBy, COMCAJA3 AS authorizedBy,
          COMCAJA4 AS changesCount, COMCAMBIOS AS auditTrail
         FROM FCOMENT
         WHERE COMSEQFACT = 10000000 + ?
         ORDER BY FCOMENT.COMSEQ LIMIT 1`,
        [id],
      );
      items = rowsToItems(rows);
      const purchaseOrder = await this.findById(id);
      summary = { ...(purchaseOrder?.toPrimitives() ?? {}) };
    }

    return {
      purchaseOrder: { id: identity.id, number: identity.number },
      key, section: 'actions', button: panelMetadata[key].button,
      source: 'mysql', items,
      ...(summary === undefined ? {} : { summary }),
    };
  }
}
