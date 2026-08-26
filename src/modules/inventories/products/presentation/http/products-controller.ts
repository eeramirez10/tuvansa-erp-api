import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { CreateProduct } from '../../application/use-cases/create-product.js';
import type { DeleteProduct } from '../../application/use-cases/delete-product.js';
import type { GetProduct } from '../../application/use-cases/get-product.js';
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

const blockStatusBodySchema = z.object({ blocked: z.boolean() }).strict();

const nonnegativeNumber = z.number().nonnegative();
const priceSchema = z.object({
  amount: nonnegativeNumber.optional(),
  currencyId: z.number().int().nonnegative().optional(),
}).strict();

const mutationFields = {
  code: z.string().trim().min(1).max(13).optional(),
  description: z.string().trim().min(1).max(60).optional(),
  classification: z.object({
    type: z.enum(['rawMaterial', 'finishedProduct', 'set', 'assembly', 'service']).optional(),
    unitId: z.number().int().positive().optional(),
    familyCode: z.string().trim().max(16).optional(),
    hasPhoto: z.boolean().optional(),
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
};

const createProductBodySchema = z.object(mutationFields).strict().extend({
  code: z.string().trim().min(1).max(13),
  description: z.string().trim().min(1).max(60),
});

const updateProductBodySchema = z.object(mutationFields).strict().refine(
  (body) => Object.keys(toProductWriteValues(body)).length > 0,
  { message: 'Debe proporcionar al menos un campo para modificar' },
);

export class ProductsController {
  constructor(
    private readonly getProduct: GetProduct,
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

  delete: RequestHandler = async (request, response, next) => {
    try {
      const { productId } = productParamsSchema.parse(request.params);
      await this.deleteProduct.execute(productId);
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  };

  panel = (panel: ProductPanelKey): RequestHandler => async (request, response, next) => {
    try {
      const { productId } = productParamsSchema.parse(request.params);
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
