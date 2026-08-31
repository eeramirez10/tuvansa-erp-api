import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { PurchaseReceptionsDataSource } from '../../domain/datasources/purchase-receptions-data-source.js';
import { PurchaseReception, type PurchaseReceptionLine } from '../../domain/entities/purchase-reception.js';
import type {
  PurchaseReceptionNavigationDirection,
  PurchaseReceptionPanelKey,
  PurchaseReceptionPanelResult,
  PurchaseReceptionSearchCriteria,
  PurchaseReceptionSearchResult,
} from '../../domain/repositories/purchase-receptions-repository.js';

interface HeaderRow extends RowDataPacket {
  id: number; number: string; orderNumber: string; supplierReference: string;
  supplierId: number; supplierCode: string | null; supplierName: string | null;
  department: string; warehouse: string; branch: number; status: string;
  cancelled: number; receivedAt: string; dueAt: string; orderedAt: string;
  classification1: string; classification2: string; classification3: string;
  classification4: string; classification5: string; classification6: string;
  classification7: string; classification8: string; classification9: string;
  discountPercentage1: number; discountPercentage2: number; discountPercentage3: number;
  pieces: number; subtotal: number; discount: number; freight: number;
  insurance: number; other: number; otherLabel: string; exciseTax: number;
  taxPercentage: number; tax: number; withholdingTax: number; total: number; balance: number;
}

interface LineRow extends RowDataPacket {
  id: number; productId: number; productCode: string | null; description: string | null;
  quantity: number; invoicedQuantity: number; unit: string | null; price: number;
  grossPrice: number; discount: number; pieces: string; costCenter: number;
  branch: number; lotId: number; inventoryCreatedAt: string;
}

interface CountRow extends RowDataPacket { total: number }
interface IdentityRow extends RowDataPacket { id: number; number: string }

const documentFilter = '(FDOC.DESFACT IN (2, 3) OR FDOC.DESCXC = 2) AND FDOC.DEST = 0 AND FDOC.DMULTICIA = 1';

const selectHeader = `
  FDOC.DSEQ AS id,
  FDOC.DNUM AS number,
  FDOC.DREFER AS orderNumber,
  FDOC.DREFERELLOS AS supplierReference,
  FDOC.PRVSEQ AS supplierId,
  FPRV.PRVCOD AS supplierCode,
  FPRV.PRVNOM AS supplierName,
  FDOC.DDEPTO AS department,
  FDOC.DALMACEN AS warehouse,
  FDOC.DSUCURSAL AS branch,
  FDOC.DSTATUS AS status,
  FDOC.DCANCELADA AS cancelled,
  FDOC.DFECHA AS receivedAt,
  FDOC.DVENCE AS dueAt,
  FDOC.DFECHAPEDIDO AS orderedAt,
  FDOC.DPAR1 AS classification1,
  FDOC.DPAR2 AS classification2,
  FDOC.DPAR3 AS classification3,
  FDOC.DPAR4 AS classification4,
  FDOC.DPAR5 AS classification5,
  FDOC.DPAR6 AS classification6,
  FDOC.DPAR7 AS classification7,
  FDOC.DPAR8 AS classification8,
  FDOC.DPAR9 AS classification9,
  FDOC.DDESC1 AS discountPercentage1,
  FDOC.DDESC2 AS discountPercentage2,
  FDOC.DDESC3 AS discountPercentage3,
  FDOC.DPZAS AS pieces,
  FDOC.DBRUTO AS subtotal,
  FDOC.DDESC AS discount,
  FDOC.DFLETE AS freight,
  FDOC.DSEGURO AS insurance,
  FDOC.DOTROS AS other,
  FDOC.DOTROSTXT AS otherLabel,
  FDOC.DIEPES AS exciseTax,
  FDOC.DPORCIVA AS taxPercentage,
  FDOC.DIVA AS tax,
  FDOC.DIVARET AS withholdingTax,
  FDOC.DCANTF AS total,
  FDOC.DCANT AS balance
`;

