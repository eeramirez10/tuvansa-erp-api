import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { Client, type ClientProps } from '../../domain/entities/client.js';
import type { ClientsDataSource } from '../../domain/datasources/clients-data-source.js';
import type {
  ClientSearchCriteria,
  ClientSearchResult,
} from '../../domain/repositories/clients-repository.js';
import type {
  ClientCreateValues,
  ClientNavigationDirection,
  ClientWriteValues,
  DeleteClientResult,
} from '../../domain/repositories/client-toolbar-repository.js';

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

interface IdCodeRow extends RowDataPacket {
  id: number;
  code: string;
}

interface ExistsRow extends RowDataPacket {
  found: number;
}

const selectClientFields = `
  CLISEQ AS id,
  CLICOD AS code,
  CLINOM AS name,
  CAST(NULLIF(CLIBAJA, '1900-12-31') AS DATE) AS deactivatedAt,
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
  CAST(NULLIF(CLIVIGENCIACRED, '1900-12-31') AS DATE) AS creditExpiresAt,
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
  CAST(NULLIF(CLIULTCOM, '1900-12-31') AS DATE) AS lastPurchaseAt,
  CAST(NULLIF(CLIULTPAG, '1900-12-31') AS DATE) AS lastPaymentAt,
  CAST(NULLIF(CLIULTPED, '1900-12-31') AS DATE) AS lastOrderAt,
  CAST(NULLIF(CLIALTA, '1900-12-31') AS DATE) AS createdAt
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

const columnByField: Record<keyof ClientWriteValues, string> = {
  code: 'CLICOD',
  name: 'CLINOM',
  street: 'CLIDIR',
  exteriorNumber: 'CLINUMEXT',
  interiorNumber: 'CLINUMINT',
  neighborhood: 'CLICOLONIA',
  borough: 'CLIDELEGACION',
  city: 'CLICD',
  state: 'CLIEDO',
  postalCode: 'CLICP',
  countryCode: 'CLIPAIS',
  contactName: 'CLICONT',
  phones: 'CLITEL',
  fax: 'CLIFAX',
  email: 'CLITEL3',
  website: 'CLITEL4',
  taxId: 'CLIRFC',
  curp: 'CLICURP',
  branch: 'CLISUCURSAL',
  accountingAccount: 'CLICTA',
  priceList: 'CLISTA',
  discount1: 'CLIDESC10',
  discount2: 'CLIDESC20',
  discount3: 'CLIDESC30',
  paymentTermDays: 'CLIPLAZO0',
  creditLimit: 'CLICREDIT',
  creditExpiresAt: 'CLIVIGENCIACRED',
  reviewDay: 'CLIDIREV',
  reviewTime: 'CLIHORAREV',
  paymentDay: 'CLIDIPAGO',
  paymentTime: 'CLIHORAPAG',
  applyToClientCode: 'CLIAPLICAR',
  reviewStartsFromInvoice: 'CLIPLAZOREV',
};

type SqlValue = string | number | null;

const storedValue = (
  field: keyof ClientWriteValues,
  value: string | number | boolean | null,
): SqlValue => {
  if (field === 'creditExpiresAt') return typeof value === 'string' ? value : '1900-12-31';
  if (field === 'reviewStartsFromInvoice') return value === true ? 1 : 0;
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
};

const writeEntries = (
  values: ClientWriteValues,
): Array<[keyof ClientWriteValues, string | number | boolean | null]> =>
  (Object.entries(values) as Array<[
    keyof ClientWriteValues,
    string | number | boolean | null | undefined,
  ]>)
    .filter((entry): entry is [
      keyof ClientWriteValues,
      string | number | boolean | null,
    ] => entry[1] !== undefined);

const dependencyTables = [
  'fdoc',
  'fax',
  'faxinv',
  'fpenc',
  'fplin',
  'fvanu2',
  'fcenso',
] as const;

const excludeIds = (ids: number[]) => ids.length ? ` AND FCLI.CLISEQ NOT IN (${ids.map(() => '?').join(',')})` : '';

export class LegacyMysqlClientsDataSource implements ClientsDataSource {
  async findByIds(ids: number[]): Promise<Map<number, Client>> {
    if (!ids.length) return new Map();
    const [rows] = await legacyMysqlPool.execute<ClientRow[]>(`SELECT ${selectClientFields} FROM fcli
       WHERE CLISEQ IN (${ids.map(() => '?').join(',')})`, ids);
    return new Map(rows.map((row) => [Number(row.id), toClient(row)]));
  }

  async findById(clientId: number): Promise<Client | null> {
    const [rows] = await legacyMysqlPool.execute<ClientRow[]>(
      `SELECT ${selectClientFields} FROM fcli WHERE CLISEQ = ? LIMIT 1`,
      [clientId],
    );

    const row = rows[0];
    return row === undefined ? null : toClient(row);
  }

  findFirstActive(): Promise<Client | null> { return this.findFirstActiveExcluding([]); }

  async findFirstActiveExcluding(ids: number[]): Promise<Client | null> {
    const [rows] = await legacyMysqlPool.execute<ClientRow[]>(
      `SELECT ${selectClientFields}
       FROM fcli
       WHERE CLIBAJA = '1900-12-31'${excludeIds(ids)}
       ORDER BY CLICOD, CLISEQ
       LIMIT 1`, ids,
    );
    const row = rows[0];
    return row === undefined ? null : toClient(row);
  }

  search(criteria: ClientSearchCriteria): Promise<ClientSearchResult> { return this.searchExcluding(criteria, []); }

  async searchExcluding(criteria: ClientSearchCriteria, ids: number[]): Promise<ClientSearchResult> {
    const searchCondition = criteria.query === undefined
      ? ''
      : ' AND (CLICOD LIKE ? OR CLINOM LIKE ? OR CLIRFC LIKE ?)';
    const where = `1 = 1${statusCondition(criteria.status)}${searchCondition}${excludeIds(ids)}`;
    const searchValue = criteria.query === undefined ? [] : Array(3).fill(`%${criteria.query}%`);
    const parameters = [...searchValue, ...ids];

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

  async findAdjacent(
    clientId: number,
    direction: ClientNavigationDirection,
  ): Promise<Client | null> {
    const [currentRows] = await legacyMysqlPool.execute<IdCodeRow[]>(
      'SELECT CLISEQ AS id, CLICOD AS code FROM fcli WHERE CLISEQ = ? LIMIT 1',
      [clientId],
    );
    const current = currentRows[0];
    if (current === undefined) return null;
    return this.findAdjacentByCode(current.code, direction, []);
  }

  async findAdjacentByCode(code: string, direction: ClientNavigationDirection, ids: number[]): Promise<Client | null> {
    const operator = direction === 'previous' ? '<' : '>';
    const order = direction === 'previous' ? 'DESC' : 'ASC';
    const [rows] = await legacyMysqlPool.execute<ClientRow[]>(
      `SELECT ${selectClientFields}
       FROM fcli
       WHERE CLICOD ${operator} ?${excludeIds(ids)}
       ORDER BY CLICOD ${order}, CLISEQ ${order}
       LIMIT 1`,
      [code, ...ids],
    );

    const row = rows[0];
    return row === undefined ? null : toClient(row);
  }

  async codeExists(code: string, excludingClientId?: number): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<ExistsRow[]>(
      excludingClientId === undefined
        ? 'SELECT 1 AS found FROM fcli WHERE CLICOD = ? LIMIT 1'
        : 'SELECT 1 AS found FROM fcli WHERE CLICOD = ? AND CLISEQ <> ? LIMIT 1',
      excludingClientId === undefined ? [code] : [code, excludingClientId],
    );
    return rows.length > 0;
  }

  async accountingAccountExists(account: string): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<ExistsRow[]>(
      'SELECT 1 AS found FROM fbenc WHERE BCOD = ? LIMIT 1',
      [account],
    );
    return rows.length > 0;
  }

  async catalogAccountSettings() {
    const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & { account: string; active: number; required: number }>>(
      `SELECT CIACTACXC AS account,SUBSTRING(CIAPLUGS,4,1)='X' AS active,
         SUBSTRING(CIACOMPORTA,84,1)<>'1' AS required FROM FCIA WHERE CIASEQ=1 AND CIAALIAS='TUVANSA' LIMIT 1`,
    );
    const row = rows[0];
    return row ? { account: row.account, active: Boolean(row.active), required: Boolean(row.required) } : null;
  }

  async catalogLeafAccount(account: string): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<ExistsRow[]>('SELECT 1 AS found FROM FBENC WHERE BCOD=? AND BSUBCTAS=0 LIMIT 1', [account]);
    return rows.length > 0;
  }

  async findDependency(id: number, code: string): Promise<string | null> {
    const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
      `SELECT ${dependencyTables.map((table) => `EXISTS(SELECT 1 FROM ${table} WHERE CLISEQ=? LIMIT 1) AS ${table}`).join(',')},
       EXISTS(SELECT 1 FROM fcli WHERE CLIAPLICAR=? AND CLIAPLICAR<>'' AND CLISEQ<>? LIMIT 1) AS applications,
       EXISTS(SELECT 1 FROM FYG WHERE LEFT(YGKEY,9)=CONCAT('Li~',RPAD(LEFT(?,6),6,' ')) LIMIT 1) AS licenses`,
      [...dependencyTables.map(() => id), code, id, code],
    );
    const row = rows[0];
    return dependencyTables.find((table) => row?.[table]) ?? (row?.licenses ? 'FYG (licencias)' : row?.applications ? 'CLIAPLICAR' : null);
  }

  async hasCatalogBranches(id: number): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<ExistsRow[]>('SELECT 1 AS found FROM FSUCURSALES WHERE CLISEQ=? LIMIT 1', [id]);
    return rows.length > 0;
  }

  async create(values: ClientCreateValues): Promise<Client> {
    const normalizedValues: ClientCreateValues = {
      ...values,
      priceList: values.priceList ?? 1,
      accountingAccount: values.accountingAccount ?? '1105001',
    };
    const entries = writeEntries(normalizedValues);
    const columns = entries.map(([field]) => columnByField[field]);
    const parameters = entries.map(([field, value]) => storedValue(field, value));
    const placeholders = entries.map(() => '?');

    const [result] = await legacyMysqlPool.execute<ResultSetHeader>(
      `INSERT INTO fcli
         (${columns.join(', ')}, CLIALTA, CLIMONEDA, CLIFECHACAMBIO)
       VALUES
         (${placeholders.join(', ')}, CURDATE(), 1, CURDATE())`,
      parameters,
    );
    const client = await this.findById(result.insertId);
    if (client === null) throw new Error('No fue posible recuperar el cliente creado');
    return client;
  }

  async update(clientId: number, values: ClientWriteValues): Promise<Client | null> {
    const entries = writeEntries(values);
    if (entries.length === 0) return this.findById(clientId);

    const assignments = entries.map(([field]) => `${columnByField[field]} = ?`);
    const parameters = entries.map(([field, value]) => storedValue(field, value));
    await legacyMysqlPool.execute<ResultSetHeader>(
      `UPDATE fcli
       SET ${assignments.join(', ')}, CLIFECHACAMBIO = CURDATE()
       WHERE CLISEQ = ?`,
      [...parameters, clientId],
    );
    return this.findById(clientId);
  }

  async delete(clientId: number): Promise<DeleteClientResult> {
    const connection = await legacyMysqlPool.getConnection();
    try {
      await connection.beginTransaction();
      const [clientRows] = await connection.execute<IdCodeRow[]>(
        'SELECT CLISEQ AS id, CLICOD AS code FROM fcli WHERE CLISEQ = ? LIMIT 1 FOR UPDATE',
        [clientId],
      );
      if (clientRows.length === 0) {
        await connection.rollback();
        return { status: 'not-found' };
      }

      for (const table of dependencyTables) {
        const [rows] = await connection.execute<ExistsRow[]>(
          `SELECT 1 AS found FROM ${table} WHERE CLISEQ = ? LIMIT 1`,
          [clientId],
        );
        if (rows.length > 0) {
          await connection.rollback();
          return { status: 'in-use', relation: table };
        }
      }

      await connection.execute<ResultSetHeader>('DELETE FROM fcli WHERE CLISEQ = ?', [clientId]);
      await connection.commit();
      return { status: 'deleted' };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
