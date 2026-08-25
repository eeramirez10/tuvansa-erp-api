import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { legacyMysqlPool } from '../src/shared/infrastructure/database/legacy-mysql-pool.js';

interface ClientSummary {
  id: number;
}

interface ClientScreenRow extends RowDataPacket {
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
  hasEvents: number;
  priceList: number;
  discount1: number;
  discount2: number;
  discount3: number;
  paymentTermDays: number;
  reviewStartsFromInvoice: number;
  creditLimit: number;
  creditExpiresAt: string | null;
  reviewDay: string;
  reviewTime: string;
  paymentDay: string;
  paymentTime: string;
  applyToClientCode: string;
  actualPaymentTermDays: number;
  previousBalance: number;
  currentBalance: number;
  accumulatedSales: number;
  lastPurchaseAt: string | null;
  lastPaymentAt: string | null;
  lastOrderAt: string | null;
  createdAt: string | null;
}

interface ClientDetailBody {
  data: {
    id: number;
    code: string;
    name: string;
    isActive: boolean;
    deactivatedAt: string | null;
    address: Record<string, unknown>;
    contact: Record<string, unknown>;
    fiscal: Record<string, unknown>;
    indicators: Record<string, unknown>;
    terms: Record<string, unknown>;
    totals: Record<string, unknown>;
    createdAt: string | null;
  };
}

interface ClientListBody {
  data: ClientSummary[];
  pagination: {
    total: number;
  };
}

const app = createApp();

try {
  const listResponse = await request(app).get(
    '/api/accounts-receivable/clients?page=1&pageSize=2',
  );
  const listBody = listResponse.body as ClientListBody;
  const firstClient = listBody.data[0];

  if (listResponse.status !== 200 || firstClient === undefined) {
    throw new Error(`La consulta de clientes fallo con HTTP ${listResponse.status}`);
  }

  const detailResponse = await request(app).get(
    `/api/accounts-receivable/clients/${firstClient.id}`,
  );

  const [screenRows] = await legacyMysqlPool.execute<ClientScreenRow[]>(`
    SELECT
      CLISEQ AS id, CLICOD AS code, CLINOM AS name,
      NULLIF(CLIBAJA, '1900-12-31') AS deactivatedAt,
      CLIDIR AS street, CLINUMEXT AS exteriorNumber, CLINUMINT AS interiorNumber,
      CLICOLONIA AS neighborhood, CLIDELEGACION AS borough, CLICD AS city,
      CLIEDO AS state, CLICP AS postalCode, CLIPAIS AS countryCode,
      CLICONT AS contactName, CLITEL AS phones, CLIFAX AS fax,
      CLITEL3 AS email, CLITEL4 AS website,
      CLIRFC AS taxId, CLICURP AS curp, CLISUCURSAL AS branch, CLICTA AS accountingAccount,
      (CLIEVENTOS = '*') AS hasEvents,
      CLISTA AS priceList, CLIDESC10 AS discount1, CLIDESC20 AS discount2,
      CLIDESC30 AS discount3, CLIPLAZO0 AS paymentTermDays,
      CLIPLAZOREV AS reviewStartsFromInvoice, CLICREDIT AS creditLimit,
      NULLIF(CLIVIGENCIACRED, '1900-12-31') AS creditExpiresAt,
      CLIDIREV AS reviewDay, CLIHORAREV AS reviewTime,
      CLIDIPAGO AS paymentDay, CLIHORAPAG AS paymentTime, CLIAPLICAR AS applyToClientCode,
      CLIPLAZOR AS actualPaymentTermDays, CLISANT AS previousBalance,
      CLISACT AS currentBalance, CLIACUMULADO AS accumulatedSales,
      NULLIF(CLIULTCOM, '1900-12-31') AS lastPurchaseAt,
      NULLIF(CLIULTPAG, '1900-12-31') AS lastPaymentAt,
      NULLIF(CLIULTPED, '1900-12-31') AS lastOrderAt,
      NULLIF(CLIALTA, '1900-12-31') AS createdAt
    FROM fcli
    WHERE CLISEQ = 15331
  `);
  const screenRow = screenRows[0];
  if (screenRow === undefined) throw new Error('No se encontro el cliente de auditoria 15331');

  const auditedResponse = await request(app).get(
    '/api/accounts-receivable/clients/15331',
  );
  const audited = (auditedResponse.body as ClientDetailBody).data;
  const expected = {
    id: screenRow.id,
    code: screenRow.code,
    name: screenRow.name,
    isActive: screenRow.deactivatedAt === null,
    deactivatedAt: screenRow.deactivatedAt,
    address: {
      street: screenRow.street,
      exteriorNumber: screenRow.exteriorNumber,
      interiorNumber: screenRow.interiorNumber,
      neighborhood: screenRow.neighborhood,
      borough: screenRow.borough,
      city: screenRow.city,
      state: screenRow.state,
      postalCode: screenRow.postalCode,
      countryCode: screenRow.countryCode,
    },
    contact: {
      name: screenRow.contactName,
      phones: screenRow.phones,
      fax: screenRow.fax,
      email: screenRow.email,
      website: screenRow.website,
    },
    fiscal: {
      taxId: screenRow.taxId,
      curp: screenRow.curp,
      branch: screenRow.branch,
      accountingAccount: screenRow.accountingAccount,
    },
    indicators: { hasEvents: screenRow.hasEvents === 1 },
    terms: {
      priceList: screenRow.priceList,
      discounts: [screenRow.discount1, screenRow.discount2, screenRow.discount3],
      paymentTermDays: screenRow.paymentTermDays,
      creditLimit: screenRow.creditLimit,
      creditExpiresAt: screenRow.creditExpiresAt,
      reviewDay: screenRow.reviewDay,
      reviewTime: screenRow.reviewTime,
      paymentDay: screenRow.paymentDay,
      paymentTime: screenRow.paymentTime,
      applyToClientCode: screenRow.applyToClientCode,
      reviewStartsFromInvoice: screenRow.reviewStartsFromInvoice === 1,
    },
    totals: {
      actualPaymentTermDays: screenRow.actualPaymentTermDays,
      previousBalance: screenRow.previousBalance,
      currentBalance: screenRow.currentBalance,
      availableCredit: Math.max(screenRow.creditLimit - screenRow.currentBalance, 0),
      accumulatedSales: screenRow.accumulatedSales,
      lastPurchaseAt: screenRow.lastPurchaseAt,
      lastPaymentAt: screenRow.lastPaymentAt,
      lastOrderAt: screenRow.lastOrderAt,
    },
    createdAt: screenRow.createdAt,
  };

  assert.equal(auditedResponse.status, 200);
  assert.deepEqual(audited, expected);

  console.log({
    listStatus: listResponse.status,
    returnedItems: listBody.data.length,
    total: listBody.pagination.total,
    detailStatus: detailResponse.status,
    detailSections: Object.keys((detailResponse.body as { data: object }).data),
    auditedClient: screenRow.code,
    auditedVisibleFields: 42,
  });
} finally {
  await legacyMysqlPool.end();
}
