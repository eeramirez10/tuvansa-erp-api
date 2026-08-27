export const orderPanelKeys = [
  'assign-all', 'authorize', 'invoices', 'boxes', 'classifications', 'comments', 'quote-conversion',
  'duplicate', 'labels', 'print', 'monarch', 'pieces', 'transfer',
  'assign-ct', 'consolidate', 'ct', 'split-ct', 'export',
  'purchase-order', 'split', 'branch', 'wip',
] as const;

export type OrderPanelKey = typeof orderPanelKeys[number];
export type OrderPanelSection = 'actions' | 'secondary-actions';

export interface OrderPanelResult {
  order: { id: number; number: string };
  key: OrderPanelKey;
  section: OrderPanelSection;
  button: string;
  available: boolean;
  source: 'mysql' | 'static' | 'not-available';
  items: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
  reason?: string;
}

export interface OrderPanelsRepository {
  getPanel(orderId: number, key: OrderPanelKey): Promise<OrderPanelResult | null>;
}
