import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { RowDataPacket } from 'mysql2/promise';
import type { ProductPanelCriteria, ProductPanelKey, ProductPanelResult } from '../../domain/repositories/product-panels-repository.js';
import { LegacyMysqlProductPanelsDataSource } from './legacy-mysql-product-panels-data-source.js';
import { localProductLedger } from './local-product-ledger.js';
import { purchaseReceptionProductInventory } from './purchase-reception-product-inventory.js';
import { localSalesProductStocks } from './local-sales-product-inventory.js';
import { catalogProductsById, isNewCatalogProduct } from './product-catalog-references.js';
import { adjustmentLotState, inactivePepsOrder, scaledLayerStock, type AdjustmentLayer } from '../../../movements/infrastructure/datasources/inventory-adjustment-layers.js';

interface WarehouseRow extends RowDataPacket {
  code: string;
  name: string;
}

type LotPanel = 'lots' | 'inventory-layers';

function pepsLayerKey(code: string, order: number) {
  return code.trimEnd().padEnd(13) + (order === inactivePepsOrder ? 'ZZZZ' : String(order).padStart(4));
}

function localLayerRow(layer: AdjustmentLayer, panel: LotPanel, code: string, order: number | undefined) {
  const { id, warehouse, date, expiresAt, lot, cost, adValorem } = layer;
  const common = { id, warehouse, date, expiresAt, lot, cost, adValoremCost: adValorem };
  return panel === 'inventory-layers'
    ? { ...common, initialQuantity: layer.initial, quantity: layer.available, document: layer.document,
      layerKey: pepsLayerKey(code, order ?? layer.layerOrder) }
    : { ...common, availableQuantity: layer.available, number: layer.number, customsEntry: layer.customsEntry,
      customsOffice: layer.customsOffice, location: layer.location };
}

export class ProductPanelsWithPurchaseReceptionsDataSource extends LegacyMysqlProductPanelsDataSource {
  override async getPanel(productId: number, panel: ProductPanelKey, criteria: ProductPanelCriteria) {
    const layers = panel === 'lots' || panel === 'inventory-layers';
    const localOnly = isNewCatalogProduct(productId) && (layers || panel === 'warehouses' || panel === 'ledger');
    const result = localOnly ? await this.localCatalogPanel(productId, panel, criteria) : await super.getPanel(productId, panel, criteria);
    if (!result) return result;
    if (layers) return this.mergeLayers(productId, panel, criteria, result, localOnly);
    if (panel === 'ledger') {
      const { limit, offset, ledger } = criteria;
      const page = await localProductLedger(productId, ledger, limit - result.items.length, async () => {
        if (localOnly) return offset;
        if (offset === 0 || result.items.length > 0) return 0;
        const historicalCount = result.lotTotals?.count ?? await this.countLedgerItems(productId, ledger);
        return Math.max(0, offset - historicalCount);
      });
      const historical = result.lotTotals;
      const local = page.lotTotals;
      const lotTotals = historical && local ? {
        count: historical.count + local.count, entries: historical.entries + local.entries,
        exits: historical.exits + local.exits, net: historical.net + local.net,
      } : historical;
      return {
        ...result, items: [...result.items, ...page.items],
        ...(result.openingStock === undefined ? {} : { openingStock: result.openingStock + page.openingDelta }),
        ...(lotTotals === undefined ? {} : { lotTotals }),
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

  private async mergeLayers(
    productId: number, panel: LotPanel, { limit, offset }: ProductPanelCriteria, result: ProductPanelResult, localOnly: boolean,
  ): Promise<ProductPanelResult> {
    const remaining = limit - result.items.length;
    const { deltas, orders, local } = await adjustmentLotState(productId, remaining > 0);
    const quantity = panel === 'inventory-layers' ? 'quantity' : 'availableQuantity';
    const items: ProductPanelResult['items'] = result.items.map((row) => {
      const id = Number(row.id);
      const delta = deltas.get(id);
      const order = orders.get(id);
      return {
        ...row,
        ...(delta === undefined ? {} : { [quantity]: scaledLayerStock(Number(row[quantity] ?? 0) + delta) }),
        ...(panel === 'inventory-layers' && order !== undefined ? { layerKey: pepsLayerKey(result.product.code, order) } : {}),
      };
    });
    if (local.length > 0) {
      const start = localOnly ? offset : offset === 0 || items.length > 0 ? 0
        : Math.max(0, offset - await this.countProductLots(productId));
      items.push(...local.slice(start, start + remaining)
        .map((layer) => localLayerRow(layer, panel, result.product.code, orders.get(layer.id))));
    }
    return { ...result, items };
  }

  private async localCatalogPanel(
    productId: number, panel: 'warehouses' | 'ledger' | LotPanel, criteria: ProductPanelCriteria,
  ): Promise<ProductPanelResult | null> {
    const reference = (await catalogProductsById([productId])).get(productId);
    if (!reference || reference.deleted) return null;
    const { id, code, description } = reference.document;
    const ledger = panel === 'ledger';
    const lots = panel === 'lots' || panel === 'inventory-layers';
    return {
      product: { id, code, description }, key: panel, section: lots ? 'purchases-production' : ledger ? 'queries' : 'actions',
      button: panel === 'lots' ? 'Lotes' : panel === 'inventory-layers' ? 'UEPS / PEPS' : ledger ? 'Auxiliar' : 'Almacenes',
      available: true, source: 'product-cache', items: [],
      ...(ledger && criteria.ledger?.lotId !== undefined
        ? { lotTotals: { count: 0, entries: 0, exits: 0, net: 0 } }
        : ledger && criteria.ledger?.warehouse !== undefined ? { openingStock: 0 } : {}),
    };
  }
}
