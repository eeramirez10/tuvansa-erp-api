import type { RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { SuppliersDataSource } from '../../domain/datasources/suppliers-data-source.js';
import { Supplier } from '../../domain/entities/supplier.js';
import type {
  SupplierNavigationDirection,
  SupplierSearchCriteria,
  SupplierSearchResult,
} from '../../domain/repositories/suppliers-repository.js';

interface SupplierRow extends RowDataPacket {
  id: number;
  code: string;
  name: string;
  street: string;
  neighborhood: string;
  city: string;
  state: string;
  postalCode: string;
  contactName: string;
  phone: string;
  phone2: string;
  fax: string;
  email: string;
  taxId: string;
  curp: string;
  accountingAccount: string;
  priceList: number;
  discount1: number;
  discount2: number;
  paymentTermDays: number;
  applyToSupplierCode: string;
  creditLimit: number;
  currencyId: number;
  type: number;
  actualPaymentTermDays: number;
  previousBalance: number;
  currentBalance: number;
  accumulatedPurchases: number;
  lastPurchaseAt: string | null;
  lastPaymentAt: string | null;
  deactivatedAt: string | null;
  eventsMarker: string;
  notes: string;
  createdAt: string | null;
}

interface CountRow extends RowDataPacket { total: number }
interface IdCodeRow extends RowDataPacket { id: number; code: string }

const selectSupplierFields = `
  FPRV.PRVSEQ AS id,
  PRVCOD AS code,
  PRVNOM AS name,
  PRVDIR AS street,
  PRVCOLONIA AS neighborhood,
  PRVCD AS city,
  PRVEDO AS state,
  PRVCP AS postalCode,
  PRVCONT AS contactName,
  PRVTEL AS phone,
  PRVTEL2 AS phone2,
  PRVFAX AS fax,
  PRVEMAIL AS email,
  PRVRFC AS taxId,
  PRVCURP AS curp,
  PRVCTA AS accountingAccount,
  PRVLISTA AS priceList,
  PRVDESC1 AS discount1,
  PRVDESC2 AS discount2,
  PRVPLAZO AS paymentTermDays,
  PRVAPLICAR AS applyToSupplierCode,
  PRVCREDIT AS creditLimit,
  PRVMONEDA AS currencyId,
  PRVTIPO AS type,
  PRVPLAZOR AS actualPaymentTermDays,
  PRVSANT AS previousBalance,
  PRVSACT AS currentBalance,
  PRVACUMULADO AS accumulatedPurchases,
  NULLIF(PRVULTCOM, '1900-12-31') AS lastPurchaseAt,
  NULLIF(PRVULTPAG, '1900-12-31') AS lastPaymentAt,
  NULLIF(PRVBAJA, '1900-12-31') AS deactivatedAt,
  PRVEVENTOS AS eventsMarker,
  PRVOBS AS notes,
  NULLIF(PRVALTA, '1900-12-31') AS createdAt
`;

const toSupplier = (row: SupplierRow): Supplier => Supplier.create({
  id: row.id,
  code: row.code,
  name: row.name,
  isActive: row.deactivatedAt === null,
  deactivatedAt: row.deactivatedAt,
  address: {
    street: row.street,
    neighborhood: row.neighborhood,
    city: row.city,
    state: row.state,
    postalCode: row.postalCode,
  },
  contact: {
    name: row.contactName,
    phone: row.phone,
    phone2: row.phone2,
    fax: row.fax,
    email: row.email,
  },
  fiscal: {
    taxId: row.taxId,
    curp: row.curp,
    accountingAccount: row.accountingAccount,
  },
  terms: {
    priceList: row.priceList,
    discounts: [row.discount1, row.discount2],
    paymentTermDays: row.paymentTermDays,
    applyToSupplierCode: row.applyToSupplierCode,
    creditLimit: row.creditLimit,
    currencyId: row.currencyId,
    type: row.type,
  },
  totals: {
    actualPaymentTermDays: row.actualPaymentTermDays,
    previousBalance: row.previousBalance,
    currentBalance: row.currentBalance,
    accumulatedPurchases: row.accumulatedPurchases,
    lastPurchaseAt: row.lastPurchaseAt,
    lastPaymentAt: row.lastPaymentAt,
  },
  indicators: { hasEvents: row.eventsMarker === '*' },
  notes: row.notes,
  createdAt: row.createdAt,
});

const statusCondition = (status: SupplierSearchCriteria['status']): string => {
  if (status === 'active') return " AND PRVBAJA = '1900-12-31'";
  if (status === 'inactive') return " AND PRVBAJA <> '1900-12-31'";
  return '';
};

export class LegacyMysqlSuppliersDataSource implements SuppliersDataSource {
  async findById(supplierId: number): Promise<Supplier | null> {
    const [rows] = await legacyMysqlPool.execute<SupplierRow[]>(
      `SELECT ${selectSupplierFields} FROM FPRV WHERE PRVSEQ = ? LIMIT 1`, [supplierId],
    );
    return rows[0] === undefined ? null : toSupplier(rows[0]);
  }

  async findFirst(): Promise<Supplier | null> {
    const [rows] = await legacyMysqlPool.execute<SupplierRow[]>(
      `SELECT ${selectSupplierFields} FROM FPRV ORDER BY PRVCOD, FPRV.PRVSEQ LIMIT 1`,
    );
    return rows[0] === undefined ? null : toSupplier(rows[0]);
  }

  async findAdjacent(supplierId: number, direction: SupplierNavigationDirection): Promise<Supplier | null> {
    const [currentRows] = await legacyMysqlPool.execute<IdCodeRow[]>(
      'SELECT PRVSEQ AS id, PRVCOD AS code FROM FPRV WHERE PRVSEQ = ? LIMIT 1', [supplierId],
    );
    const current = currentRows[0];
    if (current === undefined) return null;
    const operator = direction === 'previous' ? '<' : '>';
    const order = direction === 'previous' ? 'DESC' : 'ASC';
    const [rows] = await legacyMysqlPool.execute<SupplierRow[]>(
      `SELECT ${selectSupplierFields}
         FROM FPRV
        WHERE PRVCOD ${operator} ? OR (PRVCOD = ? AND PRVSEQ ${operator} ?)
        ORDER BY PRVCOD ${order}, FPRV.PRVSEQ ${order}
        LIMIT 1`,
      [current.code, current.code, current.id],
    );
    return rows[0] === undefined ? null : toSupplier(rows[0]);
  }

  async search(criteria: SupplierSearchCriteria): Promise<SupplierSearchResult> {
    const searchCondition = criteria.query === undefined
      ? ''
      : ' AND (PRVCOD LIKE ? OR PRVNOM LIKE ? OR PRVRFC LIKE ?)';
    const where = `1 = 1${statusCondition(criteria.status)}${searchCondition}`;
    const parameters = criteria.query === undefined ? [] : Array(3).fill(`%${criteria.query}%`);
    const [rows] = await legacyMysqlPool.execute<SupplierRow[]>(
      `SELECT ${selectSupplierFields} FROM FPRV WHERE ${where}
       ORDER BY PRVCOD, FPRV.PRVSEQ LIMIT ? OFFSET ?`,
      [...parameters, criteria.limit, criteria.offset],
    );
    const [counts] = await legacyMysqlPool.execute<CountRow[]>(
      `SELECT COUNT(*) AS total FROM FPRV WHERE ${where}`, parameters,
    );
    return { items: rows.map(toSupplier), total: counts[0]?.total ?? 0 };
  }
}
