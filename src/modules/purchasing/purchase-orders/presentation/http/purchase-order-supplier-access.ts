import type { RequestHandler } from 'express';
import type { RowDataPacket } from 'mysql2/promise';
import type { UserAccess } from '../../../../general-data/users/domain/user-directory.js';
import type { PurchaseOrder } from '../../domain/entities/purchase-order.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';

function supplierDenied(): never {
  throw new ApplicationError('Tu usuario no tiene autorizado el clasificador de este proveedor.', 'WEB_USER_SUPPLIER_RESTRICTED', 403);
}

export function purchaseSupplierAccess(findOrder: (id: number) => Promise<PurchaseOrder | null>): RequestHandler {
  return async (request, response, next) => {
    const access: UserAccess | undefined = response.locals.userAccess;
    const suppliers = access?.supplierClassifiers;
    if (suppliers && request.method === 'PATCH' && /\/actions\/authorization(?:\/supplier)?\/?$/i.test(request.path)) {
      const classifier = access?.classifier;
      if (!classifier || !Number.isInteger(classifier) || classifier < 1 || classifier > 9) supplierDenied();
      const id = Number(decodeURIComponent(request.path).split('/')[1]);
      const order = Number.isSafeInteger(id) && id > 0 ? await findOrder(id) : null;
      if (!order) throw new NotFoundError('Orden de compra');
      const proposed = request.body?.supplierCode;
      const forCode = typeof proposed === 'string' && /\/supplier\/?$/i.test(request.path);
      const ref = forCode ? proposed.trim() : order.toPrimitives().supplier.id;
      const [[supplier]] = await legacyMysqlPool.execute<Array<RowDataPacket & { key: string }>>(
        `SELECT TRIM(SUBSTRING(PRVPAR${classifier},2,99)) AS \`key\`
         FROM FPRV WHERE ${forCode ? 'PRVCOD' : 'PRVSEQ'}=? LIMIT 1`, [ref]);
      if (!supplier?.key || !suppliers.includes(supplier.key)) supplierDenied();
    }
    next();
  };
}
