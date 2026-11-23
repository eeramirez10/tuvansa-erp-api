import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { CaptureBankReconciliation } from '../../application/use-cases/capture-bank-reconciliation.js';
import type { ConfigureBankPanels } from '../../application/use-cases/configure-bank-panels.js';
import type { CaptureBankTransfer } from '../../application/use-cases/capture-bank-transfer.js';
import type { GetBankAccount } from '../../application/use-cases/get-bank-account.js';
import type { GetBankAccountByCode } from '../../application/use-cases/get-bank-account-by-code.js';
import type { GetBankPanel } from '../../application/use-cases/get-bank-panel.js';
import type { GetFirstBankAccount } from '../../application/use-cases/get-first-bank-account.js';
import type { NavigateBankAccount } from '../../application/use-cases/navigate-bank-account.js';
import type { SearchBankAccounts } from '../../application/use-cases/search-bank-accounts.js';
import type { BankPanelKey } from '../../domain/repositories/bank-panels-repository.js';

const idParamsSchema = z.object({ bankAccountId: z.coerce.number().int().positive() });
const codeParamsSchema = z.object({ code: z.string().trim().min(1).max(30) });
const searchSchema = z.object({
  q: z.string().trim().min(1).optional(),
  code: z.string().trim().min(1).max(30).optional(),
  accountNumber: z.string().trim().min(1).max(40).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});
const panelQuerySchema = z.object({
  fiscalYear: z.coerce.number().int().min(1900).max(2200).default(new Date().getFullYear()),
  costCenter: z.string().trim().min(1).max(3).default('1'),
  asOfDate: z.iso.date().default(new Date().toISOString().slice(0, 10)),
});
const reconciliationSchema = z.strictObject({
  requestKey: z.uuid(),
  movementIds: z.array(z.int().positive()).min(1),
  statementDate: z.iso.date(),
  statementBalance: z.number(),
  expectedBankBalance: z.number(),
});
const classifiersSchema = z.strictObject({ revision: z.int().nonnegative(), values: z.array(z.string().trim().max(5)).length(9) });
const budgetsSchema = z.strictObject({ revision: z.int().nonnegative(), values: z.array(z.number()).length(12) });
const reviewSchema = z.strictObject({ revision: z.int().nonnegative(), movementIds: z.array(z.int().positive()).min(1) });
const transferSchema = z.strictObject({
  requestKey: z.uuid(), sourceBankAccountId: z.int().positive(), date: z.iso.date(), amount: z.number().positive(),
  reference: z.string().trim().max(10), beneficiary: z.string().trim().max(85), description: z.string().trim().max(90),
});

export class BankAccountsController {
  constructor(
    private readonly getBankAccount: GetBankAccount,
    private readonly getBankAccountByCode: GetBankAccountByCode,
    private readonly getFirstBankAccount: GetFirstBankAccount,
    private readonly searchBankAccounts: SearchBankAccounts,
    private readonly navigateBankAccount: NavigateBankAccount,
    private readonly getBankPanel: GetBankPanel,
    private readonly captureReconciliation: CaptureBankReconciliation,
    private readonly configurePanels: ConfigureBankPanels,
    private readonly captureTransfer: CaptureBankTransfer,
  ) {}

  search: RequestHandler = async (request, response, next) => {
    try {
      const query = searchSchema.parse(request.query);
      response.json(await this.searchBankAccounts.execute({
        ...(query.q === undefined ? {} : { query: query.q }),
        ...(query.code === undefined ? {} : { code: query.code }),
        ...(query.accountNumber === undefined ? {} : { accountNumber: query.accountNumber }),
        ...(query.name === undefined ? {} : { name: query.name }),
        page: query.page,
        pageSize: query.pageSize,
      }));
    } catch (error) { next(error); }
  };

  getById: RequestHandler = async (request, response, next) => {
    try {
      const { bankAccountId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.getBankAccount.execute(bankAccountId) });
    } catch (error) { next(error); }
  };

  getByCode: RequestHandler = async (request, response, next) => {
    try {
      const { code } = codeParamsSchema.parse(request.params);
      response.json({ data: await this.getBankAccountByCode.execute(code) });
    } catch (error) { next(error); }
  };

  getFirst: RequestHandler = async (_request, response, next) => {
    try {
      response.json({ data: await this.getFirstBankAccount.execute() });
    } catch (error) { next(error); }
  };

  getPrevious: RequestHandler = async (request, response, next) => {
    try {
      const { bankAccountId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.navigateBankAccount.execute(bankAccountId, 'previous') });
    } catch (error) { next(error); }
  };

  getNext: RequestHandler = async (request, response, next) => {
    try {
      const { bankAccountId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.navigateBankAccount.execute(bankAccountId, 'next') });
    } catch (error) { next(error); }
  };

  panel = (key: BankPanelKey): RequestHandler => async (request, response, next) => {
    try {
      const { bankAccountId } = idParamsSchema.parse(request.params);
      const options = panelQuerySchema.parse(request.query);
      response.json(await this.getBankPanel.execute(bankAccountId, key, options));
    } catch (error) { next(error); }
  };

  reconcile: RequestHandler = async (request, response, next) => {
    try {
      const { bankAccountId } = idParamsSchema.parse(request.params);
      const data = await this.captureReconciliation.save(1, bankAccountId, reconciliationSchema.parse(request.body));
      response.status(201).json({ data });
    } catch (error) { next(error); }
  };

  classify: RequestHandler = async (request, response, next) => {
    try {
      const { bankAccountId } = idParamsSchema.parse(request.params);
      const options = panelQuerySchema.parse(request.query);
      const { revision, values } = classifiersSchema.parse(request.body);
      response.json({ data: await this.configurePanels.classify(bankAccountId, revision, values, options) });
    } catch (error) { next(error); }
  };

  changeBudget = (byCostCenter: boolean): RequestHandler => async (request, response, next) => {
    try {
      const { bankAccountId } = idParamsSchema.parse(request.params);
      const options = panelQuerySchema.parse(request.query);
      const { revision, values } = budgetsSchema.parse(request.body);
      const data = await this.configurePanels.changeBudget(bankAccountId, revision, values, options, byCostCenter ? options.costCenter : '');
      response.json({ data });
    } catch (error) { next(error); }
  };

  review: RequestHandler = async (request, response, next) => {
    try {
      const { bankAccountId } = idParamsSchema.parse(request.params);
      const options = panelQuerySchema.parse(request.query);
      const { revision, movementIds } = reviewSchema.parse(request.body);
      response.json({ data: await this.configurePanels.review(bankAccountId, revision, movementIds, options) });
    } catch (error) { next(error); }
  };

  prepareTransfer: RequestHandler = async (request, response, next) => {
    try {
      const { bankAccountId } = idParamsSchema.parse(request.params);
      response.set('Cache-Control', 'no-store').json({ data: await this.captureTransfer.prepare(1, bankAccountId) });
    } catch (error) { next(error); }
  };

  transfer: RequestHandler = async (request, response, next) => {
    try {
      const { bankAccountId } = idParamsSchema.parse(request.params);
      const data = await this.captureTransfer.save(1, 0, bankAccountId, transferSchema.parse(request.body));
      response.status(201).json({ data });
    } catch (error) { next(error); }
  };
}
