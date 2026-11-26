import { Router } from 'express';
import { z } from 'zod';
import { noSessionCache, requireSessionOrigin, sessionToken } from '../../../../general-data/users/presentation/web-session-http.js';
import { getCompanyContext } from '../../../../companies/application/company-catalog.js';
import type { CaptureOrder } from '../../application/use-cases/capture-order.js';

const productCode = z.string().trim().min(1).max(13);
const productIdentifier = z.string().trim().min(1).max(30);
const date = z.iso.date();
const companyQuery = z.object({ companyId: z.coerce.number().int().positive().default(1) });
const captureCompanyId = (query: unknown) => getCompanyContext(companyQuery.parse(query).companyId).company.id;
export const captureInputSchema = z.object({
  warehouse: z.string().trim().min(1).max(6), typeCode: z.literal('P'),
  customerCode: z.string().trim().min(1).max(6), customerOrderNumber: z.string().trim().max(30).default(''),
  orderedAt: date, from: date, dueAt: date, department: z.string().trim().max(20).default(''),
  initial: z.boolean().default(false), agentCode: z.string().trim().min(1).max(5),
  termsDays: z.number().int().min(0).max(999), store: z.string().trim().max(4),
  observations: z.string().max(21).default(''), documentKind: z.enum(['order', 'quote']).default('quote'),
  exchangeRate: z.number().positive().max(999999).default(1),
  boxes: z.number().int().nonnegative().max(999999).default(0),
  branch: z.number().int().nonnegative().max(999999).default(0),
  collectionCurrency: z.enum(['PESOS', 'DOLARES']).default('PESOS'),
  orderDiscounts: z.tuple([
    z.number().min(0).max(100).multipleOf(0.01), z.number().min(0).max(100).multipleOf(0.01),
    z.number().min(0).max(100).multipleOf(0.01), z.number().min(0).max(100).multipleOf(0.01),
  ]).default([0, 0, 0, 0]),
  commission: z.number().min(0).max(100).multipleOf(0.01).default(0),
  noPartialDeliveries: z.boolean().default(false),
  transportation: z.string().trim().max(100).default(''),
  deliveryAddress: z.tuple([z.string().max(100), z.string().max(100), z.string().max(100)]).default(['', '', '']),
  contact: z.string().trim().max(100).default(''),
  additionalComments: z.string().max(2000).default(''),
  lines: z.array(z.object({
    productCode, quantity: z.number().positive().max(999999).multipleOf(0.001),
    price: z.number().nonnegative().max(999999999).multipleOf(0.00001),
    discount: z.number().min(0).max(100).multipleOf(0.01).default(0),
    currencyId: z.union([z.literal(1), z.literal(2)]).optional(),
  }).strict()).min(1).max(500),
}).strict().refine(v => v.from <= v.dueAt, { message: 'Desde no puede ser posterior a Vence', path: ['dueAt'] });

