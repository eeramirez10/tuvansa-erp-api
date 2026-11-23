import { Supplier } from '../../domain/entities/supplier.js';
import type { SupplierNavigationDirection, SupplierSearchCriteria } from '../../domain/repositories/suppliers-repository.js';
import { LegacyMysqlSuppliersDataSource } from './legacy-mysql-suppliers-data-source.js';
import { purchaseReceptionSupplierBalances } from './purchase-reception-supplier-charges.js';

function withBalance(supplier: Supplier, balance: number): Supplier {
  if (balance === 0) return supplier;
  const props = supplier.toPrimitives();
  const currentBalance = Number((props.totals.currentBalance + balance).toFixed(2));
  return Supplier.create({ ...props, totals: { ...props.totals, currentBalance } });
}

export class SuppliersWithPurchaseReceptionsDataSource extends LegacyMysqlSuppliersDataSource {
  private async withPurchaseReceptions(request: Promise<Supplier | null>) {
    const supplier = await request;
    if (!supplier) return null;
    const { id } = supplier.toPrimitives();
    const balances = await purchaseReceptionSupplierBalances([id]);
    return withBalance(supplier, balances.get(id) ?? 0);
  }

  override findById(supplierId: number) { return this.withPurchaseReceptions(super.findById(supplierId)); }
  override findFirst() { return this.withPurchaseReceptions(super.findFirst()); }
  override findAdjacent(supplierId: number, direction: SupplierNavigationDirection) {
    return this.withPurchaseReceptions(super.findAdjacent(supplierId, direction));
  }

  override async search(criteria: SupplierSearchCriteria) {
    const result = await super.search(criteria);
    const balances = await purchaseReceptionSupplierBalances(result.items.map((supplier) => supplier.toPrimitives().id));
    return {
      ...result,
      items: result.items.map((supplier) => withBalance(supplier, balances.get(supplier.toPrimitives().id) ?? 0)),
    };
  }
}
