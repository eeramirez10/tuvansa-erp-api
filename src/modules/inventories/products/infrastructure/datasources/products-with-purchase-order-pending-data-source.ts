import { purchaseOrderInventoryAdjustment } from '../../../../../shared/infrastructure/datasources/postgres-purchase-order-pending.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { effectivePepsCost, inventoryPepsCosts } from '../../../movements/infrastructure/datasources/postgres-inventory-peps-cost.js';
import { Product, type ProductProps } from '../../domain/entities/product.js';
import type {
  ProductCreateValues, ProductNavigationDirection, ProductRemovalConfirmation, ProductSearchCriteria, ProductWriteValues,
} from '../../domain/repositories/products-repository.js';
import { LegacyMysqlProductsDataSource } from './legacy-mysql-products-data-source.js';
import type { PostgresProductsDataSource } from './postgres-products-data-source.js';
import { localSalesProductStocks, type LocalSalesStock } from './local-sales-product-inventory.js';
import { catalogOtherData } from './product-catalog-references.js';
import {
  purchaseReceptionProductInventories, purchaseReceptionProductInventory, type ReceiptWarehouseTotals,
} from './purchase-reception-product-inventory.js';

async function receiptPepsPrices(product: ProductProps): Promise<ProductProps['prices'] | undefined> {
  const snapshot = (await inventoryPepsCosts([product.id])).get(product.id);
  if (!snapshot) return undefined;
  const current = product.prices.costs;
  const other = (await catalogOtherData([product.id])).get(product.id);
  const costs = effectivePepsCost({
    average: Number(other?.list4 ?? current.average), last: Number(other?.list5 ?? current.last), adValorem: current.adValorem,
  }, snapshot);
  return { ...product.prices, costs: { ...current, ...costs } };
}

function addReceiptInventory(
  accumulated: ProductProps['accumulated'], inventory: ReceiptWarehouseTotals[],
): ProductProps['accumulated'] {
  const stock = inventory.reduce((total, { quantity }) => total + quantity, 0);
  const lastPurchaseAt = inventory.reduce((latest, receipt) => {
    return receipt.lastPurchaseAt && (!latest || receipt.lastPurchaseAt > latest) ? receipt.lastPurchaseAt : latest;
  }, accumulated.lastPurchaseAt);
  return {
    ...accumulated,
    currentStock: Number((accumulated.currentStock + stock).toFixed(3)),
    lastPurchaseAt,
  };
}

function addSalesInventory(accumulated: ProductProps['accumulated'], stock?: LocalSalesStock): ProductProps['accumulated'] {
  if (!stock) return accumulated;
  let { currentStock, assigned, lastSaleAt } = accumulated;
  for (const row of stock.warehouses) {
    currentStock += row.quantity;
    assigned += row.assigned;
    if (row.lastSaleAt && (!lastSaleAt || row.lastSaleAt > lastSaleAt)) lastSaleAt = row.lastSaleAt;
  }
  return {
    ...accumulated, lastSaleAt, currentStock: Number(currentStock.toFixed(3)), assigned: Number(assigned.toFixed(3)),
    customerOrders: Number((accumulated.customerOrders + stock.ordered).toFixed(3)),
    customerQuotes: Number((accumulated.customerQuotes + stock.quoted).toFixed(3)),
  };
}

export class ProductsWithPurchaseOrderPendingDataSource extends LegacyMysqlProductsDataSource {
  constructor(private readonly catalog?: PostgresProductsDataSource) { super(); }

  private async postgresCatalog() {
    return this.catalog && await this.catalog.catalogWritable() ? this.catalog : null;
  }

  private async requireCatalog() {
    const catalog = await this.postgresCatalog();
    if (!catalog) throw new ApplicationError(
      'El catálogo PostgreSQL requiere una copia conciliada de PROSCAI.', 'PRODUCT_SNAPSHOT_REQUIRED', 503,
    );
    return catalog;
  }

  catalogWritable() { return this.catalog?.catalogWritable() ?? Promise.resolve(false); }
  override async listUnits() { return (await this.postgresCatalog())?.listUnits() ?? super.listUnits(); }
  override async codeExists(code: string, excludingId?: number) {
    return (await this.postgresCatalog())?.codeExists(code, excludingId) ?? super.codeExists(code, excludingId);
  }
  override async unitExists(unitId: number) {
    return (await this.postgresCatalog())?.unitExists(unitId) ?? super.unitExists(unitId);
  }
  override async accountingAccountExists(account: string) {
    return (await this.postgresCatalog())?.accountingAccountExists(account) ?? super.accountingAccountExists(account);
  }
  override async create(values: ProductCreateValues) { return (await this.requireCatalog()).create(values); }
  override async update(id: number, values: ProductWriteValues, revision?: string) {
    return (await this.requireCatalog()).update(id, values, revision);
  }
  override async delete(id: number, confirmation?: ProductRemovalConfirmation) {
    return (await this.requireCatalog()).delete(id, confirmation);
  }
  async removal(id: number) {
    const catalog = await this.postgresCatalog();
    if (catalog) return catalog.removal(id);
    const product = (await super.findById(id))?.toPrimitives();
    return product ? {
      id, code: product.code, revision: '0:0:0', canDelete: false,
      reason: 'El catálogo PostgreSQL requiere una copia conciliada de PROSCAI.',
    } : null;
  }

  private async withPending(request: Promise<Product | null>): Promise<Product | null> {
    const product = await request;
    if (!product) return null;
    const details = product.toPrimitives();
    const [{ pending, confirmed, quotes }, inventory, sales, prices] = await Promise.all([
      purchaseOrderInventoryAdjustment(details.id), purchaseReceptionProductInventory(details.id), localSalesProductStocks([details.id]),
      receiptPepsPrices(details),
    ]);
    if (pending === 0 && confirmed === 0 && quotes === 0 && inventory.length === 0 && sales.size === 0 && !prices) return product;
    const accumulated = addSalesInventory(addReceiptInventory(details.accumulated, inventory), sales.get(details.id));
    return Product.create({
      ...details,
      prices: prices ?? details.prices,
      accumulated: {
        ...accumulated,
        supplierOrders: Number((details.accumulated.supplierOrders + pending).toFixed(2)),
        supplierQuotes: Number((details.accumulated.supplierQuotes + quotes).toFixed(2)),
        confirmed: Number((details.accumulated.confirmed + confirmed).toFixed(3)),
      },
    });
  }

  override async findById(id: number) {
    return this.withPending((await this.postgresCatalog())?.findById(id) ?? super.findById(id));
  }
  override async findFirstActive() {
    return this.withPending((await this.postgresCatalog())?.findFirstActive() ?? super.findFirstActive());
  }
  override async findAdjacent(id: number, direction: ProductNavigationDirection) {
    return this.withPending((await this.postgresCatalog())?.findAdjacent(id, direction) ?? super.findAdjacent(id, direction));
  }

  override async search(criteria: ProductSearchCriteria, overrides?: ReadonlyMap<number, ProductWriteValues>) {
    const result = await ((await this.postgresCatalog())?.search(criteria) ?? super.search(criteria, overrides));
    const ids = result.items.map((item) => item.toPrimitives().id);
    const [inventory, sales] = await Promise.all([purchaseReceptionProductInventories(ids), localSalesProductStocks(ids)]);
    return { ...result, items: result.items.map((item) => {
      const props = item.toPrimitives();
      const totals = inventory.get(props.id);
      const stock = sales.get(props.id);
      return totals || stock ? Product.create({ ...props, accumulated: addSalesInventory(addReceiptInventory(props.accumulated, totals ?? []), stock) }) : item;
    }) };
  }
}
