import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { CreateProduct } from '../../application/use-cases/create-product.js';
import type { DeleteProduct } from '../../application/use-cases/delete-product.js';
import type { GetProduct } from '../../application/use-cases/get-product.js';
import type { GetFirstActiveProduct } from '../../application/use-cases/get-first-active-product.js';
import type { GetProductPanel } from '../../application/use-cases/get-product-panel.js';
import type { NavigateProduct } from '../../application/use-cases/navigate-product.js';
import type { SearchProducts } from '../../application/use-cases/search-products.js';
import type { UpdateProduct } from '../../application/use-cases/update-product.js';
import type { SetProductBlockStatus } from '../../application/use-cases/set-product-block-status.js';
import { toProductWriteValues } from '../../application/dtos/product-mutation-input.js';
import type { ProductPanelKey } from '../../domain/repositories/product-panels-repository.js';

const productParamsSchema = z.object({
  productId: z.coerce.number().int().positive(),
});

const productCodeSchema = z.string().trim().min(1).max(13);
const codeAvailabilityQuerySchema = z.object({ code: productCodeSchema });
const removalConfirmationSchema = z.object({
  code: productCodeSchema,
  revision: z.string().max(32).regex(/^\d+:\d+:\d+$/),
}).strict();

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('all'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

const panelQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(500).default(100),
});

const ledgerQuerySchema = panelQuerySchema.extend({
  warehouse: z.string().max(16).optional(),
  movementType: z.literal('R').optional(),
  openingMovementType: z.literal('R').optional(),
  lotId: z.coerce.number().int().positive().optional(),
}).refine(
  ({ warehouse, movementType, openingMovementType }) =>
    openingMovementType === undefined || (warehouse !== undefined && movementType === 'R'),
  { message: 'El tipo para el saldo inicial requiere filtrar por almacén y por tipo.' },
).refine(
  ({ lotId, openingMovementType }) => lotId === undefined || openingMovementType === undefined,
  { message: 'El saldo inicial por tipo corresponde al auxiliar de almacén.' },
);

const fulfillmentQuerySchema = panelQuerySchema.extend({
  excludeFulfilled: z.enum(['true', 'false']).optional(),
});
const classifiedOrdersQuerySchema = panelQuerySchema.extend({
  classifier: z.coerce.number().int().min(1).max(9).optional(),
  sort: z.enum(['code', 'name', 'order', 'date']).optional(),
});
const customerSalesQuerySchema = panelQuerySchema.extend({
  sort: z.enum(['code', 'name', 'quantity', 'amount']).optional(),
});
const classifiedSalesQuerySchema = customerSalesQuerySchema.extend({
  classifier: z.coerce.number().int().min(1).max(9).optional(),
});
const branchSalesQuerySchema = panelQuerySchema.extend({
  sort: z.enum(['branch', 'code', 'name', 'quantity', 'amount']).optional(),
});

const blockStatusBodySchema = z.object({ blocked: z.boolean() }).strict();

const nonnegativeNumber = z.number().nonnegative();
const priceSchema = z.object({
  amount: nonnegativeNumber.optional(),
  currencyId: z.number().int().nonnegative().optional(),
}).strict();

const mutationFields = {
  code: productCodeSchema.optional(),
  description: z.string().trim().min(1).max(60).optional(),
  classification: z.object({
    type: z.enum(['rawMaterial', 'finishedProduct', 'set', 'assembly', 'service']).optional(),
    unitId: z.number().int().positive().optional(),
    familyCode: z.string().trim().max(16).optional(),
    hasPhoto: z.boolean().optional(),
    usesColorAndSize: z.boolean().optional(),
  }).strict().optional(),
  prices: z.object({
    sale: z.tuple([priceSchema, priceSchema, priceSchema]).optional(),
    costs: z.object({
      average: nonnegativeNumber.optional(),
      last: nonnegativeNumber.optional(),
      previous: nonnegativeNumber.optional(),
      currencyId: z.number().int().nonnegative().optional(),
      adValorem: nonnegativeNumber.optional(),
    }).strict().optional(),
  }).strict().optional(),
  warehouse: z.object({
    minimum: nonnegativeNumber.optional(),
    maximum: nonnegativeNumber.optional(),
    location: z.string().trim().max(30).optional(),
    ean: z.string().trim().max(30).optional(),
    upc: z.string().trim().max(13).optional(),
    accounts: z.object({
      primary: z.string().trim().max(16).optional(),
      secondary: z.string().trim().max(16).optional(),
      costOfSales: z.string().trim().max(16).optional(),
    }).strict().optional(),
  }).strict().optional(),
  accumulated: z.object({
    salesLastSixWeeks: z.number().int().min(0).max(2_147_483_647).optional(),
    inventoryDays: z.number().int().min(0).max(2_147_483_647).optional(),
  }).strict().optional(),
};

