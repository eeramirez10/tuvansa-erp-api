import { Router } from 'express';
import { z } from 'zod';
import { expenseCents, type CreatePurchaseExpenses } from '../../application/use-cases/create-purchase-expenses.js';

const supplierCode = z.string().trim().min(1).max(6).toUpperCase();
const productCode = z.string().trim().min(1).max(13).toUpperCase();
const accountCode = z.string().trim().min(1).max(16);
const amount = z.number().refine((value) => expenseCents(value) !== null, 'Usa importes en pesos con un máximo de dos decimales.');
const catalogQuery = z.object({ supplierCode: supplierCode.optional(), productCode: productCode.optional() });
const capture = z.strictObject({
  requestKey: z.uuid(),
  date: z.iso.date(),
  reference: z.string().trim().max(13),
  beneficiary: z.string().trim().max(85),
  description: z.string().trim().max(90),
  taxAccounts: z.strictObject({
    vat: accountCode.optional(), vatWithholding: accountCode.optional(), incomeWithholding: accountCode.optional(),
  }).optional(),
  lines: z.array(z.strictObject({
    supplierCode,
    productCode,
    reference: z.string().trim().max(23),
    base: amount,
    vat: amount,
    vatWithholding: amount,
    incomeWithholding: amount,
    costCenter: z.string().trim().regex(/^(0|[1-9][0-9]{0,5})$/),
  })).min(1),
});

export const createPurchaseExpenseRouter = (expenses: CreatePurchaseExpenses): Router => {
  const router = Router();
  const actor = { companyId: 1, userId: 0 };
  router.get('/create', async (_request, response, next) => {
    try { response.json({ data: await expenses.prepare(actor.companyId) }); }
    catch (error) { next(error); }
  });
  router.get('/catalog', async (request, response, next) => {
    try {
      const query = catalogQuery.parse(request.query);
      response.json({ data: await expenses.catalog(actor.companyId, query.supplierCode, query.productCode) });
    } catch (error) { next(error); }
  });
  router.post('/', async (request, response, next) => {
    try {
      const { taxAccounts, ...fields } = capture.parse(request.body);
      const accounts = taxAccounts && {
        ...(taxAccounts.vat ? { vat: taxAccounts.vat } : {}),
        ...(taxAccounts.vatWithholding ? { vatWithholding: taxAccounts.vatWithholding } : {}),
        ...(taxAccounts.incomeWithholding ? { incomeWithholding: taxAccounts.incomeWithholding } : {}),
      };
      const result = await expenses.save(actor, { ...fields, ...(accounts && Object.keys(accounts).length ? { taxAccounts: accounts } : {}) });
      response.status(201).json({ data: result });
    } catch (error) { next(error); }
  });
  return router;
};
