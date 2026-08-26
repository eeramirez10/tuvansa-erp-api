export type ProductPanelSection = 'actions' | 'purchases-production' | 'queries';

export type ProductPanelKey =
  | 'warehouses' | 'color-size-registration' | 'block-status' | 'classifications'
  | 'extended-description' | 'customer-discounts' | 'supplier-discounts'
  | 'other-data' | 'specifications' | 'photo' | 'ct-inventory' | 'prices'
  | 'skus' | 'prepacks' | 'alternates' | 'components' | 'quality-specifications'
  | 'implosion' | 'lots' | 'inventory-layers' | 'ledger' | 'customer-orders'
  | 'customer-orders-star' | 'customer-orders-ct' | 'customer-quotes'
  | 'customer-sales' | 'customer-sales-star' | 'customer-sales-ct'
  | 'customer-sales-detail' | 'sales-by-branch' | 'annual-sales'
  | 'annual-sales-summary' | 'supplier-orders' | 'supplier-orders-ct'
  | 'supplier-quotes' | 'supplier-purchases' | 'supplier-purchases-dt'
  | 'supplier-purchases-detail' | 'annual-purchases' | 'annual-purchases-summary'
  | 'pieces' | 'fulfilled-pieces' | 'work-in-progress' | 'work-in-progress-ct'
  | 'edi' | 'pending-enablements' | 'documents';

export interface ProductPanelCriteria {
  limit: number;
  offset: number;
}

export interface ProductPanelResult {
  product: { id: number; code: string; description: string };
  key: ProductPanelKey;
  section: ProductPanelSection;
  button: string;
  available: boolean;
  source: 'mysql' | 'product-cache' | 'not-available';
  items: Array<Record<string, unknown>>;
  reason?: string;
}

export interface ProductBlockStatus {
  product: { id: number; code: string; description: string };
  blocked: boolean;
  deactivatedAt: string | null;
}

export interface ProductPanelsRepository {
  getPanel(
    productId: number,
    panel: ProductPanelKey,
    criteria: ProductPanelCriteria,
  ): Promise<ProductPanelResult | null>;
  setBlocked(productId: number, blocked: boolean): Promise<ProductBlockStatus | null>;
}