const createProductBodySchema = z.object(mutationFields).strict().extend({
  code: productCodeSchema,
  description: z.string().trim().min(1).max(60),
});

const saleAmount = z.number().min(0).max(Number.MAX_SAFE_INTEGER / 10_000).multipleOf(0.0001);
const costAmount = z.number().min(-Number.MAX_SAFE_INTEGER / 10_000)
  .max(Number.MAX_SAFE_INTEGER / 10_000).multipleOf(0.0001);
const currency = z.number().int().min(0).max(2_147_483_647);
const editablePriceSchema = z.object({ amount: saleAmount.optional(), currencyId: currency.optional() }).strict();

const updateProductBodySchema = z.object({
  ...mutationFields,
  revision: z.string().max(32).regex(/^\d+:\d+:\d+$/),
  classification: mutationFields.classification.unwrap().extend({
    familyCode: z.string().trim().toUpperCase().max(16).optional(),
  }).optional(),
  prices: z.object({
    sale: z.tuple([editablePriceSchema, editablePriceSchema, editablePriceSchema]).optional(),
    costs: z.object({
      average: costAmount.optional(), last: costAmount.optional(), previous: costAmount.optional(),
      currencyId: currency.optional(), adValorem: nonnegativeNumber.multipleOf(0.01).optional(),
    }).strict().optional(),
  }).strict().optional(),
  warehouse: mutationFields.warehouse.unwrap().extend({
    minimum: nonnegativeNumber.int().optional(),
    maximum: nonnegativeNumber.int().optional(),
    location: z.string().trim().toUpperCase().max(30).optional(),
    ean: z.string().trim().toUpperCase().max(30).optional(),
    upc: z.string().trim().toUpperCase().max(13).optional(),
  }).optional(),
}).strict().refine(
  (body) => Object.keys(toProductWriteValues(body)).length > 0,
  { message: 'Debe proporcionar al menos un campo para modificar' },
);

export class ProductsController {
  constructor(
    private readonly getProduct: GetProduct,
    private readonly getFirstActiveProduct: GetFirstActiveProduct,
    private readonly searchProducts: SearchProducts,
    private readonly navigateProduct: NavigateProduct,
    private readonly createProduct: CreateProduct,
    private readonly updateProduct: UpdateProduct,
    private readonly deleteProduct: DeleteProduct,
    private readonly getProductPanel: GetProductPanel,
    private readonly setProductBlockStatus: SetProductBlockStatus,
  ) {}

  search: RequestHandler = async (request, response, next) => {
    try {
      const query = searchQuerySchema.parse(request.query);
      response.json(await this.searchProducts.execute({
        ...(query.q === undefined ? {} : { query: query.q }),
        status: query.status,
        page: query.page,
        pageSize: query.pageSize,
      }));
    } catch (error) {
      next(error);
    }
  };

  getById: RequestHandler = async (request, response, next) => {
    try {
      const { productId } = productParamsSchema.parse(request.params);
      response.json({ data: await this.getProduct.execute(productId) });
    } catch (error) {
      next(error);
    }
  };

  getFirstActive: RequestHandler = async (_request, response, next) => {
    try {
      response.json({ data: await this.getFirstActiveProduct.execute() });
    } catch (error) {
      next(error);
    }
  };

  getPrevious: RequestHandler = async (request, response, next) => {
    try {
      const { productId } = productParamsSchema.parse(request.params);
      response.json({ data: await this.navigateProduct.execute(productId, 'previous') });
    } catch (error) {
      next(error);
    }
  };

