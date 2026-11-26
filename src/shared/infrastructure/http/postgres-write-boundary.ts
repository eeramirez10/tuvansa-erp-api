import type { RequestHandler } from 'express';
import { env } from '../../../config/env.js';
import { ApplicationError } from '../../domain/errors/application-error.js';

// Explicit allowlist: only modules wired to PostgreSQL can receive mutations.
// Legacy GET endpoints and the explicit, non-persistent report calculation remain
// available; this is not an authorization middleware.
export const postgresWriteBoundary: RequestHandler = (req, _res, next) => {
  if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) { next(); return; }
  const path = req.path.replace(/\/+$/,'');
  const webSession = (path === '/session' && ['POST', 'DELETE'].includes(req.method)) ||
    (path === '/session/activation' && req.method === 'POST');
  const webUsers = (path === '/general-data/users' && req.method === 'POST') ||
    (req.method === 'PATCH' && /^\/general-data\/(users\/(g-[1-9]\d*|[a-f0-9-]+)|permission-groups\/\d+)$/i.test(path)) ||
    (req.method === 'POST' && /^\/general-data\/users\/(g-[1-9]\d*|[a-f0-9-]+)\/activation$/i.test(path));
  if (webSession || webUsers) { next(); return; }
  const readOnlyCalculation = req.method==='POST' && path==='/sales/reports/collection-commissions/preview';
  const create = req.method==='POST' && (path==='/sales/orders' || path==='/sales/orders/capture');
  const orderAction = req.method==='POST' && /^\/sales\/orders\/[1-9]\d*\/actions\/(quote-conversion|authorization|assignment)$/.test(path);
  const orderComments = req.method==='PATCH' && /^\/sales\/orders\/[1-9]\d*\/actions\/comments$/.test(path);
  const modify = ['PATCH','DELETE'].includes(req.method) && /^\/sales\/orders\/[1-9]\d*$/.test(path);
  const cancelInventory = env.INVENTORY_MOVEMENTS_SOURCE === 'postgres' &&
    req.method === 'DELETE' && /^\/inventories\/movements\/[1-9]\d*$/.test(path);
  const writeInventory = env.NEON_DATABASE_URL !== '' &&
    ((req.method === 'POST' && path === '/inventories/movements') ||
      (req.method === 'DELETE' && /^\/inventories\/movements\/79500\d{8}$/.test(path)));
  const classifyProduct = env.NEON_DATABASE_URL !== '' &&
    req.method === 'PATCH' && /^\/inventories\/products\/[1-9]\d*\/actions\/classifications$/.test(path);
  const editOtherData = env.NEON_DATABASE_URL !== '' &&
    req.method === 'PATCH' && /^\/inventories\/products\/[1-9]\d*\/actions\/other-data$/.test(path);
  const writeProduct = env.NEON_DATABASE_URL !== '' &&
    ((req.method === 'POST' && path === '/inventories/products') ||
      (req.method === 'PATCH' && /^\/inventories\/products\/[1-9]\d*\/actions\/block-status$/.test(path)) ||
      (['PATCH','DELETE'].includes(req.method) && /^\/inventories\/products\/[1-9]\d*$/.test(path)));
  const purchaseOrderAction = env.NEON_DATABASE_URL !== '' && req.method === 'PATCH' &&
    /^\/purchasing\/purchase-orders\/[1-9]\d*\/actions\/(classifications|comments|confirmation|ct|pieces(?:\/(?:confirmation|import))?|quote-conversion|change-supplier|authorization(?:\/supplier)?)$/.test(path);
  const changePurchaseOrder = env.NEON_DATABASE_URL !== '' && ['PATCH', 'DELETE'].includes(req.method) &&
    /^\/purchasing\/purchase-orders\/[1-9]\d*$/.test(path);
  const createPurchaseOrder = env.NEON_DATABASE_URL !== '' && req.method === 'POST' &&
    (path === '/purchasing/purchase-orders' || /^\/purchasing\/purchase-orders\/[1-9]\d*\/actions\/(duplicate|split|branches)$/.test(path));
  const createPurchaseReception = env.NEON_DATABASE_URL !== '' && req.method === 'POST' &&
    (path === '/purchasing/purchase-receptions' || path === '/purchasing/purchase-receptions/general-expenses');
  const writeReceptionPiece = env.NEON_DATABASE_URL !== '' &&
    ((['POST', 'PATCH'].includes(req.method) && /^\/purchasing\/purchase-receptions\/[1-9]\d*\/actions\/pieces\/lines\/[1-9]\d*$/.test(path)) ||
      (req.method === 'PATCH' && /^\/purchasing\/purchase-receptions\/[1-9]\d*\/actions\/pieces\/[1-9]\d*\/serial$/.test(path)));
  const editReception = env.NEON_DATABASE_URL !== '' && req.method === 'PATCH' &&
    /^\/purchasing\/purchase-receptions\/[1-9]\d*\/actions\/(classifications|comments|change-supplier)$/.test(path);
  const documentReception = env.NEON_DATABASE_URL !== '' && req.method === 'POST' &&
    /^\/purchasing\/purchase-receptions\/[1-9]\d*\/actions\/document$/.test(path);
  const createSupplierPayment = env.NEON_DATABASE_URL !== '' && req.method === 'POST' &&
    /^\/accounts-payable\/suppliers\/[1-9]\d*\/payments\/[1-9]\d*$/.test(path);
  const writeSupplier = env.NEON_DATABASE_URL !== '' &&
    ((req.method === 'POST' && path === '/accounts-payable/suppliers') ||
     (['PATCH', 'DELETE'].includes(req.method) && /^\/accounts-payable\/suppliers\/[1-9]\d*$/.test(path)) ||
     (req.method === 'PATCH' && /^\/accounts-payable\/suppliers\/[1-9]\d*\/actions\/(classifications|various)$/.test(path)) ||
     (req.method === 'POST' && /^\/accounts-payable\/suppliers\/[1-9]\d*\/(actions\/(events|contacts)|balance\/grouping)$/.test(path)) ||
     (['PATCH', 'DELETE'].includes(req.method) && /^\/accounts-payable\/suppliers\/[1-9]\d*\/actions\/(events|contacts)\/[^/]+$/.test(path)));
  const reversePurchasePosting = env.NEON_DATABASE_URL !== '' && req.method === 'POST' &&
    (/^\/accounts-payable\/suppliers\/[1-9]\d*\/payments\/[1-9]\d*\/reversal$/.test(path) ||
      /^\/purchasing\/purchase-receptions\/[1-9]\d*\/actions\/cancel-(expense|reception)$/.test(path));
  const createSalesRemission = env.NEON_DATABASE_URL !== '' && req.method === 'POST' && path === '/sales/invoices/from-order';
  const editInvoicePieces = env.NEON_DATABASE_URL !== '' && req.method === 'PATCH' &&
    /^\/sales\/invoices\/[1-9]\d*\/summaries\/edit-pieces\/[1-9]\d*$/.test(path);
  const convertSalesTicket = env.NEON_DATABASE_URL !== '' && req.method === 'POST' &&
    /^\/sales\/invoices\/[1-9]\d*\/summaries\/(ticket-to-invoice|transfer)$/.test(path);
  const cancelSalesRemission = env.NEON_DATABASE_URL !== '' && req.method === 'POST' &&
    /^\/sales\/invoices\/[1-9]\d*\/actions\/cancel-remission$/.test(path);
  const simulateSalesStamping = env.NEON_DATABASE_URL !== '' && req.method === 'POST' &&
    /^\/sales\/invoices\/[1-9]\d*\/actions\/seal\/simulation$/.test(path);
  const createCustomerCollection = env.NEON_DATABASE_URL !== '' && req.method === 'POST' &&
    /^\/accounts-receivable\/clients\/[1-9]\d*\/collections\/[1-9]\d*$/.test(path);
  const writeClient = env.NEON_DATABASE_URL !== '' &&
    ((req.method === 'POST' && path === '/accounts-receivable/clients') ||
     (['PATCH','DELETE'].includes(req.method) && /^\/accounts-receivable\/clients\/[1-9]\d*$/.test(path)) ||
     (req.method === 'PATCH' && /^\/accounts-receivable\/clients\/[1-9]\d*\/actions\/block-status$/.test(path)));
  const reverseCustomerCollection = env.NEON_DATABASE_URL !== '' && req.method === 'POST' &&
    /^\/accounts-receivable\/clients\/[1-9]\d*\/collections\/[1-9]\d*\/reversal$/.test(path);
  const writeBankReconciliation = env.NEON_DATABASE_URL !== '' &&
    ((req.method === 'POST' && /^\/treasury\/bank-accounts\/[1-9]\d*\/actions\/reconciliation$/.test(path)) ||
     (req.method === 'PATCH' && /^\/treasury\/bank-accounts\/[1-9]\d*\/actions\/reconciliation\/(transit|postdate)$/.test(path)));
  const bankCatalogMutations = env.NEON_DATABASE_URL !== '' &&
    ((req.method === 'POST' && path === '/treasury/bank-accounts') ||
     (['PATCH', 'DELETE'].includes(req.method) && /^\/treasury\/bank-accounts\/[1-9]\d*$/.test(path)));
  const bankActions = env.NEON_DATABASE_URL !== '' &&
    ((req.method === 'POST' && /^\/treasury\/bank-accounts\/[1-9]\d*\/actions\/(transfer|supplier-expenses|authorization-review\/transfer)$/.test(path)) ||
     (req.method === 'PATCH' && /^\/treasury\/bank-accounts\/[1-9]\d*\/actions\/(classifiers|general-ledger|cost-center-ledger|authorization-review)$/.test(path)));
  const writeManualPolicy = env.NEON_DATABASE_URL !== '' &&
    ((req.method === 'POST' && (path === '/accounting/policies' ||
       /^\/accounting\/policies\/[1-9]\d*\/actions\/(apply|unapply|duplicate|duplicate-liability)$/.test(path))) ||
     (['PATCH','DELETE'].includes(req.method) && /^\/accounting\/policies\/[1-9]\d*$/.test(path)) ||
     (req.method === 'PATCH' && /^\/accounting\/policies\/[1-9]\d*\/actions\/(comments|classifications)$/.test(path)));
  if (readOnlyCalculation || create || orderAction || orderComments || modify || cancelInventory || writeInventory || classifyProduct || editOtherData || writeProduct || purchaseOrderAction || changePurchaseOrder || createPurchaseOrder || createPurchaseReception || writeReceptionPiece || editReception || documentReception || writeSupplier || createSupplierPayment || reversePurchasePosting || createSalesRemission || editInvoicePieces || convertSalesTicket || cancelSalesRemission || simulateSalesStamping || writeClient || createCustomerCollection || reverseCustomerCollection || writeBankReconciliation || bankCatalogMutations || bankActions || writeManualPolicy) { next(); return; }
  next(new ApplicationError('Las escrituras de este módulo todavía no están migradas a PostgreSQL; MySQL permanece en sólo lectura.', 'MODULE_WRITES_NOT_MIGRATED',503));
};
