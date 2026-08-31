export type SupplierPanelKey =
  | 'block-status'
  | 'discounts'
  | 'events'
  | 'various'
  | 'contacts'
  | 'balance'
  | 'movements'
  | 'invoices'
  | 'ordered-products'
  | 'fill-rate'
  | 'quoted-products'
  | 'purchased-products'
  | 'purchased-products-detail'
  | 'price-history'
  | 'purchased-expenses'
  | 'annual-purchases'
  | 'annual-purchases-summary'
  | 'work-in-progress';

export interface SupplierPanelIdentity {
  id: number;
  code: string;
  name: string;
  currentBalance: number;
}

export interface SupplierPanelResult {
  supplier: SupplierPanelIdentity;
  items: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
  detail?: Record<string, unknown>;
  unavailableReason?: string;
}

export interface SupplierClassificationResult {
  supplier: SupplierPanelIdentity;
  classifications: Array<{
    position: number;
    label: string;
    code: string;
    description: string;
  }>;
  selectedPosition: number;
  options: Array<{ id: number; code: string; description: string; number: string; type: string }>;
}

export interface SupplierPanelsRepository {
  findPanel(supplierId: number, key: SupplierPanelKey): Promise<SupplierPanelResult | null>;
  findClassifications(supplierId: number, position: number): Promise<SupplierClassificationResult | null>;
}