  getNext: RequestHandler = async (request, response, next) => {
    try {
      const { productId } = productParamsSchema.parse(request.params);
      response.json({ data: await this.navigateProduct.execute(productId, 'next') });
    } catch (error) {
      next(error);
    }
  };

  getCodeAvailability: RequestHandler = async (request, response, next) => {
    try {
      const { code } = codeAvailabilityQuerySchema.parse(request.query);
      const available = await this.createProduct.isCodeAvailable(code);
      response.set('Cache-Control', 'no-store').json({ data: { available } });
    } catch (error) {
      next(error);
    }
  };

  create: RequestHandler = async (request, response, next) => {
    try {
      const input = createProductBodySchema.parse(request.body);
      response.status(201).json({ data: await this.createProduct.execute(input) });
    } catch (error) {
      next(error);
    }
  };

  update: RequestHandler = async (request, response, next) => {
    try {
      const { productId } = productParamsSchema.parse(request.params);
      const input = updateProductBodySchema.parse(request.body);
      response.json({ data: await this.updateProduct.execute(productId, input) });
    } catch (error) {
      next(error);
    }
  };

  getEditOptions: RequestHandler = async (request, response, next) => {
    try {
      const { productId } = productParamsSchema.parse(request.params);
      response.json({ data: await this.updateProduct.options(productId) });
    } catch (error) {
      next(error);
    }
  };

  getCreateOptions: RequestHandler = async (_request, response, next) => {
    try {
      response.json({ data: await this.createProduct.options() });
    } catch (error) {
      next(error);
    }
  };

  getRemoval: RequestHandler = async (request, response, next) => {
    try {
      const { productId } = productParamsSchema.parse(request.params);
      response.json({ data: await this.deleteProduct.preview(productId) });
    } catch (error) {
      next(error);
    }
  };

  delete: RequestHandler = async (request, response, next) => {
    try {
      const { productId } = productParamsSchema.parse(request.params);
      await this.deleteProduct.execute(productId, removalConfirmationSchema.parse(request.body));
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  };

  panel = (panel: ProductPanelKey): RequestHandler => async (request, response, next) => {
    try {
      const { productId } = productParamsSchema.parse(request.params);
      if (panel === 'ledger') {
        const { page, pageSize, ...ledger } = ledgerQuerySchema.parse(request.query);
        response.json(await this.getProductPanel.execute(productId, panel, page, pageSize, { ledger }));
        return;
      }
      if (panel === 'customer-orders' || panel === 'customer-quotes' || panel === 'supplier-orders') {
        const { page, pageSize, excludeFulfilled } = fulfillmentQuerySchema.parse(request.query);
        response.json(await this.getProductPanel.execute(productId, panel, page, pageSize, {
          excludeFulfilled: excludeFulfilled === 'true',
        }));
        return;
      }
      if (panel === 'customer-orders-star') {
        const { page, pageSize, classifier, sort } = classifiedOrdersQuerySchema.parse(request.query);
        response.json(await this.getProductPanel.execute(productId, panel, page, pageSize, {
          customerClassifier: classifier,
          customerOrderSort: sort,
        }));
        return;
      }
      if (panel === 'customer-sales' || panel === 'sales-by-branch') {
        const { page, pageSize, sort } = (panel === 'sales-by-branch'
          ? branchSalesQuerySchema : customerSalesQuerySchema).parse(request.query);
        response.json(await this.getProductPanel.execute(productId, panel, page, pageSize, { customerSalesSort: sort }));
        return;
      }
      if (panel === 'customer-sales-star') {
        const { page, pageSize, classifier, sort } = classifiedSalesQuerySchema.parse(request.query);
        response.json(await this.getProductPanel.execute(productId, panel, page, pageSize, {
          customerClassifier: classifier,
          customerSalesSort: sort,
        }));
        return;
      }
      const { page, pageSize } = panelQuerySchema.parse(request.query);
      response.json(await this.getProductPanel.execute(productId, panel, page, pageSize));
    } catch (error) {
      next(error);
    }
  };

  setBlockStatus: RequestHandler = async (request, response, next) => {
    try {
      const { productId } = productParamsSchema.parse(request.params);
      const { blocked } = blockStatusBodySchema.parse(request.body);
      response.json({ data: await this.setProductBlockStatus.execute(productId, blocked) });
    } catch (error) {
      next(error);
    }
  };
}
