import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { LegacyPurchaseOrdersDataSource, PurchaseOrderAgentOverride } from '../../domain/datasources/purchase-orders-data-source.js';
import type { PurchaseOrderEditSnapshot } from '../../domain/datasources/purchase-order-edit-data-source.js';
import { PurchaseOrder, type PurchaseOrderLine, type PurchaseOrderProps } from '../../domain/entities/purchase-order.js';
import type {
  PurchaseOrderNavigationDirection,
  PurchaseOrderClassificationPanel,
  PurchaseOrderClassifier,
  PurchaseOrderPanelKey,
  PurchaseOrderPanelResult,
  PurchaseOrderSearchCriteria,
  PurchaseOrderSearchResult,
} from '../../domain/repositories/purchase-orders-repository.js';

interface IdentityRow extends RowDataPacket {
  id: number;
  number: string;
}

interface HeaderRow extends IdentityRow {
  supplierOrderNumber: string; supplierId: number;
  supplierCode: string | null; supplierName: string | null; documentType: number;
  status: string; branch: number; department: string; orderedAt: string;
  fromDate: string; dueAt: string; warehouse: string; initial: number;
  received: number; receivedPieces: number;
  taxPercentage: number; subtotal: number; discount: number; exciseTax: number;
  freight: number; insurance: number; other: number; tax: number; total: number;
  discount1: number; discount2: number; discount3: number; otherLabel: string;
}

interface LineRow extends RowDataPacket, PurchaseOrderLine {}
interface CountRow extends RowDataPacket { total: number }

const positions = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const currencyNames = Array.from({ length: 10 }, (_, index) => `FCIA.CIAPDD${index}`).join(', ');
const currencyName = (id: string) => `COALESCE(ELT((${id}) + 1, ${currencyNames}), '')`;
const classificationsFrom = (row: RowDataPacket) => positions.map((index) => String(row[`classification${index}`] ?? ''));

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
  PESURT AS received,
  PEPZASSURT AS receivedPieces,
  PEPORCIVA AS taxPercentage,
  PEBRUTO AS subtotal,
  PEDESC AS discount,
  PEIEPES AS exciseTax,
  PEFLETE AS freight,
  PESEGURO AS insurance,
  PEOTRO AS other,
  PEOTROTXT AS otherLabel,
  PEIVA AS tax,
  PECANT AS total,
  PDESC1 AS discount1,
  PDESC2 AS discount2,
  PDESC3 AS discount3,
  ${positions.map((index) => `PEPAR${index} AS classification${index}`).join(', ')}
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
  COALESCE(NULLIF(FPENC.PEMONEDA, 0), FINV.IMONEDA, 0) AS currencyId,
  ${currencyName('COALESCE(NULLIF(FPENC.PEMONEDA, 0), FINV.IMONEDA, 0)')} AS currencyName,
  (PLASIGNADO <> 0) AS confirmed,
  COALESCE(PLASIGNPZAS, '') AS observations,
  PLASIGNADO AS assigned,
  PLASIGNPZAS AS piecesAssignment,
  PLFACTOR AS factor,
  COALESCE(FINV.ICODPRV, '') AS supplierProductCode
