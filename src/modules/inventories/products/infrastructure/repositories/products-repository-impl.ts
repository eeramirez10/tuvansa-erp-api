import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { Product } from '../../domain/entities/product.js';
import {
  productCatalogEditRevision,
  type ProductCatalogEditDataSource,
  type ProductCatalogEditRules,
  type ProductCatalogEditSnapshot,
  type ProductCatalogUnit,
} from '../../domain/datasources/product-catalog-edit-data-source.js';
import type { ProductsDataSource } from '../../domain/datasources/products-data-source.js';
import type { ProductClassificationRepository } from '../../domain/repositories/product-classification-repository.js';
import type { ProductOtherDataRepository } from '../../domain/repositories/product-other-data-repository.js';
import type {
  DeleteProductResult,
  ProductCreateValues,
  ProductNavigationDirection,
  ProductSearchCriteria,
  ProductSearchResult,
  ProductsRepository,
  ProductWriteValues,
} from '../../domain/repositories/products-repository.js';

const costFields = ['averageCost', 'lastCost', 'previousCost', 'costCurrency', 'adValorem'];
const editableFields = ({ hideCosts }: ProductCatalogEditRules) => [
  'description', 'type', 'unitId', 'familyCode', 'usesColorAndSize',
  'salePrice1', 'salePrice2', 'salePrice3', 'saleCurrency1', 'saleCurrency2', 'saleCurrency3',
  ...(hideCosts ? [] : costFields),
  'minimum', 'maximum', 'location', 'ean', 'upc', 'primaryAccount', 'secondaryAccount', 'costOfSalesAccount',
  'salesLastSixWeeks', 'inventoryDays',
];
const defaultRules: ProductCatalogEditRules = { hideCosts: false, hasComponents: false, assemblyTypeOverride: false };

export class ProductsRepositoryImpl implements ProductsRepository {
  constructor(
    private readonly dataSource: ProductsDataSource,
    private readonly classification?: Pick<ProductClassificationRepository, 'get'>,
    private readonly otherData?: Pick<ProductOtherDataRepository, 'get'>,
    private readonly edits?: ProductCatalogEditDataSource,
  ) {}

  private async withPilotValues(product: Product | null, savedEdit?: ProductCatalogEditSnapshot): Promise<Product | null> {
    if (!product) return null;
    const details = product.toPrimitives();
    const edit = savedEdit ?? await this.edits?.get(details.id);
    const [classification, otherData] = edit
      ? [edit.classification, edit.otherData]
      : await Promise.all([this.classification?.get(details.id), this.otherData?.get(details.id)]);
    const changes = otherData?.changes;
    const familyCode = classification?.familyCode;
    if (!edit && familyCode == null && !changes) return product;

    const local = edit?.changes;
    let unit = details.classification.unit;
    if (local?.unitId !== undefined) {
      const selected = unit.id === local.unitId
        ? unit : (await this.listUnits()).find((candidate) => candidate.id === local.unitId);
      if (selected?.code) unit = {
        ...selected, catalogOption: { code: selected.code, description: selected.description },
      };
    }
    const rules = edit ? await this.rules(details.code, unit.id) : defaultRules;

    const costs = details.prices.costs;
    const [sale1, sale2, sale3] = details.prices.sale;
    const salesLastSixWeeks = local?.salesLastSixWeeks;
    return Product.create({
      ...details,
      ...(edit ? { editing: { writable: true, revision: productCatalogEditRevision(edit), editableFields: editableFields(rules) } } : {}),
      description: local?.description ?? details.description,
      classification: {
        ...details.classification, unit,
        type: local?.type ?? details.classification.type,
        familyCode: familyCode ?? details.classification.familyCode,
        usesColorAndSize: local?.usesColorAndSize ?? details.classification.usesColorAndSize,
      },
      warehouse: {
        ...details.warehouse,
        minimum: local?.minimum ?? details.warehouse.minimum,
        maximum: local?.maximum ?? details.warehouse.maximum,
        location: typeof changes?.location === 'string' ? changes.location : details.warehouse.location,
        ean: local?.ean ?? details.warehouse.ean,
        upc: local?.upc ?? details.warehouse.upc,
        accounts: {
          primary: local?.primaryAccount ?? details.warehouse.accounts.primary,
          secondary: local?.secondaryAccount ?? details.warehouse.accounts.secondary,
          costOfSales: local?.costOfSalesAccount ?? details.warehouse.accounts.costOfSales,
        },
      },
      prices: {
        ...details.prices,
        sale: [
          { amount: local?.salePrice1 ?? sale1.amount, currencyId: local?.saleCurrency1 ?? sale1.currencyId },
          { amount: local?.salePrice2 ?? sale2.amount, currencyId: local?.saleCurrency2 ?? sale2.currencyId },
          { amount: local?.salePrice3 ?? sale3.amount, currencyId: local?.saleCurrency3 ?? sale3.currencyId },
        ],
        costs: {
          average: typeof changes?.list4 === 'number' ? changes.list4 : costs.average,
          last: typeof changes?.list5 === 'number' ? changes.list5 : costs.last,
          previous: typeof changes?.list6 === 'number' ? changes.list6 : costs.previous,
          currencyId: typeof changes?.currency6 === 'number' ? changes.currency6 : costs.currencyId,
          adValorem: local?.adValorem ?? costs.adValorem,
        },
      },
      accumulated: {
        ...details.accumulated,
        ...(salesLastSixWeeks === undefined ? {} : { salesLastSixWeeks, salesLastSixMonths: salesLastSixWeeks }),
        inventoryDays: local?.inventoryDays ?? details.accumulated.inventoryDays,
      },
    });
  }