const selectLines = `
  FAXINV.AISEQ AS id,
  FAXINV.ISEQ AS productId,
  FINV.ICOD AS productCode,
  FINV.IDESCR AS description,
  FAXINV.AICANT AS quantity,
  FAXINV.AICANTF AS invoicedQuantity,
  FINV.IUM AS unit,
  FAXINV.AIPRECIO AS price,
  FAXINV.AIPREBR AS grossPrice,
  FAXINV.AIDESCTO AS discount,
  FAXINV.AIPZAS AS pieces,
  FAXINV.AICOM AS costCenter,
  FAXINV.AISUCURSAL AS branch,
  FAXINV.LOSEQ AS lotId,
  FINV.IALTA AS inventoryCreatedAt
`;

const nullableDate = (value: string): string | null => value === '1900-12-31' ? null : value;
const numeric = (value: unknown): number => Number(value ?? 0);

const toLine = (row: LineRow): PurchaseReceptionLine => ({
  id: row.id,
  productId: row.productId,
  productCode: row.productCode ?? '',
  description: row.description ?? '',
  quantity: numeric(row.quantity),
  invoicedQuantity: numeric(row.invoicedQuantity),
  unit: row.unit ?? '',
  price: numeric(row.price),
  grossPrice: numeric(row.grossPrice),
  discount: numeric(row.discount),
  amount: numeric(row.quantity) * numeric(row.price) * (1 - numeric(row.discount) / 100),
  pieces: row.pieces ?? '',
  costCenter: numeric(row.costCenter),
  branch: numeric(row.branch),
  lotId: numeric(row.lotId),
  inventoryCreatedAt: nullableDate(row.inventoryCreatedAt),
});

const differenceInDays = (dueAt: string): number => {
  const due = Date.parse(`${dueAt}T00:00:00Z`);
  if (dueAt === '1900-12-31' || Number.isNaN(due)) return 0;
  return Math.max(0, Math.floor((Date.now() - due) / 86_400_000));
};

const toReception = (row: HeaderRow, lines: PurchaseReceptionLine[]): PurchaseReception => PurchaseReception.create({
  id: row.id,
  number: row.number,
  orderNumber: row.orderNumber,
  supplierReference: row.supplierReference,
  supplier: { id: row.supplierId, code: row.supplierCode ?? '', name: row.supplierName ?? '' },
  department: row.department,
  warehouse: row.warehouse,
  branch: numeric(row.branch),
  status: row.status,
  cancelled: row.cancelled !== 0,
  dates: {
    receivedAt: nullableDate(row.receivedAt),
    dueAt: nullableDate(row.dueAt),
    orderedAt: nullableDate(row.orderedAt),
  },
  delayDays: differenceInDays(row.dueAt),
  classifications: [
    row.classification1, row.classification2, row.classification3,
    row.classification4, row.classification5, row.classification6,
    row.classification7, row.classification8, row.classification9,
  ],
  discountPercentages: [numeric(row.discountPercentage1), numeric(row.discountPercentage2), numeric(row.discountPercentage3)],
  totals: {
    units: lines.reduce((total, line) => total + line.quantity, 0),
    pieces: numeric(row.pieces),
    subtotal: numeric(row.subtotal),
    discount: numeric(row.discount),
    freight: numeric(row.freight),
    insurance: numeric(row.insurance),
    other: numeric(row.other),
    otherLabel: row.otherLabel,
    exciseTax: numeric(row.exciseTax),
    taxPercentage: numeric(row.taxPercentage),
    tax: numeric(row.tax),
    withholdingTax: numeric(row.withholdingTax),
    total: numeric(row.total),
    balance: numeric(row.balance),
  },
  lines,
});

