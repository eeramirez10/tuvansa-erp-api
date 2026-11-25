import type { RequestHandler } from 'express';
import type { RowDataPacket } from 'mysql2/promise';
import { ApplicationError } from '../../../../shared/domain/errors/application-error.js';
import { legacyMysqlPool } from '../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { customerScope, requireCustomer } from '../../../../shared/infrastructure/http/customer-scope.js';
import type { UserAccess, WebIdentity } from '../domain/user-directory.js';
import { sessionRequired } from '../infrastructure/postgres-web-access.js';
import { requireSessionOrigin, sessionToken } from './web-session-http.js';

type Authenticate = (token?: string) => Promise<WebIdentity | null>;
type FindClients = (access: UserAccess) => Promise<ReadonlySet<number>>;
const read = ['GET', 'HEAD'];
const catalog = /^\/(?:accounts-receivable\/clients|accounts-payable\/suppliers)(?:\/(?:first|\d+(?:\/(?:next|previous))?))?$/;
const productCatalog = /^\/inventories\/products(?:\/(?:first|\d+(?:\/(?:next|previous|actions\/photo(?:\/image)?))?))?$/;
const allowedCustomerModule = /^\/(?:accounts-receivable\/clients|sales\/(?:orders|invoices))(?:\/|$)/;
const costKey = /^(?:cost|costCurrencyId|averageCost|lastCost|previousCost|unitCost|costAmount|totalCost|costValue|stockValue|profit|margin)$/i;
const balanceKey = /balance|saldo|availableCredit|creditLimit|amountDue|pendingPayment|outstandingDebt/i;

function denied(message: string): never {
  throw new ApplicationError(message, 'WEB_USER_ACCESS_RESTRICTED', 403);
}

function enforceAccess(path: string, method: string, access: UserAccess) {
  const reading = read.includes(method);
  if (access.ownCustomersOnly && !allowedCustomerModule.test(path) && !(reading && productCatalog.test(path))) {
    denied('Esta consulta no admite el filtro de tus clientes.');
  }
  if (access.hideCosts && (
    /^\/(?:accounting|purchasing|accounts-payable|sales\/reports)(?:\/|$)/.test(path) ||
    (/^\/inventories\//.test(path) && !(reading && productCatalog.test(path)))
  )) denied('Tu usuario tiene activada la restricción No ver costos.');
  if (access.hideBalances && (
    /^\/(?:accounting|treasury|sales\/reports)(?:\/|$)/.test(path) ||
    (/^\/(?:accounts-receivable|accounts-payable)\//.test(path) && !(reading && catalog.test(path)))
  )) denied('Tu usuario tiene activada la restricción No ver saldos.');
}

function redact(value: unknown, access: UserAccess): unknown {
  if (Array.isArray(value)) return value.map(item => redact(item, access));
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).map(([key, field]) => {
    if (access.hideCosts && key === 'costs' && field && typeof field === 'object') {
      return [key, Object.fromEntries(Object.keys(field).map(name => [name, null]))];
    }
    if ((access.hideCosts && costKey.test(key)) || (access.hideBalances && balanceKey.test(key))) return [key, null];
    return [key, redact(field, access)];
  }));
}

async function findClients(access: UserAccess): Promise<ReadonlySet<number>> {
  const { classifier, parameter, company } = access;
  if (!classifier || !Number.isInteger(classifier) || classifier < 1 || classifier > 9 || !parameter) return new Set();
  const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & { id: number }>>(
    `SELECT CLISEQ AS id FROM FCLI WHERE TRIM(SUBSTRING(CLIPAR${classifier}, 2, 9)) = ?
       AND (?=0 OR CLICIA IN (0,?))`, [parameter.trim(), company ?? 0, company ?? 0]);
  return new Set(rows.map(row => Number(row.id)));
}

function enforceCaptureDates(path: string, method: string, body: unknown, access: UserAccess) {
  if (read.includes(method) || (!access.captureFrom && !access.captureUntil) || !body || typeof body !== 'object') return;
  if (!/^\/(?:sales\/orders|purchasing\/|inventories\/movements|sales\/invoices)/.test(path)) return;
  for (const key of ['orderedAt', 'issuedAt', 'receivedAt', 'documentDate', 'date']) {
    const date = (body as Record<string, unknown>)[key];
    if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
      ((access.captureFrom && date < access.captureFrom) || (access.captureUntil && date > access.captureUntil))) {
      denied('La fecha está fuera del periodo de capturas de tu usuario.');
    }
  }
}

export function createBusinessAccess(authenticate: Authenticate, clients: FindClients = findClients): RequestHandler {
  return async (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    const user = await authenticate(sessionToken(request));
    if (!user) throw sessionRequired();
    response.locals.userAccess = user.access;
    if (!read.includes(request.method)) requireSessionOrigin(request);
    const path = decodeURIComponent(request.path).toLowerCase().replace(/\/+$/, '');
    enforceAccess(path, request.method, user.access);
    enforceCaptureDates(path, request.method, request.body, user.access);
    const scopedClients = user.access.ownCustomersOnly ? await clients(user.access) : undefined;
    if (user.access.hideCosts || user.access.hideBalances) {
      const json = response.json.bind(response);
      response.json = body => json(redact(body, user.access));
    }
    customerScope.run(scopedClients, () => {
      if (scopedClients && path.startsWith('/accounts-receivable/clients')) {
        const client = /^\/accounts-receivable\/clients\/(\d+)(?:\/|$)/.exec(path);
        if (client) requireCustomer(Number(client[1]));
        else if (!(read.includes(request.method) && ['/accounts-receivable/clients', '/accounts-receivable/clients/first'].includes(path))) {
          denied('Esta operación requiere una ficha de tus clientes.');
        }
      }
      next();
    });
  };
}
