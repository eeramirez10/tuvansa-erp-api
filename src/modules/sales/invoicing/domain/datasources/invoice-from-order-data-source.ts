import type { MovementDocument } from '../../../../inventories/movements/domain/entities/inventory-movement.js';
import type { InventoryPepsCost } from '../../../../inventories/movements/domain/entities/inventory-peps-cost.js';
import type { OrderProps } from '../../../orders/domain/entities/order.js';
import type { InvoiceLine, InvoiceProps } from '../entities/invoice.js';

export interface InvoiceFromOrderInput {
  orderNumber: string;
  requestKey: string;
  revision: number;
  issuedAt: string;
  lines: Array<{ orderLineId: number; quantity: number }>;
}

export interface InvoiceFromOrderResult {
  invoice: InvoiceProps;
  orderComplete: boolean;
}

export interface InvoiceFromOrderStock {
  productId: number;
  quantity: number;
  legacyOnHand: number;
  legacyAssigned: number;
  pepsCostBasis?: InventoryPepsCost;
}

export interface InvoiceFromOrderPosting {
  order: OrderProps;
  invoice: Omit<InvoiceProps, 'id' | 'number' | 'lines'> & { lines: Omit<InvoiceLine, 'id'>[] };
  movement: {
    header: Omit<MovementDocument['header'], 'id' | 'document'>;
    lines: Omit<MovementDocument['lines'][number], 'id'>[];
    totals: MovementDocument['totals'];
  };
  receivable: { amount: number; currencyId: 1; exchangeRate: 1; dueAt: string };
  lineEffects: Array<{ orderLineId: number; productId: number; quantity: number }>;
  stock: InvoiceFromOrderStock[];
  orderComplete: boolean;
}

export interface InvoiceFromOrderCommand {
  companyId: number;
  userId: number;
  requestKey: string;
  fingerprint: string;
  orderId: number;
  orderNumber: string;
  revision: number;
  post(current: OrderProps, localReceivableBalance?: number): Promise<InvoiceFromOrderPosting>;
}

export interface InvoiceFromOrderStorage {
  writable(): boolean;
  order(number: string): Promise<{ order: OrderProps; revision: number } | null>;
  findRequest(companyId: number, requestKey: string, fingerprint: string): Promise<InvoiceFromOrderResult | null>;
  commit(command: InvoiceFromOrderCommand): Promise<InvoiceFromOrderResult>;
}

export interface InvoiceFromOrderProduct {
  id: number;
  code: string;
  unit: string;
  package: string;
  family: string;
  cost: number;
  legacyOnHand: number;
  legacyAssigned: number;
  supported: boolean;
  pepsCostBasis?: InventoryPepsCost;
}

export interface InvoiceFromOrderContext {
  reason: string | null;
  fiscalStart: string;
  fiscalEnd: string;
  customerTermsDays: number;
  creditLimit: number;
  creditBalance: number;
  vat: number;
  products: ReadonlyMap<number, InvoiceFromOrderProduct>;
}

export interface InvoiceFromOrderReferences {
  context(companyId: number, order: OrderProps): Promise<InvoiceFromOrderContext>;
}