export class LegacyMysqlPurchaseReceptionsDataSource implements PurchaseReceptionsDataSource {
  private async lines(id: number): Promise<PurchaseReceptionLine[]> {
    const [rows] = await legacyMysqlPool.execute<LineRow[]>(
      `SELECT ${selectLines}
       FROM FAXINV
       LEFT JOIN FINV ON FAXINV.ISEQ = FINV.ISEQ
       LEFT JOIN FLOTES ON FAXINV.LOSEQ = FLOTES.LOSEQ
       WHERE FAXINV.DSEQ = ?
       ORDER BY FAXINV.AISEQ`,
      [id],
    );
    return rows.map(toLine);
  }

  private async header(where: string, parameters: Array<string | number>): Promise<PurchaseReception | null> {
    const [rows] = await legacyMysqlPool.execute<HeaderRow[]>(
      `SELECT ${selectHeader}
       FROM FDOC
       LEFT JOIN FPRV ON FDOC.PRVSEQ = FPRV.PRVSEQ
       WHERE ${documentFilter} AND ${where}
       ORDER BY FDOC.DSEQ DESC LIMIT 1`,
      parameters,
    );
    const row = rows[0];
    return row === undefined ? null : toReception(row, await this.lines(row.id));
  }

  findById(id: number): Promise<PurchaseReception | null> {
    return this.header('FDOC.DSEQ = ?', [id]);
  }

  findByNumber(number: string): Promise<PurchaseReception | null> {
    return this.header('FDOC.DNUM = ?', [number]);
  }