export const createOrderCaptureRouter = (useCase: CaptureOrder): Router => {
  const router = Router();
  router.get('/capture/options', async (req, res, next) => {
    try { res.json({ data: await useCase.options(captureCompanyId(req.query)) }); } catch (error) { next(error); }
  });
  router.get('/capture/customers', async (req, res, next) => {
    try {
      const query = z.object({
        query: z.string().trim().min(1).max(100).optional(),
        code: z.string().trim().min(1).max(20).optional(),
        name: z.string().trim().min(1).max(100).optional(),
        taxId: z.string().trim().min(1).max(20).optional(),
        limit: z.coerce.number().int().positive().max(100).default(50),
      }).refine(value => value.query || value.code || value.name || value.taxId, {
        message: 'Captura código, nombre o RFC',
      }).parse(req.query);
      const searchCode = query.code ?? query.query;
      res.json({ data: await useCase.searchCustomers({
        ...(searchCode ? { code: searchCode } : {}),
        ...(query.name ? { name: query.name } : {}),
        ...(query.taxId ? { taxId: query.taxId } : {}),
      }, query.limit) });
    } catch (error) { next(error); }
  });
  router.get('/capture/customers/:code', async (req, res, next) => {
    try { res.json({ data: await useCase.customer(z.string().trim().min(1).max(6).parse(req.params.code)) }); } catch (error) { next(error); }
  });
  router.get('/capture/product-families', async (_req, res, next) => {
    try { res.json({ data: await useCase.productFamilies() }); } catch (error) { next(error); }
  });
  router.get('/capture/products', async (req, res, next) => {
    try {
      const query = z.object({
        warehouse: z.string().trim().min(1).max(6),
        query: z.string().trim().min(1).max(100).optional(),
        code: z.string().trim().min(1).max(30).optional(),
        description: z.string().trim().min(1).max(100).optional(),
        supplierCode: z.string().trim().min(1).max(30).optional(),
        familyPattern: z.string().length(13).optional(),
        exactCode: productCode.optional(),
        codePrefix: productCode.optional(),
        limit: z.coerce.number().int().positive().max(100).default(50),
      }).refine(value => value.query || value.code || value.description || value.supplierCode
        || value.familyPattern || value.exactCode || value.codePrefix, {
        message: 'Captura código, descripción o código de proveedor',
      }).parse(req.query);
      const searchCode = query.code ?? query.query;
      res.json({ data: await useCase.searchProducts({
        ...(searchCode ? { code: searchCode } : {}),
        ...(query.description ? { description: query.description } : {}),
        ...(query.supplierCode ? { supplierCode: query.supplierCode } : {}),
        ...(query.familyPattern ? { familyPattern: query.familyPattern } : {}),
        ...(query.exactCode ? { exactCode: query.exactCode } : {}),
        ...(query.codePrefix ? { codePrefix: query.codePrefix } : {}),
      }, query.warehouse, query.limit) });
    } catch (error) { next(error); }
  });
  router.get('/capture/products/:code', async (req, res, next) => {
    try {
      const query = z.object({ warehouse: z.string().trim().min(1).max(6), typeCode: z.literal('P'), customerCode: z.string().trim().min(1).max(6) }).parse(req.query);
      res.json({ data: await useCase.product(productIdentifier.parse(req.params.code), query.warehouse, query.typeCode, query.customerCode) });
    } catch (error) { next(error); }
  });
  router.post('/capture', async (req, res, next) => {
    try {
      const companyId = captureCompanyId(req.query);
      const input = captureInputSchema.parse(req.body);
      res.status(201).json({ data: await useCase.create({ ...input, companyId }) });
    } catch (error) { next(error); }
  });
  router.post('/:orderId/actions/quote-conversion', async (req, res, next) => {
    try {
      z.object({}).strict().parse(req.body ?? {});
      res.json({ data: await useCase.convertQuote(z.coerce.number().int().positive().parse(req.params.orderId)) });
    } catch (error) { next(error); }
  });
  router.post('/:orderId/actions/authorization', noSessionCache, async (req, res, next) => {
    try {
      requireSessionOrigin(req);
      const body = z.strictObject({ authorized: z.boolean(), revision: z.int().nonnegative() }).parse(req.body);
      res.json({ data: await useCase.setAuthorization(z.coerce.number().int().positive().parse(req.params.orderId), body, sessionToken(req)) });
    } catch (error) { next(error); }
  });
  router.post('/:orderId/actions/assignment', async (req, res, next) => {
    try {
      const body = z.object({ lines: z.array(z.object({
        lineId: z.number().int().positive(), assigned: z.number().nonnegative().multipleOf(0.001),
      }).strict()).min(1).max(500) }).strict().parse(req.body);
      res.json({ data: await useCase.setAssignment(z.coerce.number().int().positive().parse(req.params.orderId), body.lines) });
    } catch (error) { next(error); }
  });
  return router;
};