`;

const nullableDate = (value: string | null): string | null =>
  !value || /^(1900-12-31|0000-00-00)/.test(value) ? null : value;
const documentKind = (value: number): PurchaseOrderProps['documentKind'] =>
  value === 2 ? 'order' : value === 5 ? 'quote' : 'unknown';

const toPurchaseOrder = (row: HeaderRow, lines: PurchaseOrderLine[]): PurchaseOrder => PurchaseOrder.create({
  id: row.id,
  number: row.number,
  supplierOrderNumber: row.supplierOrderNumber,
  supplier: { id: row.supplierId, code: row.supplierCode ?? '', name: row.supplierName ?? '' },
  documentKind: documentKind(row.documentType),
  status: row.status,
  received: { quantity: Number(row.received), pieces: Number(row.receivedPieces) },
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
  discountPercentages: [Number(row.discount1), Number(row.discount2), Number(row.discount3)],
  otherLabel: row.otherLabel ?? '',
  classifications: classificationsFrom(row),
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

interface ColorSizeEntry {
  root: string;
  description: string;
  color: string;
  size: string;
  ordered: number;
  fulfilled: number;
}
type ColorSizeRow = RowDataPacket & ColorSizeEntry;

const sizes = Array.from({ length: 16 }, (_, index) => 11 + index);

// Adaptación de EOC#6AA/240–241. La matriz sólo incluye las tallas configuradas.
async function colorSizeEntries(id: number, edited?: PurchaseOrderLine[]): Promise<ColorSizeEntry[]> {
  if (edited) {
    const [rows] = await legacyMysqlPool.query<(RowDataPacket & { rootLength: number; colorLength: number })[]>(
      'SELECT CIARAIZ AS rootLength, CIATALLA AS colorLength FROM FCIA WHERE CIASEQ=1',
    );
    const { rootLength, colorLength } = rows[0] ?? { rootLength: 0, colorLength: 0 };
    return edited.toSorted((left, right) => left.productCode.localeCompare(right.productCode) || left.id - right.id)
      .map((line) => ({
        root: line.productCode.slice(0, rootLength), color: line.productCode.slice(rootLength, rootLength + colorLength),
        size: line.productCode.slice(rootLength + colorLength), description: line.description,
        ordered: line.ordered, fulfilled: line.fulfilled,
      }));
  }
  const [lines] = await legacyMysqlPool.execute<ColorSizeRow[]>(
    `SELECT COALESCE(LEFT(FINV.ICOD, FCIA.CIARAIZ), '') AS root,
      COALESCE(FINV.IDESCR, '') AS description,
      COALESCE(SUBSTRING(FINV.ICOD, FCIA.CIARAIZ + 1, FCIA.CIATALLA), '') AS color,
      COALESCE(SUBSTRING(FINV.ICOD, FCIA.CIARAIZ + FCIA.CIATALLA + 1), '') AS size,
      PLCANT AS ordered, PLSURT AS fulfilled
     FROM FPLIN LEFT JOIN FINV ON FINV.ISEQ = FPLIN.ISEQ
     LEFT JOIN FCIA ON FCIA.CIASEQ = 1
     WHERE FPLIN.PESEQ = ? ORDER BY FINV.ICOD, FPLIN.PLSEQ`,
    [id],
  );
  return lines;
}

async function readColorSize(id: number, edited?: PurchaseOrderLine[]) {
  const lines = await colorSizeEntries(id, edited);
  const groups = new Map<string, {
    root: string; description: string; ordered: number; fulfilled: number; remaining: number;
    sizes: string[];
    colors: Array<{ color: string; ordered: number[]; fulfilled: number[]; remaining: number[] }>;
  }>();
  if (lines.length === 0) return { items: [], summary: { totals: { ordered: 0, fulfilled: 0, remaining: 0 } } };

  const roots = [...new Set(lines.map((line) => line.root))];
  const [configured] = await legacyMysqlPool.execute<RowDataPacket[]>(
    `SELECT FINV.ICOD AS root, ${sizes.map((number) => `FUNIDAD.UTALLA${number}`).join(', ')}
     FROM FINV LEFT JOIN FUNIDAD ON FUNIDAD.USEQ = FINV.USEQ
     WHERE FINV.ICOD IN (${roots.map(() => '?').join(', ')}) ORDER BY FINV.ISEQ`,
    roots,
  );
  const sizesByRoot = new Map<string, string[]>();
  for (const row of configured) {
    if (!sizesByRoot.has(row.root)) {
      sizesByRoot.set(row.root, sizes.map((number) => String(row[`UTALLA${number}`] ?? '').trim()).filter(Boolean));
    }
  }
  const totals = { ordered: 0, fulfilled: 0, remaining: 0 };
  for (const line of lines) {
    let group = groups.get(line.root);
    if (!group) {
      group = {
        root: line.root, description: line.description,
        ordered: 0, fulfilled: 0, remaining: 0, sizes: sizesByRoot.get(line.root) ?? [], colors: [],
      };
      groups.set(line.root, group);
    }
    const remaining = line.ordered - line.fulfilled;
    group.ordered += line.ordered;
    group.fulfilled += line.fulfilled;
    group.remaining += remaining;
    totals.ordered += line.ordered;
    totals.fulfilled += line.fulfilled;
    totals.remaining += remaining;

    const sizeIndex = group.sizes.indexOf(line.size);
    if (sizeIndex === -1) continue;
    let color = group.colors.find((entry) => entry.color === line.color);
    if (!color) {
      color = { color: line.color, ordered: group.sizes.map(() => 0), fulfilled: group.sizes.map(() => 0), remaining: group.sizes.map(() => 0) };
      group.colors.push(color);
    }
    color.ordered[sizeIndex] = (color.ordered[sizeIndex] ?? 0) + line.ordered;
    color.fulfilled[sizeIndex] = (color.fulfilled[sizeIndex] ?? 0) + line.fulfilled;
    color.remaining[sizeIndex] = (color.remaining[sizeIndex] ?? 0) + remaining;
  }
  return { items: [...groups.values()], summary: { totals } };
}

const panelMetadata: Record<PurchaseOrderPanelKey, { button: string }> = {
  receipts: { button: 'Auxiliar' },
  classifications: { button: 'Clasificar' },
  comments: { button: 'Comentarios' },
  ct: { button: 'CT' },
  pieces: { button: 'Piezas' },
};

export class LegacyMysqlPurchaseOrdersDataSource implements LegacyPurchaseOrdersDataSource {
  private async lines(id: number): Promise<PurchaseOrderLine[]> {
    const [rows] = await legacyMysqlPool.execute<LineRow[]>(
      `SELECT ${selectLines}
       FROM FPLIN
       JOIN FPENC ON FPLIN.PESEQ = FPENC.PESEQ
       LEFT JOIN FINV ON FPLIN.ISEQ = FINV.ISEQ
       LEFT JOIN FCIA ON FCIA.CIASEQ = 1
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

  async search(criteria: PurchaseOrderSearchCriteria, agents: PurchaseOrderAgentOverride[] = []): Promise<PurchaseOrderSearchResult> {
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
    if (criteria.agent !== undefined) {
      const matching = agents.filter((order) => order.matches);
      const excluded = agents.filter((order) => !order.matches);
      const orderPairs = (orders: PurchaseOrderAgentOverride[]) => orders.map(() => '(?, ?)').join(', ');
      const originalAgent = excluded.length === 0
        ? 'PEPAR1 LIKE ?'
        : `(PEPAR1 LIKE ? AND (FPENC.PESEQ, PENUM) NOT IN (${orderPairs(excluded)}))`;
      conditions.push(matching.length === 0
        ? originalAgent
        : `(${originalAgent} OR (FPENC.PESEQ, PENUM) IN (${orderPairs(matching)}))`);
      parameters.push(`${criteria.agent}%`, ...[...excluded, ...matching].flatMap((order) => [order.id, order.number]));
    }
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
    const current = await this.identity(id);
    if (current === undefined) return null;
    const operator = direction === 'previous' ? '<' : '>';
    const order = direction === 'previous' ? 'DESC' : 'ASC';
    const [rows] = await legacyMysqlPool.execute<IdentityRow[]>(
      `SELECT PESEQ AS id, PENUM AS number
       FROM FPENC
       WHERE PESPEDIDO IN (2, 5) AND PENUM ${operator} ?
       ORDER BY PENUM ${order}, PESEQ ${order} LIMIT 1`,
      [current.number],
    );
    return rows[0] === undefined ? null : this.findById(rows[0].id);
  }

  private async identity(id: number): Promise<IdentityRow | undefined> {
    const [rows] = await legacyMysqlPool.execute<IdentityRow[]>(
      'SELECT PESEQ AS id, PENUM AS number FROM FPENC WHERE PESEQ = ? AND PESPEDIDO IN (2, 5) LIMIT 1',
      [id],
    );
    return rows[0];
  }

  async getClassifications(id: number): Promise<PurchaseOrderClassificationPanel | null> {
    const [orders] = await legacyMysqlPool.execute<IdentityRow[]>(
      `SELECT PESEQ AS id, PENUM AS number,
        ${positions.map((index) => `PEPAR${index} AS classification${index}`).join(', ')},
        ${positions.map((index) => `FCIA.CIAPAR${index} AS label${index}`).join(', ')},
        (SELECT YGDAT FROM FYG WHERE YGKEY = 'ABITITPAR2' LIMIT 1) AS configuredLabels
       FROM FPENC LEFT JOIN FCIA ON FCIA.CIASEQ = 1
       WHERE PESEQ = ? AND PESPEDIDO IN (2, 5)`,
      [id],
    );
    const order = orders[0];
    if (!order) return null;
    const configuredLabels = typeof order.configuredLabels === 'string' ? order.configuredLabels.split(',') : null;
    const [options] = await legacyMysqlPool.execute<(RowDataPacket & PurchaseOrderClassifier)[]>(
      `SELECT CAST(AGT AS UNSIGNED) AS classifier, AGNUM AS code, AGDESCR AS description, AGTNUM AS compositeCode
       FROM FAG WHERE AGT IN ('1','2','3','4','5','6','7','8','9') AND AGTIPO IN (0, 2)
       ORDER BY AGT, AGNUM, AGSEQ`,
    );
    return {
      purchaseOrder: { id, number: order.number },
      key: 'classifications', section: 'actions', button: 'Clasificar', source: 'mysql',
      items: options.map((option) => ({ ...option })),
      summary: {
        labels: positions.map((index) => configuredLabels
          ? configuredLabels[index - 1] ?? ''
          : String(order[`label${index}`] ?? '')),
        current: classificationsFrom(order), revision: 0, canWrite: false,
      },
    };
  }

  async getPanel(id: number, key: Exclude<PurchaseOrderPanelKey, 'classifications'>, edits?: PurchaseOrderEditSnapshot[]): Promise<PurchaseOrderPanelResult | null> {
    const identity = await this.identity(id);
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
    } else if (key === 'ct') {
      const result = await readColorSize(id, edits?.find((edit) => edit.number === identity.number)?.lines);
      items = result.items;
      summary = result.summary;
    } else if (key === 'pieces') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT CAJSEQ AS id, FINV.ICOD AS productCode, CAJSERIE AS serial, CAJPZAS AS pieces,
          CAJCANT AS quantity, CAJALM AS warehouse, CAJFACTURA AS document, CAJRECEPCION AS receipt
         FROM FCAJAS LEFT JOIN FINV ON FINV.ISEQ = FCAJAS.ISEQ
         WHERE CAJFACTURA = ? ORDER BY CAJSEQ`,
        [identity.number],
      );
      items = rowsToItems(rows);
      summary = { totalQuantity: rows.reduce((total, row) => total + Number(row.quantity), 0) };
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
      const [headers] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT PEPLAZO AS terms, FPENC.PETIPOC AS exchangeRate, PEMONEDA AS currencyId,
          ${currencyName('PEMONEDA')} AS currencyName, FPENC.PEDATE2 AS createdAt, FPENC.PEDATE3 AS modifiedAt,
          PEUSRALTA AS createdBy, PEUSRAUT AS authorizedBy, PECAMBIOS AS changesCount,
          TICOML1 AS label1, TICOML2 AS label2, TICOML3 AS label3, TICOML4 AS label4, TICOML5 AS label5
         FROM FPENC LEFT JOIN FCIA ON FCIA.CIASEQ = 1
         LEFT JOIN FTIPMV ON FTIPMV.TISEQ = (
           SELECT TISEQ FROM FTIPMV WHERE TICLA = LEFT(FPENC.PENUM, 1) ORDER BY TISEQ LIMIT 1
         )
         WHERE PESEQ = ?`,
        [id],
      );
      const header = headers[0];
      if (header) {
        const purchaseOrder = await this.findById(id);
        summary = {
          ...purchaseOrder?.toPrimitives(),
          ...header,
          createdAt: nullableDate(header.createdAt),
          modifiedAt: nullableDate(header.modifiedAt),
          labels: [header.label1, header.label2, header.label3, header.label4, header.label5],
        };
      }
    }

    return {
      purchaseOrder: { id: identity.id, number: identity.number },
      key, section: 'actions', button: panelMetadata[key].button,
      source: 'mysql', items,
      ...(summary === undefined ? {} : { summary }),
    };
  }
}
