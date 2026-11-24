import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { PurchaseReceptionsDataSource } from '../../domain/datasources/purchase-receptions-data-source.js';
import type { PurchaseReceptionClassifier } from '../../domain/datasources/purchase-reception-classifications-data-source.js';
import { PurchaseReception, type PurchaseReceptionLine } from '../../domain/entities/purchase-reception.js';
import type {
  PurchaseReceptionNavigationDirection,
  PurchaseReceptionPanelKey,
  PurchaseReceptionPanelResult,
  PurchaseReceptionSearchCriteria,
  PurchaseReceptionSearchResult,
} from '../../domain/repositories/purchase-receptions-repository.js';
import { readNativePurchaseReceptionPieces } from './mysql-purchase-reception-piece-native-source.js';
import { legacyReceiptSupplierSearch } from './legacy-receipt-supplier-search.js';
import type { ReceiptSupplierChange } from './purchase-reception-supplier-change-reads.js';

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
interface CustomsRow extends RowDataPacket {
  number: string; date: string; customsOffice: string; incrementables: number;
}
interface ImportPayableRow extends RowDataPacket {
  id: number; number: string; supplierCode: string | null; supplierName: string | null;
  currencyId: number; charge: number; balance: number; paid: number | null; policyNumber: string | null;
}

const documentFilter = '(FDOC.DESFACT IN (2, 3) OR FDOC.DESCXC = 2) AND FDOC.DEST = 0 AND FDOC.DMULTICIA = 1';
const customsReception = `receipt.DSEQ = ? AND receipt.DMULTICIA = 1 AND receipt.DEST = 0 AND receipt.DESFACT = 2
  AND receipt.DITIPMV = 'RA' AND receipt.DOTROSTXT <> 'IMPORT'`;

function uniqueCustomsReceiptNumber(companyOnly: boolean) {
  return `NOT EXISTS (
    SELECT 1 FROM FDOC other WHERE other.DNUM = receipt.DNUM AND other.DSEQ <> receipt.DSEQ
      AND other.DEST = 0 AND other.DESFACT = 2 AND other.DITIPMV = 'RA' AND other.DOTROSTXT <> 'IMPORT'
      ${companyOnly ? 'AND other.DMULTICIA = receipt.DMULTICIA' : ''}
  )`;
}

