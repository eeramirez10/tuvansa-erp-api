import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { RowDataPacket } from 'mysql2/promise';
import type { ProductPanelCriteria, ProductPanelKey } from '../../domain/repositories/product-panels-repository.js';
import { LegacyMysqlProductPanelsDataSource } from './legacy-mysql-product-panels-data-source.js';
import { purchaseReceptionProductInventory } from './purchase-reception-product-inventory.js';

interface WarehouseRow extends RowDataPacket {
  code: string;
  name: string;
}

export class ProductPanelsWithPurchaseReceptionsDataSource extends LegacyMysqlProductPanelsDataSource {
  override async getPanel(productId: number, panel: ProductPanelKey, criteria: ProductPanelCriteria) {
    const result = await super.getPanel(productId, panel, criteria);
    if (!result || panel !== 'warehouses') return result;

    const receipts = await purchaseReceptionProductInventory(productId);
    if (receipts.length === 0) return result;

    const quantities = new Map(receipts.map(({ warehouse, quantity }) => [warehouse, quantity]));
    const matchedWarehouses = new Set<string>();
    const items = result.items.map((row) => {
      const warehouse = String(row.warehouseCode ?? '').trim();
      const quantity = quantities.get(warehouse);
      if (quantity === undefined || matchedWarehouses.has(warehouse)) return row;
      matchedWarehouses.add(warehouse);
      return { ...row, quantity: Number((Number(row.quantity ?? 0) + quantity).toFixed(3)) };
    });
    const newWarehouses = receipts.filter(({ warehouse }) => !matchedWarehouses.has(warehouse));
    if (newWarehouses.length === 0) return { ...result, items };

    // Derivada. Conserva la descripción del catálogo para un almacén sin un registro FALM anterior.
    const [catalog] = await legacyMysqlPool.query<WarehouseRow[]>(
      'SELECT CATALM AS code, CATDESCR AS name FROM FALMCAT WHERE CATALM IN (?)',
      [newWarehouses.map(({ warehouse }) => warehouse)],
    );
    const names = new Map(catalog.map(({ code, name }) => [code.trim(), name]));
    items.push(...newWarehouses.map(({ warehouse, quantity }) => ({
      warehouseCode: warehouse, warehouseDescription: names.get(warehouse) ?? '', quantity,
    })));
    return { ...result, items };
  }
}
