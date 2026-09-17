import type { RequestHandler } from 'express';
import { ApplicationError } from '../../domain/errors/application-error.js';

// Explicit allowlist: only modules wired to PostgreSQL can receive mutations.
// Legacy GET endpoints remain available; this is not an authorization middleware.
export const postgresWriteBoundary: RequestHandler = (req, _res, next) => {
  if (!['POST','PUT','PATCH','DELETE'].includes(req.method)) { next(); return; }
  const path = req.path.replace(/\/+$/,'');
  const create = req.method==='POST' && (path==='/sales/orders' || path==='/sales/orders/capture');
  const orderAction = req.method==='POST' && /^\/sales\/orders\/[1-9]\d*\/actions\/(quote-conversion|authorization|assignment)$/.test(path);
  const modify = ['PATCH','DELETE'].includes(req.method) && /^\/sales\/orders\/[1-9]\d*$/.test(path);
  if (create || orderAction || modify) { next(); return; }
  next(new ApplicationError('Las escrituras de este módulo todavía no están migradas a PostgreSQL; MySQL permanece en sólo lectura.', 'MODULE_WRITES_NOT_MIGRATED',503));
};
