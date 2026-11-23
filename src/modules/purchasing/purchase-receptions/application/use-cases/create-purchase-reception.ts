import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  PurchaseReceptionActor, PurchaseReceptionCreateInput, PurchaseReceptionPosting,
  PurchaseReceptionWriteContext, PurchaseReceptionWriteDataSource, PurchaseReceptionWriteReferences,
} from '../../domain/datasources/purchase-reception-write-data-source.js';
import {
  applyPurchaseOrderReceipt, purchaseOrderReceiptLines,
  type PurchaseOrderReceiptEffect,
} from '../../domain/entities/purchase-reception-order-effect.js';

const requestKeySchema = z.uuid();
const receivedAtSchema = z.iso.date();
const invalid = (message: string) => new ApplicationError(message, 'INVALID_PURCHASE_RECEPTION', 422);

function validatePosting(
  actor: PurchaseReceptionActor,
  input: PurchaseReceptionCreateInput,
  effect: PurchaseOrderReceiptEffect,
  posting: PurchaseReceptionPosting,
): void {
  const { document, movement, lines } = posting;
  const expected = new Map(effect.lines.map((line) => [line.orderLineId, line.productId]));
  if (document.orderNumber !== effect.order.number || document.supplier.id !== effect.order.supplier.id
    || document.warehouse !== input.warehouse || document.dates.receivedAt !== input.receivedAt
    || document.supplierReference !== input.supplierReference
    || movement.company !== actor.companyId || movement.reference !== effect.order.number
    || movement.warehouse !== input.warehouse || movement.date !== input.receivedAt
    || lines.length !== expected.size
    || lines.some(({ orderLineId, reception, movement }) => expected.get(orderLineId) !== reception.productId
      || reception.productId !== movement.productId || movement.productCode !== reception.productCode
      || movement.warehouse !== input.warehouse || !Number.isFinite(movement.quantity) || movement.quantity <= 0
      || movement.quantity !== reception.quantity || !expected.delete(orderLineId))) {
    throw new ApplicationError('La recepción, la orden y el movimiento no coinciden.', 'PURCHASE_RECEPTION_POSTING_MISMATCH', 409);
  }
}

export class CreatePurchaseReception {
  constructor(
    private readonly references: PurchaseReceptionWriteReferences,
    private readonly storage: PurchaseReceptionWriteDataSource,
  ) {}

  private async context(companyId: number, orderId: number): Promise<PurchaseReceptionWriteContext> {
    const context = await this.references.context(companyId, orderId);
    if (!context || context.order.id !== orderId || context.order.documentKind !== 'order') {
      throw new NotFoundError('Orden de compra para recibir');
    }
    return context;
  }

  async get(companyId: number, orderId: number) {
    const context = await this.context(companyId, orderId);
    const { order, revision, legacyVersion, policy, warehouses, defaults } = context;
    const lines = purchaseOrderReceiptLines(order, policy);
    let reason = context.reason;
    if (!this.storage.writable()) reason = 'El alta de recepciones requiere PostgreSQL.';
    else if (!reason && warehouses.length === 0) reason = 'La empresa no tiene almacenes habilitados para recibir.';
    else if (!reason && lines.length === 0) reason = 'La orden de compra no tiene partidas disponibles para recibir.';
    return {
      id: order.id, number: order.number, supplier: order.supplier, revision, legacyVersion,
      canWrite: reason === null, reason, warehouses, defaults, lines,
      canRetireCompletedOrder: policy.canRetireCompletedOrder,
    };
  }

  async save(actor: PurchaseReceptionActor, orderId: number, input: PurchaseReceptionCreateInput) {
    if (!this.storage.writable()) {
      throw new ApplicationError('El alta de recepciones requiere PostgreSQL.', 'PURCHASE_RECEPTION_POSTGRES_UNAVAILABLE', 503);
    }
    if (!Number.isSafeInteger(actor.userId) || actor.userId < 0 || !Number.isSafeInteger(actor.companyId) || actor.companyId <= 0) {
      throw new ApplicationError('El usuario de auditoría o la empresa de la recepción no son válidos.', 'PURCHASE_RECEPTION_ACTOR_REQUIRED', 403);
    }
    if (!requestKeySchema.safeParse(input.requestKey).success) throw invalid('La solicitud de recepción requiere un identificador válido.');

    const request: PurchaseReceptionCreateInput = {
      requestKey: input.requestKey.toLowerCase(),
      revision: input.revision,
      legacyVersion: input.legacyVersion,
      receivedAt: input.receivedAt,
      warehouse: input.warehouse.trim(),
      supplierReference: input.supplierReference.trim(),
      retireCompletedOrder: input.retireCompletedOrder ?? false,
      lines: input.lines.map(({ orderLineId, quantity }) => ({ orderLineId, quantity }))
        .sort((left, right) => left.orderLineId - right.orderLineId),
    };
    if (!receivedAtSchema.safeParse(request.receivedAt).success) throw invalid('Captura una fecha de recepción válida.');

    const { companyId, userId } = actor;
    const fingerprint = createHash('sha256').update(JSON.stringify({ companyId, userId, orderId, request })).digest('hex');
    const saved = await this.storage.findRequest(actor.companyId, request.requestKey, fingerprint);
    if (saved) return saved;

    const context = await this.context(actor.companyId, orderId);
    if (request.revision !== context.revision || request.legacyVersion !== context.legacyVersion) {
      throw new ApplicationError('La orden de compra cambió. Vuelve a abrir la recepción.', 'PURCHASE_RECEPTION_ORDER_CHANGED', 409);
    }
    if (context.reason) throw new ApplicationError(context.reason, 'PURCHASE_RECEPTION_UNAVAILABLE', 409);
    if (!context.warehouses.some(({ code }) => code === request.warehouse)) {
      throw invalid('El almacén no está habilitado para recibir en esta empresa.');
    }

    const effect = applyPurchaseOrderReceipt(context.order, request.lines, context.policy, request.retireCompletedOrder);
    const posting = await this.references.posting(context, request, effect);
    validatePosting(actor, request, effect, posting);
    return this.storage.commit({ actor, input: request, fingerprint, context, effect, posting });
  }
}
