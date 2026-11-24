import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { MysqlPurchaseReceptionLabels } from '../../infrastructure/datasources/mysql-purchase-reception-labels.js';

const params = z.object({ purchaseReceptionId: z.coerce.number().int().positive() });

export class PurchaseReceptionLabelsController {
  constructor(private readonly labels: Pick<MysqlPurchaseReceptionLabels, 'execute'>) {}

  get: RequestHandler = async (request, response, next) => {
    try {
      const { purchaseReceptionId } = params.parse(request.params);
      response.json({ data: await this.labels.execute(purchaseReceptionId) });
    } catch (error) { next(error); }
  };
}
