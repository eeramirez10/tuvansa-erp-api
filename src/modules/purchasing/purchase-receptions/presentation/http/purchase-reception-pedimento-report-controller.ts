import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { MysqlPurchaseReceptionPedimentoReport } from '../../infrastructure/datasources/mysql-purchase-reception-pedimento-report.js';

const params = z.object({ purchaseReceptionId: z.coerce.number().int().positive() });

export class PurchaseReceptionPedimentoReportController {
  constructor(private readonly report: Pick<MysqlPurchaseReceptionPedimentoReport, 'execute'>) {}

  get: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId } = params.parse(request.params);
      response.json({ data: await this.report.execute(purchaseReceptionId) });
    } catch (error) { next(error); }
  };
}