const selectHeader = (supplier = legacyReceiptSupplierSearch([])) => `
  FDOC.DSEQ AS id,
  FDOC.DNUM AS number,
  FDOC.DREFER AS orderNumber,
  FDOC.DREFERELLOS AS supplierReference,
  ${supplier.id} AS supplierId,
  ${supplier.code} AS supplierCode,
  ${supplier.name} AS supplierName,
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
      `SELECT ${selectHeader()}
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

  async search(criteria: PurchaseReceptionSearchCriteria, supplierChanges: ReceiptSupplierChange[] = []): Promise<PurchaseReceptionSearchResult> {
    const supplier = legacyReceiptSupplierSearch(supplierChanges);
    const conditions = [documentFilter];
    const parameters: Array<string | number> = [...supplier.values];
    if (criteria.query !== undefined) {
      conditions.push(`(UPPER(FDOC.DNUM) LIKE UPPER(?) OR UPPER(FDOC.DREFER) LIKE UPPER(?) OR UPPER(FDOC.DREFERELLOS) LIKE UPPER(?) OR UPPER(${supplier.code}) LIKE UPPER(?) OR UPPER(${supplier.name}) LIKE UPPER(?))`);
      parameters.push(...Array(5).fill(`%${criteria.query}%`));
    }
    if (criteria.documentNumber !== undefined) { conditions.push('FDOC.DNUM LIKE ?'); parameters.push(`${criteria.documentNumber}%`); }
    if (criteria.receivedAt !== undefined) { conditions.push('FDOC.DFECHA = ?'); parameters.push(criteria.receivedAt); }
    if (criteria.orderNumber !== undefined) { conditions.push('FDOC.DREFER LIKE ?'); parameters.push(`${criteria.orderNumber}%`); }
    if (criteria.supplierReference !== undefined) { conditions.push('FDOC.DREFERELLOS LIKE ?'); parameters.push(`${criteria.supplierReference}%`); }
    if (criteria.deliveryNote !== undefined) { conditions.push('FDOC.DTALON LIKE ?'); parameters.push(`${criteria.deliveryNote}%`); }
    if (criteria.folio !== undefined) { conditions.push('FDOC.DFOLIO LIKE ?'); parameters.push(`${criteria.folio}%`); }
    if (criteria.supplierCode !== undefined) { conditions.push(`${supplier.code} LIKE ?`); parameters.push(`${criteria.supplierCode}%`); }
    if (criteria.warehouse !== undefined) { conditions.push('FDOC.DALMACEN LIKE ?'); parameters.push(`${criteria.warehouse}%`); }
    const where = conditions.join(' AND ');
    const hasFilters = Object.keys(criteria).some((key) => !['offset', 'limit'].includes(key));
    const order = hasFilters ? 'FDOC.DNUM, FDOC.DSEQ' : 'FDOC.DSEQ DESC';
    const from = `FROM FDOC LEFT JOIN FPRV ON FDOC.PRVSEQ = FPRV.PRVSEQ ${supplier.join}`;
    const [rows] = await legacyMysqlPool.execute<HeaderRow[]>(
      `SELECT ${selectHeader(supplier)} ${from}
       WHERE ${where}
       ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...parameters, criteria.limit, criteria.offset],
    );
    const [countRows] = await legacyMysqlPool.execute<CountRow[]>(
      `SELECT COUNT(*) AS total ${from} WHERE ${where}`,
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
    return this.findAdjacentByNumber(current.number, direction);
  }

  async findAdjacentByNumber(number: string, direction: PurchaseReceptionNavigationDirection): Promise<PurchaseReception | null> {
    const operator = direction === 'previous' ? '<' : '>';
    const order = direction === 'previous' ? 'DESC' : 'ASC';
    const [rows] = await legacyMysqlPool.execute<IdentityRow[]>(
      `SELECT FDOC.DSEQ AS id, FDOC.DNUM AS number
       FROM FDOC
       WHERE ${documentFilter} AND FDOC.DNUM ${operator} ?
       ORDER BY FDOC.DNUM ${order}, FDOC.DSEQ ${order} LIMIT 1`,
      [number],
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
    if (key === 'pedimento') return this.customsPanel(identity);
    if (key === 'pieces') return this.piecesPanel(identity);

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
    return this.classificationPanel(identity, reception?.toPrimitives().classifications ?? [], 'mysql');
  }

  private async piecesPanel(identity: IdentityRow): Promise<PurchaseReceptionPanelResult> {
    const rows = await readNativePurchaseReceptionPieces({ id: identity.id });
    return {
      purchaseReception: identity, key: 'pieces', section: 'actions', button: 'Piezas', source: 'mysql',
      items: rows.map((row) => ({ ...row })),
    };
  }

  private async customsPanel(identity: IdentityRow): Promise<PurchaseReceptionPanelResult> {
    const [[[customs]], [payables]] = await Promise.all([
      // Derivada de MRECEP/65. FPEDIMENTO vincula el folio y carece de compañía.
      legacyMysqlPool.execute<CustomsRow[]>(
        `SELECT p.PMTNUM AS number, p.PMTFECHA AS date, p.PMTADUANA AS customsOffice, p.PMTINCREMENTABLES AS incrementables
         FROM FDOC receipt JOIN FPEDIMENTO p ON p.PMTODOC = receipt.DNUM
         WHERE ${customsReception} AND ${uniqueCustomsReceiptNumber(false)}
         ORDER BY p.PMTOSEQ DESC LIMIT 1`, [identity.id],
      ),
      // Derivada de MRECEP/105 y de los pasivos IMPORT relacionados por DREFER.
      legacyMysqlPool.execute<ImportPayableRow[]>(
        `SELECT expense.DSEQ AS id, expense.DNUM AS number, supplier.PRVCOD AS supplierCode, supplier.PRVNOM AS supplierName,
           expense.DMONEDA AS currencyId, expense.DCANT AS balance,
           COALESCE(SUM(CASE WHEN ledger.ATIPMV = expense.DITIPMV THEN ledger.ACANT END), expense.DCANTF) AS charge,
           -SUM(CASE WHEN ledger.ATIPMV = 'PP' THEN ledger.ACANT END) AS paid,
           CASE WHEN COUNT(DISTINCT CASE WHEN ledger.ATIPMV = expense.DITIPMV THEN NULLIF(TRIM(ledger.APOLIZA), '') END) = 1
             THEN MAX(CASE WHEN ledger.ATIPMV = expense.DITIPMV THEN NULLIF(TRIM(ledger.APOLIZA), '') END) END AS policyNumber
         FROM FDOC receipt
         JOIN FDOC expense ON expense.DREFER = receipt.DNUM AND expense.DMULTICIA = receipt.DMULTICIA
           AND expense.DEST = 0 AND expense.DOTROSTXT = 'IMPORT'
         LEFT JOIN FPRV supplier ON supplier.PRVSEQ = expense.PRVSEQ
         LEFT JOIN FAX ledger ON ledger.DSEQ = expense.DSEQ AND ledger.ATIPMV IN (expense.DITIPMV, 'PP')
         WHERE ${customsReception} AND ${uniqueCustomsReceiptNumber(true)}
         GROUP BY expense.DSEQ, expense.DNUM, expense.DMONEDA, supplier.PRVCOD, supplier.PRVNOM, expense.DCANTF, expense.DCANT
         ORDER BY expense.DSEQ`, [identity.id],
      ),
    ]);
    const summary = customs ? {
      number: (customs.number ?? '').trim(),
      date: nullableDate(customs.date),
      customsOffice: (customs.customsOffice ?? '').trim(),
      incrementables: numeric(customs.incrementables),
    } : undefined;
    return {
      purchaseReception: identity, key: 'pedimento', section: 'actions', button: 'Pedimento', source: 'mysql',
      items: payables.map(({ id, number, supplierCode, supplierName, currencyId, charge, balance, paid, policyNumber }) => ({
        id, number, supplierCode: supplierCode ?? '', supplierName: supplierName ?? '', currencyId: numeric(currencyId),
        charge: numeric(charge), balance: numeric(balance),
        ...(paid === null ? {} : { paid: numeric(paid) }),
        ...(policyNumber ? { policyNumber } : {}),
      })),
      ...(summary && (summary.number || summary.date || summary.customsOffice || summary.incrementables) ? { summary } : {}),
    };
  }

  async classificationPanel(identity: { id: number; number: string }, current: string[], source: PurchaseReceptionPanelResult['source']): Promise<PurchaseReceptionPanelResult> {
    const { items, labels } = await this.classificationCatalog();
    return {
      purchaseReception: identity, key: 'classifications', section: 'actions', button: 'Clasificar', source,
      items, summary: { current, labels },
    };
  }

  async classificationCatalog() {
    // Derivadas de ERECEP#19/0 y /240 y de la selección MEMTIPOPAR=2 en MBASE/91.
    const positions = Array.from({ length: 9 }, (_, index) => index + 1);
    const [[items], [[titles]]] = await Promise.all([
      legacyMysqlPool.execute<(RowDataPacket & PurchaseReceptionClassifier)[]>(
        `SELECT CAST(AGT AS UNSIGNED) AS classifier, AGNUM AS code, AGDESCR AS description, AGTNUM AS compositeCode
         FROM FAG WHERE AGT IN ('1','2','3','4','5','6','7','8','9') AND AGTIPO IN (0,2)
         ORDER BY AGT,AGNUM,AGSEQ`,
      ),
      legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT ${positions.map((position) => `CIAPAR${position} AS label${position}`).join(',')},
           (SELECT YGDAT FROM FYG WHERE YGKEY='ABITITPAR2' LIMIT 1) AS configuredLabels
         FROM FCIA WHERE CIASEQ=1`,
      ),
    ]);
    const configuredLabels = typeof titles?.configuredLabels === 'string' ? titles.configuredLabels.split(',') : null;
    return {
      items: items.map(({ classifier, code, description, compositeCode }) => ({ classifier, code, description, compositeCode })),
      labels: positions.map((position) => configuredLabels
        ? configuredLabels[position - 1] ?? ''
        : String(titles?.[`label${position}`] ?? '')),
    };
  }
}
