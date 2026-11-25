import type { RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { customerSql } from '../../../../../shared/infrastructure/http/customer-scope.js';
import type { InvoicesDataSource } from '../../domain/datasources/invoices-data-source.js';
import { Invoice, type InvoiceLine } from '../../domain/entities/invoice.js';
import type {
  InvoiceNavigationDirection,
  InvoiceSearchCriteria,
  InvoiceSearchResult,
} from '../../domain/repositories/invoices-repository.js';

interface HeaderRow extends RowDataPacket {
  id: number;
  number: string;
  orderNumber: string;
  customerOrderNumber: string;
  customerId: number;
  customerCode: string | null;
  customerName: string | null;
  billedCustomerName: string;
  movementType: string;
  companyId: number;
  documentState: number;
  status: string;
  canceled: number;
  issuedAt: string;
  dueAt: string;
  paidAt: string;
  deliveryNoteAt: string;
  delayDays: number;
  attention: string;
  attentionCode: string;
  branch: number;
  department: string;
  route: number;
  pieces: number;
  warehouse: string;
  currencyId: number;
  currencyName: string;
  exchangeRate: number;
  initial: number;
  cfdStatus: string;
  folio: string;
  deliveryNote: string;
  warehouseSeal: string;
  discountPercentage1: number;
  discountPercentage2: number;
  discountPercentage3: number;
  subtotal: number;
  discount: number;
  freight: number;
  insurance: number;
  other: number;
  exciseTax: number;
  tax: number;
  total: number;
  paid: number;
}

interface LineRow extends RowDataPacket, InvoiceLine {}
interface CountRow extends RowDataPacket { total: number }
interface IdNumberRow extends RowDataPacket { id: number; number: string }

const eligibility = 'DEST = 0 AND DMULTICIA = 1 AND (DESFACT = 1 OR DESCXC = 1)';

const selectHeader = `
  FDOC.DSEQ AS id,
  DNUM AS number,
  DREFER AS orderNumber,
  DREFERELLOS AS customerOrderNumber,
  FDOC.CLISEQ AS customerId,
  FCLI.CLICOD AS customerCode,
  FCLI.CLINOM AS customerName,
  DCLINOM AS billedCustomerName,
  DITIPMV AS movementType,
  FDOC.DMULTICIA AS companyId,
  FDOC.DEST AS documentState,
  DSTATUS AS status,
  DCANCELADA AS canceled,
  DFECHA AS issuedAt,
  DVENCE AS dueAt,
  DFECHAPAGO AS paidAt,
  DFECHATALON AS deliveryNoteAt,
  DATEDIFF(DFECHA, DVENCE) AS delayDays,
  COALESCE((SELECT AGDESCR FROM FAG WHERE AGTNUM = DPAR1 LIMIT 1), DPAR1) AS attention,
  DPAR1 AS attentionCode,
  DSUCURSAL AS branch,
  DDEPTO AS department,
  DRUTA AS route,
  DPZAS AS pieces,
  DALMACEN AS warehouse,
  DMONEDA AS currencyId,
  CASE DMONEDA WHEN 0 THEN 'PESOS' WHEN 1 THEN 'DOLARES' ELSE CONCAT('MONEDA ', DMONEDA) END AS currencyName,
  DTIPOC AS exchangeRate,
  DINICIAL AS initial,
  DSTATUSCFD AS cfdStatus,
  DFOLIO AS folio,
  DTALON AS deliveryNote,
  DCDNUM AS warehouseSeal,
  DDESC1 AS discountPercentage1,
  DDESC2 AS discountPercentage2,
  DDESC3 AS discountPercentage3,
  DBRUTO AS subtotal,
  DDESC AS discount,
  DFLETE AS freight,
  DSEGURO AS insurance,
  DOTROS AS other,
  DIEPES AS exciseTax,
  DIVA AS tax,
  DCANT AS total,
  (DPAGO1 + DPAGO2 + DPAGO3 + DPAGO4 + DPAGO5 + DPAGO6 + DPAGO7 + DPAGO8 + DPAGO9 + DPAGO10 + DPAGO11) AS paid
`;

const selectLines = `
  FAXINV.AISEQ AS id,
  FAXINV.ISEQ AS productId,
  FINV.ICOD AS productCode,
  FINV.IDESCR AS description,
  AICANT AS quantity,
  AICANTF AS fulfilledQuantity,
  AIUNIDAD AS unit,
  AIPRECIO AS price,
  AIPREBR AS grossPrice,
  AIDESCTO AS discount,
  (AICANTF * AIPRECIO) AS amount,
  AISUCURSAL AS branch,
  AIAGENTE AS agent,
  AIPZAS AS pieces,
  AIPAGINA AS page,
  AIFACTOR AS factor,
  AICOSTO AS cost,
  FINV.IEMPAQUE AS package,
  AISKU AS sku,
  FINV.IFAM6 AS family
`;

const nullableDate = (value: string): string | null => value === '1900-12-31' ? null : value;

const historicalRemission = (row: HeaderRow) => row.companyId === 1 && row.documentState === 0
  && row.movementType === 'FA' && /^FA\d/.test(row.number);

const toInvoice = (row: HeaderRow, lines: InvoiceLine[]): Invoice => Invoice.create({
  id: row.id,
  number: row.number,
  orderNumber: row.orderNumber,
  customerOrderNumber: row.customerOrderNumber,
  customer: {
    id: row.customerId,
    code: row.customerCode ?? '',
    name: row.customerName ?? '',
    billedName: row.billedCustomerName,
  },
  movementType: row.movementType,
  status: row.status,
  canceled: row.canceled === 1,
  ...(historicalRemission(row) ? { cancellationAvailable: true } : {}),
  dates: {
    issuedAt: nullableDate(row.issuedAt),
    dueAt: nullableDate(row.dueAt),
    paidAt: nullableDate(row.paidAt),
    deliveryNoteAt: nullableDate(row.deliveryNoteAt),
  },
  delayDays: row.delayDays,
  attention: row.attention,
  attentionCode: row.attentionCode,
  branch: row.branch,
  department: row.department,
  route: row.route,
  pieces: row.pieces,
  warehouse: row.warehouse,
  currency: {
    id: row.currencyId, exchangeRate: row.exchangeRate,
    name: historicalRemission(row) && row.currencyId === 1 ? 'PESOS' : row.currencyName,
  },
  initial: row.initial === 1,
  cfdStatus: row.cfdStatus,
  folio: row.folio,
  deliveryNote: row.deliveryNote,
  warehouseSeal: row.warehouseSeal,
  discountPercentages: [row.discountPercentage1, row.discountPercentage2, row.discountPercentage3],
  totals: {
    quantity: lines.reduce((sum, line) => sum + line.quantity, 0),
    fulfilledQuantity: lines.reduce((sum, line) => sum + line.fulfilledQuantity, 0),
    subtotal: row.subtotal,
    discount: row.discount,
    freight: row.freight,
    insurance: row.insurance,
    other: row.other,
    exciseTax: row.exciseTax,
    tax: row.tax,
    total: row.total,
    paid: row.paid,
    balance: row.total - row.paid,
  },
  lines,
});

export class LegacyMysqlInvoicesDataSource implements InvoicesDataSource {
  private async lines(invoiceId: number): Promise<InvoiceLine[]> {
    const [rows] = await legacyMysqlPool.execute<LineRow[]>(
      `SELECT ${selectLines}
         FROM FAXINV
         LEFT JOIN FINV ON FAXINV.ISEQ = FINV.ISEQ
        WHERE FAXINV.DSEQ = ?
        ORDER BY FAXINV.AISEQ`,
      [invoiceId],
    );
    return rows.map((row) => ({ ...row }));
  }

  private async headerById(invoiceId: number): Promise<HeaderRow | undefined> {
    const scope = customerSql('FDOC.CLISEQ');
    const [rows] = await legacyMysqlPool.execute<HeaderRow[]>(
      `SELECT ${selectHeader}
         FROM FDOC
         LEFT JOIN FCLI ON FDOC.CLISEQ = FCLI.CLISEQ
        WHERE FDOC.DSEQ = ?${scope.condition}
        LIMIT 1`,
      [invoiceId, ...scope.values],
    );
    return rows[0];
  }

  async findById(invoiceId: number): Promise<Invoice | null> {
    const row = await this.headerById(invoiceId);
    return row === undefined ? null : toInvoice(row, await this.lines(invoiceId));
  }

  async findByNumber(invoiceNumber: string): Promise<Invoice | null> {
    const scope = customerSql('FDOC.CLISEQ');
    const [rows] = await legacyMysqlPool.execute<HeaderRow[]>(
      `SELECT ${selectHeader}
         FROM FDOC
         LEFT JOIN FCLI ON FDOC.CLISEQ = FCLI.CLISEQ
        WHERE DNUM = ? AND ${eligibility}${scope.condition}
        ORDER BY FDOC.DSEQ DESC
        LIMIT 1`,
      [invoiceNumber, ...scope.values],
    );
    const row = rows[0];
    return row === undefined ? null : toInvoice(row, await this.lines(row.id));
  }

  async findFirst(): Promise<Invoice | null> {
    const scope = customerSql('FDOC.CLISEQ');
    const [rows] = await legacyMysqlPool.execute<IdNumberRow[]>(
      `SELECT DSEQ AS id, DNUM AS number
         FROM FDOC
        WHERE ${eligibility}${scope.condition}
        ORDER BY DNUM, DSEQ
        LIMIT 1`, scope.values,
    );
    return rows[0] === undefined ? null : this.findById(rows[0].id);
  }

  async findNumberById(invoiceId: number): Promise<string | null> {
    const scope = customerSql('FDOC.CLISEQ');
    const [currentRows] = await legacyMysqlPool.execute<IdNumberRow[]>(
      `SELECT DSEQ AS id, DNUM AS number FROM FDOC WHERE DSEQ = ?${scope.condition} LIMIT 1`,
      [invoiceId, ...scope.values],
    );
    return currentRows[0]?.number ?? null;
  }

  async findAdjacent(invoiceId: number, direction: InvoiceNavigationDirection): Promise<Invoice | null> {
    const number = await this.findNumberById(invoiceId);
    return number === null ? null : this.findAdjacentByNumber(number, direction);
  }

  async findAdjacentByNumber(number: string, direction: InvoiceNavigationDirection): Promise<Invoice | null> {
    const scope = customerSql('FDOC.CLISEQ');
    const operator = direction === 'previous' ? '<' : '>';
    const order = direction === 'previous' ? 'DESC' : 'ASC';
    const [rows] = await legacyMysqlPool.execute<IdNumberRow[]>(
      `SELECT DSEQ AS id, DNUM AS number
         FROM FDOC
        WHERE ${eligibility} AND DNUM ${operator} ?${scope.condition}
        ORDER BY DNUM ${order}, DSEQ ${order}
        LIMIT 1`,
      [number, ...scope.values],
    );
    return rows[0] === undefined ? null : this.findById(rows[0].id);
  }

  async search(criteria: InvoiceSearchCriteria): Promise<InvoiceSearchResult> {
    const conditions = [eligibility];
    const parameters: Array<string | number> = [];
    if (criteria.query !== undefined) {
      conditions.push(`(UPPER(DNUM) LIKE UPPER(?) OR UPPER(DREFER) LIKE UPPER(?)
        OR UPPER(DREFERELLOS) LIKE UPPER(?) OR UPPER(CLICOD) LIKE UPPER(?)
        OR UPPER(CLINOM) LIKE UPPER(?))`);
      parameters.push(...Array(5).fill(`%${criteria.query}%`));
    }
    if (criteria.issuedAt !== undefined) { conditions.push('DFECHA = ?'); parameters.push(criteria.issuedAt); }
    if (criteria.invoiceNumber !== undefined) { conditions.push('DNUM LIKE ?'); parameters.push(`${criteria.invoiceNumber}%`); }
    if (criteria.orderNumber !== undefined) { conditions.push('DREFER LIKE ?'); parameters.push(`${criteria.orderNumber}%`); }
    if (criteria.customerOrderNumber !== undefined) { conditions.push('DREFERELLOS LIKE ?'); parameters.push(`${criteria.customerOrderNumber}%`); }
    if (criteria.deliveryNote !== undefined) { conditions.push('DTALON LIKE ?'); parameters.push(`${criteria.deliveryNote}%`); }
    if (criteria.folio !== undefined) { conditions.push('DFOLIO LIKE ?'); parameters.push(`${criteria.folio}%`); }
    if (criteria.customerCode !== undefined) { conditions.push('CLICOD LIKE ?'); parameters.push(`${criteria.customerCode}%`); }
    if (criteria.warehouseSeal !== undefined) { conditions.push('DCDNUM LIKE ?'); parameters.push(`${criteria.warehouseSeal}%`); }
    if (criteria.amount !== undefined) { conditions.push('DCANT = ?'); parameters.push(criteria.amount); }
    const scope = customerSql('FDOC.CLISEQ');
    const where = conditions.join(' AND ') + scope.condition;
    parameters.push(...scope.values);
    const [rows] = await legacyMysqlPool.execute<HeaderRow[]>(
      `SELECT ${selectHeader}
         FROM FDOC
         LEFT JOIN FCLI ON FDOC.CLISEQ = FCLI.CLISEQ
        WHERE ${where}
        ORDER BY DNUM, FDOC.DSEQ
        LIMIT ? OFFSET ?`,
      [...parameters, criteria.limit, criteria.offset],
    );
    const [countRows] = await legacyMysqlPool.execute<CountRow[]>(
      `SELECT COUNT(*) AS total
         FROM FDOC
         LEFT JOIN FCLI ON FDOC.CLISEQ = FCLI.CLISEQ
        WHERE ${where}`,
      parameters,
    );
    return { items: rows.map((row) => toInvoice(row, [])), total: countRows[0]?.total ?? 0 };
  }
}
