import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { WriteBankCatalog } from '../../application/use-cases/write-bank-catalog.js';
import type { BankAccountsDataSource } from '../../domain/datasources/bank-accounts-data-source.js';

const idParams = z.object({ bankAccountId: z.coerce.number().int().positive() });
const short = z.int().min(0).max(255);
const percent = z.int().min(0).max(100);
const text = (limit: number) => z.string().trim().max(limit);
const fields = z.strictObject({
  code: z.string().trim().min(1).max(16),
  family: text(13),
  accountNumber: text(25),
  branch: text(4),
  name: text(40),
  nature: z.enum(['debtor', 'creditor']),
  systemType: z.enum(['bank', 'expense', 'other']),
  currencyId: z.int().min(0).max(2),
  control: z.strictObject({
    manager: text(30),
    phone: text(20),
    customerNumber: z.string().trim().regex(/^\d{0,18}$/),
    controlEnabled: z.boolean(),
    nextCheckNumber: z.int().min(0),
    nextDepositNumber: z.int().min(0),
    nextTransferNumber: z.int().min(0).max(2147483647),
    subAccounts: z.boolean(),
    preventJournalEntries: z.boolean(),
    format: text(15),
    movements: z.boolean(),
    budgetable: z.boolean(),
    company: short,
    deposits: z.boolean(),
    payments: z.boolean(),
    multiCompany: short,
  }),
  prorationPercentages: z.strictObject({ sales: percent, inventory: percent, distribution: percent, advance: percent }),
  fiscalReports: z.strictObject({
    annualInflationAdjustment: z.int().min(0).max(2),
    deductibleIetu: z.boolean(),
    nonDeductibleVat: z.boolean(),
  }).optional(),
});
const createInput = z.strictObject({ requestKey: z.uuid(), fields });
const updateInput = z.strictObject({ revision: z.string().regex(/^[0-9a-f]{64}$/), fields });
const removeInput = z.strictObject({ revision: z.string().regex(/^[0-9a-f]{64}$/), confirmed: z.literal(true) });

export class BankCatalogWritesController {
  constructor(
    private readonly catalog: WriteBankCatalog,
    private readonly accounts?: BankAccountsDataSource,
  ) {}

  getCreate: RequestHandler = async (_request, response) => {
    response.json({ data: await this.catalog.getCreate() });
  };

  getEdit: RequestHandler = async (request, response) => {
    const { bankAccountId } = idParams.parse(request.params);
    response.json({ data: await this.catalog.getEdit(bankAccountId) });
  };

  create: RequestHandler = async (request, response) => {
    const { requestKey, fields } = createInput.parse(request.body);
    const created = await this.catalog.create(requestKey, fields);
    const account = await this.accounts?.findById(created.toPrimitives().id);
    response.status(201).json({ data: (account ?? created).toPrimitives() });
  };

  update: RequestHandler = async (request, response) => {
    const { bankAccountId } = idParams.parse(request.params);
    const { revision, fields } = updateInput.parse(request.body);
    const updated = await this.catalog.update(bankAccountId, revision, fields);
    const account = await this.accounts?.findById(bankAccountId);
    response.json({ data: (account ?? updated).toPrimitives() });
  };

  remove: RequestHandler = async (request, response) => {
    const { bankAccountId } = idParams.parse(request.params);
    const { revision } = removeInput.parse(request.body);
    await this.catalog.remove(bankAccountId, revision);
    response.sendStatus(204);
  };
}