  private async rules(code: string, unitId: number): Promise<ProductCatalogEditRules> {
    return await this.dataSource.getEditRules?.(code, unitId) ?? defaultRules;
  }

  listUnits(): Promise<ProductCatalogUnit[]> {
    return this.dataSource.listUnits?.() ?? Promise.resolve([]);
  }

  async findById(productId: number): Promise<Product | null> {
    return this.withPilotValues(await this.dataSource.findById(productId));
  }

  async findFirstActive(): Promise<Product | null> {
    return this.withPilotValues(await this.dataSource.findFirstActive());
  }

  async search(criteria: ProductSearchCriteria): Promise<ProductSearchResult> {
    const overrides = criteria.query === undefined ? undefined : await this.edits?.searchOverrides();
    const result = await this.dataSource.search(criteria, overrides);
    const items = await Promise.all(result.items.map(async (product) => {
      if (!this.edits?.writable(product.toPrimitives().id)) return product;
      return await this.withPilotValues(product) ?? product;
    }));
    return { ...result, items };
  }

  async findAdjacent(
    productId: number,
    direction: ProductNavigationDirection,
  ): Promise<Product | null> {
    return this.withPilotValues(await this.dataSource.findAdjacent(productId, direction));
  }

  codeExists(code: string, excludingProductId?: number): Promise<boolean> {
    return excludingProductId === undefined
      ? this.dataSource.codeExists(code)
      : this.dataSource.codeExists(code, excludingProductId);
  }

  unitExists(unitId: number): Promise<boolean> {
    return this.dataSource.unitExists(unitId);
  }

  accountingAccountExists(account: string): Promise<boolean> {
    return this.dataSource.accountingAccountExists(account);
  }

  create(values: ProductCreateValues): Promise<Product> {
    return this.dataSource.create(values);
  }

  async update(productId: number, values: ProductWriteValues, revision?: string): Promise<Product | null> {
    if (!this.edits?.writable(productId)) {
      throw new ApplicationError('Este producto está fuera del piloto de edición del catálogo.', 'PRODUCT_EDIT_READ_ONLY', 403);
    }
    if (revision === undefined) {
      throw new ConflictError('Vuelve a abrir la ficha para obtener su revisión actual.', 'PRODUCT_EDIT_STALE');
    }
    const product = await this.dataSource.findById(productId);
    if (!product) return null;
    const details = product.toPrimitives();
    const { code, ...requested } = values;
    if (code !== undefined && code !== details.code) {
      throw new ApplicationError('El cambio de código requiere migrar las referencias de inventarios.', 'PRODUCT_CODE_READ_ONLY', 422);
    }
    const snapshot = await this.edits.get(productId);
    if (productCatalogEditRevision(snapshot) !== revision) {
      throw new ConflictError('La ficha del producto cambió en otra sesión. Vuelve a abrirla antes de guardar.', 'PRODUCT_EDIT_STALE');
    }
    if (!Object.keys(requested).length) return this.withPilotValues(product);

    const unitId = requested.unitId ?? snapshot?.changes.unitId ?? details.classification.unit.id;
    const rules = await this.rules(details.code, unitId);
    const supported = editableFields(rules);
    for (const field of Object.keys(requested)) {
      if (!supported.includes(field)) throw new ApplicationError(
        `El campo ${field} está en modo de consulta para esta ficha.`, 'PRODUCT_FIELD_READ_ONLY', 422,
      );
    }

    const { familyCode, averageCost, lastCost, previousCost, costCurrency, location, ...catalog } = requested;
    const currentUnit = details.classification.unit;
    const selectedUnit = unitId === currentUnit.id
      ? currentUnit : (await this.listUnits()).find((unit) => unit.id === unitId);
    const saved = await this.edits.save(productId, revision, {
      catalog: {
        ...catalog,
        ...(selectedUnit?.code ? { unitId } : {}),
        ...(rules.assemblyTypeOverride && rules.hasComponents ? { type: 'set' } : {}),
      },
      ...(familyCode === undefined ? {} : { familyCode }),
      otherData: {
        ...(averageCost === undefined ? {} : { list4: averageCost }),
        ...(lastCost === undefined ? {} : { list5: lastCost }),
        ...(previousCost === undefined ? {} : { list6: previousCost }),
        ...(costCurrency === undefined ? {} : { currency6: costCurrency }),
        ...(location === undefined ? {} : { location }),
        ...(rules.colorCode === undefined ? {} : { colorCode: rules.colorCode }),
        ...(rules.rowCode === undefined ? {} : { rowCode: rules.rowCode }),
        ...(selectedUnit?.code ? { unit: selectedUnit.code } : {}),
      },
    });
    return this.withPilotValues(product, saved);
  }

  delete(productId: number): Promise<DeleteProductResult> {
    return this.dataSource.delete(productId);
  }
}