  async search(criteria: PurchaseReceptionSearchCriteria): Promise<PurchaseReceptionSearchResult> {
    const conditions = [documentFilter];
    const parameters: Array<string | number> = [];
    if (criteria.query !== undefined) {
      conditions.push('(UPPER(FDOC.DNUM) LIKE UPPER(?) OR UPPER(FDOC.DREFER) LIKE UPPER(?) OR UPPER(FDOC.DREFERELLOS) LIKE UPPER(?) OR UPPER(FPRV.PRVCOD) LIKE UPPER(?) OR UPPER(FPRV.PRVNOM) LIKE UPPER(?))');
      parameters.push(...Array(5).fill(`%${criteria.query}%`));
    }
    if (criteria.documentNumber !== undefined) { conditions.push('FDOC.DNUM LIKE ?'); parameters.push(`${criteria.documentNumber}%`); }
    if (criteria.receivedAt !== undefined) { conditions.push('FDOC.DFECHA = ?'); parameters.push(criteria.receivedAt); }
    if (criteria.orderNumber !== undefined) { conditions.push('FDOC.DREFER LIKE ?'); parameters.push(`${criteria.orderNumber}%`); }
    if (criteria.supplierReference !== undefined) { conditions.push('FDOC.DREFERELLOS LIKE ?'); parameters.push(`${criteria.supplierReference}%`); }
    if (criteria.deliveryNote !== undefined) { conditions.push('FDOC.DTALON LIKE ?'); parameters.push(`${criteria.deliveryNote}%`); }
    if (criteria.folio !== undefined) { conditions.push('FDOC.DFOLIO LIKE ?'); parameters.push(`${criteria.folio}%`); }
    if (criteria.supplierCode !== undefined) { conditions.push('FPRV.PRVCOD LIKE ?'); parameters.push(`${criteria.supplierCode}%`); }
    if (criteria.warehouse !== undefined) { conditions.push('FDOC.DALMACEN LIKE ?'); parameters.push(`${criteria.warehouse}%`); }
    const where = conditions.join(' AND ');
    const hasFilters = Object.keys(criteria).some((key) => !['offset', 'limit'].includes(key));
    const order = hasFilters ? 'FDOC.DNUM, FDOC.DSEQ' : 'FDOC.DSEQ DESC';
    const [rows] = await legacyMysqlPool.execute<HeaderRow[]>(
      `SELECT ${selectHeader}
       FROM FDOC LEFT JOIN FPRV ON FDOC.PRVSEQ = FPRV.PRVSEQ
       WHERE ${where}
       ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...parameters, criteria.limit, criteria.offset],
    );
    const [countRows] = await legacyMysqlPool.execute<CountRow[]>(
      `SELECT COUNT(*) AS total FROM FDOC LEFT JOIN FPRV ON FDOC.PRVSEQ = FPRV.PRVSEQ WHERE ${where}`,
      parameters,
    );
    return { items: rows.map((row) => toReception(row, [])), total: countRows[0]?.total ?? 0 };
  }

  async findAdjacent(id: number, direction: PurchaseReceptionNavigationDirection): Promise<PurchaseReception | null> {
    const [currentRows] = await legacyMysqlPool.execute<IdentityRow[]>(
      `SELECT FDOC.DSEQ AS id, FDOC.DNUM AS number FROM FDOC WHERE ${documentFilter} AND FDOC.DSEQ = ? LIMIT 1`,
      [id],
    );
    const current = currentRows[0];
    if (current === undefined) return null;
    const operator = direction === 'previous' ? '<' : '>';
    const order = direction === 'previous' ? 'DESC' : 'ASC';
    const [rows] = await legacyMysqlPool.execute<IdentityRow[]>(
      `SELECT FDOC.DSEQ AS id, FDOC.DNUM AS number
       FROM FDOC
       WHERE ${documentFilter} AND FDOC.DNUM ${operator} ?
       ORDER BY FDOC.DNUM ${order}, FDOC.DSEQ ${order} LIMIT 1`,
      [current.number],
    );
    return rows[0] === undefined ? null : this.findById(rows[0].id);
  }

  async getPanel(id: number, key: PurchaseReceptionPanelKey): Promise<PurchaseReceptionPanelResult | null> {
    const [identities] = await legacyMysqlPool.execute<IdentityRow[]>(
      `SELECT FDOC.DSEQ AS id, FDOC.DNUM AS number FROM FDOC WHERE ${documentFilter} AND FDOC.DSEQ = ? LIMIT 1`,
      [id],
    );
    const identity = identities[0];
    if (identity === undefined) return null;

    if (key === 'auxiliary') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT FAX.ASEQ AS id, FAX.AFECHA AS date, FAX.ATIPMV AS transactionType,
          FAX.AREFPAG AS reference, FAX.DSEQ AS relatedDocumentId,
          CASE WHEN FAX.ACANT >= 0 THEN FAX.ACANT ELSE 0 END AS charges,
          CASE WHEN FAX.ACANT < 0 THEN ABS(FAX.ACANT) ELSE 0 END AS payments,
          FAX.ACANT AS signedAmount, RELATED.DNUM AS relatedDocument
         FROM FAX
         LEFT JOIN FDOC AS RELATED ON FAX.DSEQ = RELATED.DSEQ
         WHERE FAX.DSEQ = ?
         ORDER BY FAX.ASEQ`,
        [id],
      );
      const total = rows.reduce((sum, row) => sum + numeric(row.signedAmount), 0);
      return {
        purchaseReception: identity, key, section: 'actions', button: 'Auxiliar', source: 'mysql',
        items: rows.map((row) => ({ ...row })), summary: { total },
      };
    }

    const reception = await this.findById(id);
    const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
      `SELECT FAG.AGT AS classifier, FAG.AGNUM AS code, FAG.AGDESCR AS description, FAG.AGTNUM AS compositeCode
       FROM FAG
       WHERE FAG.AGT BETWEEN '1' AND '9' AND FAG.AGTIPO IN (0, 2)
       ORDER BY FAG.AGT, FAG.AGSEQ`,
    );
    return {
      purchaseReception: identity, key, section: 'actions', button: 'Clasificar', source: 'mysql',
      items: rows.map((row) => ({ ...row })),
      summary: { current: reception?.toPrimitives().classifications ?? [] },
    };
  }
}
