import type { RequestHandler } from 'express';
import { env } from '../../../config/env.js';
import { ApplicationError } from '../../domain/errors/application-error.js';

// Explicit allowlist: only modules wired to PostgreSQL can receive mutations.
// Legacy GET endpoints and the explicit, non-persistent report calculation remain
// available; this is not an authorization middleware.
export const postgresWriteBoundary: RequestHandler = (req, _res, next) => {
  if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) { next(); return; }
  const path = req.path.replace(/\/+$/,'');
  const readOnlyCalculation = req.method==='POST' && path==='/sales/reports/collection-commissions/preview';
  const create = req.method==='POST' && (path==='/sales/orders' || path==='/sales/orders/capture');
  const orderAction = req.method==='POST' && /^\/sales\/orders\/[1-9]\d*\/actions\/(quote-conversion|authorization|assignment)$/.test(path);
  const orderComments = req.method==='PATCH' && /^\/sales\/orders\/[1-9]\d*\/actions\/comments$/.test(path);
  const modify = ['PATCH','DELETE'].includes(req.method) && /^\/sales\/orders\/[1-9]\d*$/.test(path);
  const cancelInventory = env.INVENTORY_MOVEMENTS_SOURCE === 'postgres' &&
    req.method === 'DELETE' && /^\/inventories\/movements\/[1-9]\d*$/.test(path);
  const classifyProduct = env.INVENTORY_CLASSIFICATION_PILOT_PRODUCTS.length > 0 && env.NEON_DATABASE_URL !== '' &&
    req.method === 'PATCH' && /^\/inventories\/products\/[1-9]\d*\/actions\/classifications$/.test(path);
  const editOtherData = env.INVENTORY_OTHER_DATA_PILOT_PRODUCTS.length > 0 && env.NEON_DATABASE_URL !== '' &&
    req.method === 'PATCH' && /^\/inventories\/products\/[1-9]\d*\/actions\/other-data$/.test(path);
  const editProduct = env.INVENTORY_PRODUCT_EDIT_PILOT_PRODUCTS.length > 0 && env.NEON_DATABASE_URL !== '' &&
    req.method === 'PATCH' && /^\/inventories\/products\/[1-9]\d*$/.test(path);
  const purchaseOrderAction = env.NEON_DATABASE_URL !== '' && req.method === 'PATCH' &&
    /^\/purchasing\/purchase-orders\/[1-9]\d*\/actions\/(classifications|confirmation)$/.test(path);
  const changePurchaseOrder = env.NEON_DATABASE_URL !== '' && ['PATCH', 'DELETE'].includes(req.method) &&
    /^\/purchasing\/purchase-orders\/[1-9]\d*$/.test(path);
  const createPurchaseOrder = env.NEON_DATABASE_URL !== '' && req.method === 'POST' && path === '/purchasing/purchase-orders';
  if (readOnlyCalculation || create || orderAction || orderComments || modify || cancelInventory || classifyProduct || editOtherData || editProduct || purchaseOrderAction || changePurchaseOrder || createPurchaseOrder) { next(); return; }
  next(new ApplicationError('Las escrituras de este módulo todavía no están migradas a PostgreSQL; MySQL permanece en sólo lectura.', 'MODULE_WRITES_NOT_MIGRATED',503));
};
