export const invoicePanelKeys = [
  'auxiliary', 'boxes', 'classifications', 'comments', 'ct', 'print', 'lots', 'pieces', 'seal',
  'ticket-to-invoice', 'transfer', 'edit-pieces', 'truck-settlement',
] as const;

export type InvoicePanelKey = typeof invoicePanelKeys[number];
export type InvoicePanelSection = 'actions' | 'summaries';

export interface InvoicePanelResult {
  invoice: { id: number; number: string };
  key: InvoicePanelKey;
  section: InvoicePanelSection;
  button: string;
  available: boolean;
  source: 'mysql' | 'static';
  items: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
  readOnly?: boolean;
  reason?: string;
}

export interface InvoicePanelsRepository {
  getPanel(invoiceId: number, key: InvoicePanelKey): Promise<InvoicePanelResult | null>;
}
