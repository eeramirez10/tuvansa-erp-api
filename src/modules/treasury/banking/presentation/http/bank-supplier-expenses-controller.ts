import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { CaptureBankSupplierExpense } from '../../application/use-cases/capture-bank-supplier-expense.js';

const params = z.object({ bankAccountId: z.coerce.number().int().positive() });
const body = z.strictObject({
  requestKey: z.uuid(),
  receiptId: z.int().positive(),
  supplierId: z.int().positive(),
  revision: z.int().positive(),
  amount: z.number().positive(),
  date: z.iso.date(),
  description: z.string().trim().max(90),
});

export class BankSupplierExpensesController {
  constructor(private readonly expenses: CaptureBankSupplierExpense) {}

  prepare: RequestHandler = async (request, response) => {
    const { bankAccountId } = params.parse(request.params);
    response.set('Cache-Control', 'no-store').json({ data: await this.expenses.prepare(1, bankAccountId) });
  };

  create: RequestHandler = async (request, response) => {
    const { bankAccountId } = params.parse(request.params);
    const result = await this.expenses.save(1, bankAccountId, 0, body.parse(request.body));
    response.status(201).json({ data: result });
  };
}
