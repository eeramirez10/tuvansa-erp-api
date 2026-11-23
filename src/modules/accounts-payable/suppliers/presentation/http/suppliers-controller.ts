import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { CaptureSupplierPayment } from '../../application/use-cases/capture-supplier-payment.js';
import type { GetFirstSupplier } from '../../application/use-cases/get-first-supplier.js';
import type { GetSupplier } from '../../application/use-cases/get-supplier.js';
import type { NavigateSupplier } from '../../application/use-cases/navigate-supplier.js';
import type { SearchSuppliers } from '../../application/use-cases/search-suppliers.js';
import type { GetSupplierPanel } from '../../application/use-cases/get-supplier-panel.js';
import type { GetSupplierClassifications } from '../../application/use-cases/get-supplier-classifications.js';
import type { SupplierPanelKey } from '../../domain/repositories/supplier-panels-repository.js';

const supplierParamsSchema = z.object({
  supplierId: z.coerce.number().int().positive(),
});

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('all'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

const classificationQuerySchema = z.object({
  position: z.coerce.number().int().min(1).max(9).default(1),
});

const paymentParams = supplierParamsSchema.extend({ receiptId: z.coerce.number().int().positive() });
const paymentBody = z.strictObject({
  requestKey: z.uuid(),
  revision: z.int().positive(),
  bankAccountId: z.int().positive(),
  mode: z.enum(['transfer', 'check']),
  amount: z.number().positive(),
  date: z.iso.date(),
  description: z.string().trim().max(90),
});

export class SuppliersController {
  constructor(
    private readonly getSupplier: GetSupplier,
    private readonly getFirstSupplier: GetFirstSupplier,
    private readonly searchSuppliers: SearchSuppliers,
    private readonly navigateSupplier: NavigateSupplier,
    private readonly getSupplierPanel: GetSupplierPanel,
    private readonly getSupplierClassifications: GetSupplierClassifications,
    private readonly supplierPayment: CaptureSupplierPayment,
  ) {}

  search: RequestHandler = async (request, response, next) => {
    try {
      const query = searchQuerySchema.parse(request.query);
      response.json(await this.searchSuppliers.execute({
        ...(query.q === undefined ? {} : { query: query.q }),
        status: query.status,
        page: query.page,
        pageSize: query.pageSize,
      }));
    } catch (error) { next(error); }
  };

  getById: RequestHandler = async (request, response, next) => {
    try {
      const { supplierId } = supplierParamsSchema.parse(request.params);
      response.json({ data: await this.getSupplier.execute(supplierId) });
    } catch (error) { next(error); }
  };

  getFirst: RequestHandler = async (_request, response, next) => {
    try {
      response.json({ data: await this.getFirstSupplier.execute() });
    } catch (error) { next(error); }
  };

  getPrevious: RequestHandler = async (request, response, next) => {
    try {
      const { supplierId } = supplierParamsSchema.parse(request.params);
      response.json({ data: await this.navigateSupplier.execute(supplierId, 'previous') });
    } catch (error) { next(error); }
  };

  getNext: RequestHandler = async (request, response, next) => {
    try {
      const { supplierId } = supplierParamsSchema.parse(request.params);
      response.json({ data: await this.navigateSupplier.execute(supplierId, 'next') });
    } catch (error) { next(error); }
  };

  panel = (key: SupplierPanelKey): RequestHandler => async (request, response, next) => {
    try {
      const { supplierId } = supplierParamsSchema.parse(request.params);
      response.json(await this.getSupplierPanel.execute(supplierId, key));
    } catch (error) { next(error); }
  };

  getClassifications: RequestHandler = async (request, response, next) => {
    try {
      const { supplierId } = supplierParamsSchema.parse(request.params);
      const { position } = classificationQuerySchema.parse(request.query);
      response.json(await this.getSupplierClassifications.execute(supplierId, position));
    } catch (error) { next(error); }
  };

  preparePayment: RequestHandler = async (request, response, next) => {
    try {
      const identity = { companyId: 1, ...paymentParams.parse(request.params) };
      response.set('Cache-Control', 'no-store').json({ data: await this.supplierPayment.prepare(identity) });
    } catch (error) { next(error); }
  };

  createPayment: RequestHandler = async (request, response, next) => {
    try {
      const identity = { companyId: 1, ...paymentParams.parse(request.params) };
      const result = await this.supplierPayment.save(identity, 0, paymentBody.parse(request.body));
      response.status(201).json({ data: result });
    } catch (error) { next(error); }
  };
}
