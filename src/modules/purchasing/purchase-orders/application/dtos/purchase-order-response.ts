import type { PurchaseOrder } from '../../domain/entities/purchase-order.js';

export const toPurchaseOrderResponse = (purchaseOrder: PurchaseOrder) => purchaseOrder.toPrimitives();
