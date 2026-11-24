import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { RowDataPacket } from 'mysql2/promise';
import type { ProductPanelCriteria, ProductPanelKey, ProductPanelResult } from '../../domain/repositories/product-panels-repository.js';
import { LegacyMysqlProductPanelsDataSource } from './legacy-mysql-product-panels-data-source.js';
import { localProductLedger } from './local-product-ledger.js';
import { purchaseReceptionProductInventory } from './purchase-reception-product-inventory.js';
import { localSalesProductStocks } from './local-sales-product-inventory.js';
import { catalogProductsById, isNewCatalogProduct } from './product-catalog-references.js';

interface WarehouseRow extends RowDataPacket {
  code: string;
  name: string;
}

export class ProductPanelsWithPurchaseReceptionsDataSource extends LegacyMysqlProductPanelsDataSource {
  override async getPanel(productId: number, panel: ProductPanelKey, criteria: ProductPanelCriteria) {
    const localOnly = isNewCatalogProduct(productId) && (panel === 'warehouses' || panel === 'ledger');
    const result = localOnly ? await this.localCatalogPanel(productId, panel, criteria) : await super.getPanel(productId, panel, criteria);
    if (!result) return result;
    if (panel === 'ledger') {
      const { limit, offset, ledger } = criteria;
      const page = await localProductLedger(productId, ledger, limit - result.items.length, async () => {
        if (localOnly) return offset;
        if (offset === 0 || result.items.length > 0) return 0;
        return Math.max(0, offset - await this.countLedgerItems(productId, ledger));
      });
      return {
        ...result, items: [...result.items, ...page.items],
        ...(result.openingStock === undefined ? {} : { openingStock: result.openingStock + page.openingDelta }),
      };
    }
    if (panel !== 'warehouses') return result;

    const [receipts, allSales] = await Promise.all([purchaseReceptionProductInventory(productId), localSalesProductStocks([productId])]);
    const totals = new Map(receipts.map(({ warehouse, quantity }) => [warehouse, { warehouse, quantity, assigned: 0 }]));
    for (const { warehouse, quantity, assigned } of allSales.get(productId)?.warehouses ?? []) {
      totals.set(warehouse, { warehouse, quantity: (totals.get(warehouse)?.quantity ?? 0) + quantity, assigned });
    }
    if (totals.size === 0) return result;
    const matchedWarehouses = new Set<string>();
    const items = result.items.map((row) => {
      const warehouse = String(row.warehouseCode ?? '').trim();
      const stock = totals.get(warehouse);
      if (stock === undefined || matchedWarehouses.has(warehouse)) return row;
      matchedWarehouses.add(warehouse);
      return {
        ...row, quantity: Number((Number(row.quantity ?? 0) + stock.quantity).toFixed(3)),
        assigned: Number((Number(row.assigned ?? 0) + stock.assigned).toFixed(3)),
      };
    });
    const newWarehouses = [...totals.values()].filter(({ warehouse }) => !matchedWarehouses.has(warehouse));
    if (newWarehouses.length === 0) return { ...result, items };

    // Derivada. Conserva la descripción del catálogo para un almacén sin un registro FALM anterior.
    const [catalog] = await legacyMysqlPool.query<WarehouseRow[]>(
      'SELECT CATALM AS code, CATDESCR AS name FROM FALMCAT WHERE CATALM IN (?)',
      [newWarehouses.map(({ warehouse }) => warehouse)],
    );
    const names = new Map(catalog.map(({ code, name }) => [code.trim(), name]));
    items.push(...newWarehouses.map(({ warehouse, quantity, assigned }) => ({
      warehouseCode: warehouse, warehouseDescription: names.get(warehouse) ?? '', quantity, assigned,
    })));
    return { ...result, items };
  }

  private async localCatalogPanel(
    productId: number, panel: 'warehouses' | 'ledger', criteria: ProductPanelCriteria,
  ): Promise<ProductPanelResult | null> {
    const reference = (await catalogProductsById([productId])).get(productId);
    if (!reference || reference.deleted) return null;
    const { id, code, description } = reference.document;
    const ledger = panel === 'ledger';
    return {
      product: { id, code, description }, key: panel, section: ledger ? 'queries' : 'actions',
      button: ledger ? 'Auxiliar' : 'Almacenes', available: true, source: 'product-cache', items: [],
      ...(ledger && criteria.ledger?.warehouse !== undefined ? { openingStock: 0 } : {}),
    };
  }
}
