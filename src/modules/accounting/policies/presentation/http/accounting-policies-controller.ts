import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { GetAccountingPolicyByNumber } from '../../application/use-cases/get-accounting-policy-by-number.js';
import type { GetAccountingPolicyClassifications } from '../../application/use-cases/get-accounting-policy-classifications.js';
import type { GetAccountingPolicy } from '../../application/use-cases/get-accounting-policy.js';
import type { NavigateAccountingPolicy } from '../../application/use-cases/navigate-accounting-policy.js';
import type { SearchAccountingPolicies } from '../../application/use-cases/search-accounting-policies.js';

const idParamsSchema = z.object({ policyId: z.coerce.number().int().positive() });
const numberParamsSchema = z.object({ policyNumber: z.string().trim().min(1).max(20) });
const searchSchema = z.object({
  q: z.string().trim().min(1).optional(),
  number: z.string().trim().min(1).max(20).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  applied: z.stringbool().optional(),
  family: z.string().trim().min(1).max(50).optional(),
  cheque: z.string().trim().min(1).max(30).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

export class AccountingPoliciesController {
  constructor(
    private readonly getPolicy: GetAccountingPolicy,
    private readonly getByNumber: GetAccountingPolicyByNumber,
    private readonly searchPolicies: SearchAccountingPolicies,
    private readonly navigatePolicy: NavigateAccountingPolicy,
    private readonly getClassifications: GetAccountingPolicyClassifications,
  ) {}

  search: RequestHandler = async (request, response, next) => {
    try {
      const query = searchSchema.parse(request.query);
      response.json(await this.searchPolicies.execute({
        ...(query.q === undefined ? {} : { query: query.q }),
        ...(query.number === undefined ? {} : { number: query.number }),
        ...(query.date === undefined ? {} : { date: query.date }),
        ...(query.applied === undefined ? {} : { applied: query.applied }),
        ...(query.family === undefined ? {} : { family: query.family }),
        ...(query.cheque === undefined ? {} : { cheque: query.cheque }),
        page: query.page,
        pageSize: query.pageSize,
      }));
    } catch (error) { next(error); }
  };

  getById: RequestHandler = async (request, response, next) => {
    try {
      const { policyId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.getPolicy.execute(policyId) });
    } catch (error) { next(error); }
  };

  getByNumberHandler: RequestHandler = async (request, response, next) => {
    try {
      const { policyNumber } = numberParamsSchema.parse(request.params);
      response.json({ data: await this.getByNumber.execute(policyNumber) });
    } catch (error) { next(error); }
  };

  previous: RequestHandler = async (request, response, next) => {
    try {
      const { policyId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.navigatePolicy.execute(policyId, 'previous') });
    } catch (error) { next(error); }
  };

  next: RequestHandler = async (request, response, next) => {
    try {
      const { policyId } = idParamsSchema.parse(request.params);
      response.json({ data: await this.navigatePolicy.execute(policyId, 'next') });
    } catch (error) { next(error); }
  };

  classifications: RequestHandler = async (request, response, next) => {
    try {
      const { policyId } = idParamsSchema.parse(request.params);
      response.json(await this.getClassifications.execute(policyId));
    } catch (error) { next(error); }
  };
}
