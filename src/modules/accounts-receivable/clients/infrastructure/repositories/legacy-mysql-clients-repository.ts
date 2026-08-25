import type { RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { Client, type ClientProps } from '../../domain/entities/client.js';
import type {
  ClientSearchCriteria,
  ClientSearchResult,
  ClientsRepository,
} from '../../domain/repositories/clients-repository.js';

interface ClientRow extends RowDataPacket {
  id: number;
  code: string;
  name: string;
  deactivatedAt: string | null;
  street: string;
  exteriorNumber: string;
  interiorNumber: string;
  neighborhood: string;
  borough: string;
  city: string;
  state: string;
  postalCode: string;
  countryCode: string;
  contactName: string;
  phones: string;
  fax: string;
  email: string;
  website: string;
  taxId: string;
  curp: string;
  branch: string;
  accountingAccount: string;
  eventsMarker: string;
  priceList: number;
  discount1: number;
  discount2: number;
  discount3: number;
  paymentTermDays: number;
  creditLimit: number;
  creditExpiresAt: string | null;
  reviewDay: string;
  reviewTime: string;
  paymentDay: string;
  paymentTime: string;
  applyToClientCode: string;
  reviewStartsFromInvoice: number;
  actualPaymentTermDays: number;
  previousBalance: number;
  currentBalance: number;
  accumulatedSales: number;
  lastPurchaseAt: string | null;
  lastPaymentAt: string | null;
  lastOrderAt: string | null;
  createdAt: string | null;
}

interface CountRow extends RowDataPacket {
  total: number;
}

const selectClientFields = `
  CLISEQ AS id,
  CLICOD AS code,
  CLINOM AS name,
  NULLIF(CLIBAJA, '1900-12-31') AS deactivatedAt,
  CLIDIR AS street,
  CLINUMEXT AS exteriorNumber,
  CLINUMINT AS interiorNumber,
  CLICOLONIA AS neighborhood,
  CLIDELEGACION AS borough,
  CLICD AS city,
  CLIEDO AS state,
  CLICP AS postalCode,
  CLIPAIS AS countryCode,
  CLICONT AS contactName,
  CLITEL AS phones,
  CLIFAX AS fax,
  CLITEL3 AS email,
  CLITEL4 AS website,
  CLIRFC AS taxId,
  CLICURP AS curp,
  CLISUCURSAL AS branch,
  CLICTA AS accountingAccount,
  CLIEVENTOS AS eventsMarker,
  CLISTA AS priceList,
  CLIDESC10 AS discount1,
  CLIDESC20 AS discount2,
  CLIDESC30 AS discount3,
  CLIPLAZO0 AS paymentTermDays,
  CLICREDIT AS creditLimit,
  NULLIF(CLIVIGENCIACRED, '1900-12-31') AS creditExpiresAt,
  CLIDIREV AS reviewDay,
  CLIHORAREV AS reviewTime,
  CLIDIPAGO AS paymentDay,
  CLIHORAPAG AS paymentTime,
  CLIAPLICAR AS applyToClientCode,
  CLIPLAZOREV AS reviewStartsFromInvoice,
  CLIPLAZOR AS actualPaymentTermDays,
  CLISANT AS previousBalance,
  CLISACT AS currentBalance,
  CLIACUMULADO AS accumulatedSales,
  NULLIF(CLIULTCOM, '1900-12-31') AS lastPurchaseAt,
  NULLIF(CLIULTPAG, '1900-12-31') AS lastPaymentAt,
  NULLIF(CLIULTPED, '1900-12-31') AS lastOrderAt,
  NULLIF(CLIALTA, '1900-12-31') AS createdAt
`;

const toClient = (row: ClientRow): Client => {
  const props: ClientProps = {
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: row.deactivatedAt === null,
    deactivatedAt: row.deactivatedAt,
    address: {
      street: row.street,
      exteriorNumber: row.exteriorNumber,
      interiorNumber: row.interiorNumber,
      neighborhood: row.neighborhood,
      borough: row.borough,
      city: row.city,
      state: row.state,
      postalCode: row.postalCode,
      countryCode: row.countryCode,
    },
    contact: {
      name: row.contactName,
      phones: row.phones,
      fax: row.fax,
      email: row.email,
      website: row.website,
    },
    fiscal: {
      taxId: row.taxId,
      curp: row.curp,
      branch: row.branch,
      accountingAccount: row.accountingAccount,
    },
    indicators: {
      hasEvents: row.eventsMarker === '*',
    },
    terms: {
      priceList: row.priceList,
      discounts: [row.discount1, row.discount2, row.discount3],
      paymentTermDays: row.paymentTermDays,
      creditLimit: row.creditLimit,
      creditExpiresAt: row.creditExpiresAt,
      reviewDay: row.reviewDay,
      reviewTime: row.reviewTime,
      paymentDay: row.paymentDay,
      paymentTime: row.paymentTime,
      applyToClientCode: row.applyToClientCode,
      reviewStartsFromInvoice: row.reviewStartsFromInvoice === 1,
    },
    totals: {
      actualPaymentTermDays: row.actualPaymentTermDays,
      previousBalance: row.previousBalance,
      currentBalance: row.currentBalance,
      availableCredit: Math.max(row.creditLimit - row.currentBalance, 0),
      accumulatedSales: row.accumulatedSales,
      lastPurchaseAt: row.lastPurchaseAt,
      lastPaymentAt: row.lastPaymentAt,
      lastOrderAt: row.lastOrderAt,
    },
    createdAt: row.createdAt,
  };

  return Client.create(props);
};

const statusCondition = (status: ClientSearchCriteria['status']): string => {
  if (status === 'active') return " AND CLIBAJA = '1900-12-31'";
  if (status === 'inactive') return " AND CLIBAJA <> '1900-12-31'";
  return '';
};

export class LegacyMysqlClientsRepository implements ClientsRepository {
  async findById(clientId: number): Promise<Client | null> {
    const [rows] = await legacyMysqlPool.execute<ClientRow[]>(
      `SELECT ${selectClientFields} FROM fcli WHERE CLISEQ = ? LIMIT 1`,
      [clientId],
    );

    const row = rows[0];
    return row === undefined ? null : toClient(row);
  }

  async search(criteria: ClientSearchCriteria): Promise<ClientSearchResult> {
    const searchCondition = criteria.query === undefined
      ? ''
      : ' AND (CLICOD LIKE ? OR CLINOM LIKE ? OR CLIRFC LIKE ?)';
    const where = `1 = 1${statusCondition(criteria.status)}${searchCondition}`;
    const searchValue = criteria.query === undefined ? [] : Array(3).fill(`%${criteria.query}%`);
    const parameters = searchValue;

    const [rows] = await legacyMysqlPool.execute<ClientRow[]>(
      `SELECT ${selectClientFields} FROM fcli WHERE ${where} ORDER BY CLICOD LIMIT ? OFFSET ?`,
      [...parameters, criteria.limit, criteria.offset],
    );
    const [countRows] = await legacyMysqlPool.execute<CountRow[]>(
      `SELECT COUNT(*) AS total FROM fcli WHERE ${where}`,
      parameters,
    );

    return {
      items: rows.map(toClient),
      total: countRows[0]?.total ?? 0,
    };
  }
}
