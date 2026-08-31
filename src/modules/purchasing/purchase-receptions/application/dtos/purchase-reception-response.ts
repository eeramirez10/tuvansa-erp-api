import type { PurchaseReception } from '../../domain/entities/purchase-reception.js';

export const toPurchaseReceptionResponse = (reception: PurchaseReception) => reception.toPrimitives();
