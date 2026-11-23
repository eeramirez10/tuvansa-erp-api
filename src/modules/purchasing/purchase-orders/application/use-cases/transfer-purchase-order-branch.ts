import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  PurchaseOrderBranchTransferIdentity, PurchaseOrderBranchTransferInput, PurchaseOrderBranchTransferStorage,
} from '../../domain/datasources/purchase-order-branch-transfer-data-source.js';
import type { PurchaseOrderCreateStorage } from '../../domain/datasources/purchase-order-create-data-source.js';
import type {
  PurchaseOrderEditLegacyDataSource, PurchaseOrderEditSnapshot, PurchaseOrderEditStorage,
} from '../../domain/datasources/purchase-order-edit-data-source.js';
import { applyPurchaseOrderCommentFields } from '../../domain/entities/purchase-order-comments.js';
import { purchaseOrderStockDifference, totalizePurchaseOrder } from '../../domain/entities/purchase-order-edit.js';
import type { PurchaseOrderLine } from '../../domain/entities/purchase-order.js';
import type { PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';
import { loadPurchaseOrderWriteContext } from './load-purchase-order-write-context.js';

type OrderContext = Awaited<ReturnType<typeof loadPurchaseOrderWriteContext>>;

const mexicoCompanyId = 1;
const invalid = (message: string) => new ApplicationError(message, 'INVALID_PURCHASE_ORDER_BRANCH_TRANSFER', 422);
const storageQuantity = (quantity: number) =>
  Math.sign(quantity) * Math.round((Math.abs(quantity) + Number.EPSILON) * 1000) / 1000;

function checkQuantity(quantity: number) {
  if (!Number.isFinite(quantity) || !Number.isSafeInteger(Math.round(quantity * 1000))) {
    throw invalid('La cantidad excede el rango admitido.');
  }
  return storageQuantity(quantity);
}

function snapshot(context: OrderContext): PurchaseOrderEditSnapshot {
  const { base, stored, version, lines } = context;
  return {
    id: base.id, number: base.number, revision: stored?.revision ?? 0, legacyVersion: version,
    lines, totals: stored?.totals ?? base.totals, amountInWords: stored?.amountInWords ?? null,
  };
}

function withTransferredQuantity(source: PurchaseOrderEditSnapshot, selected: PurchaseOrderLine, quantity: number): PurchaseOrderEditSnapshot {
  const fulfilled = checkQuantity(selected.fulfilled + quantity);
  const lines = source.lines.map((line) => line.id === selected.id
    ? { ...line, fulfilled, remaining: checkQuantity(line.ordered - fulfilled) } : line);
  const totalFulfilled = checkQuantity(source.totals.fulfilled + quantity);
  return {
    ...source, lines,
    totals: { ...source.totals, fulfilled: totalFulfilled, remaining: checkQuantity(source.totals.ordered - totalFulfilled) },
  };
}

function appendLine(line: PurchaseOrderLine, quantity: number, branch: number): PurchaseOrderLine {
  const ordered = checkQuantity(quantity);
  return { ...line, id: 0, branch, ordered, fulfilled: 0, remaining: ordered, assigned: 0, confirmed: false };
}

function transferStock(context: OrderContext, lines: PurchaseOrderLine[]) {
  const { base, stored } = context;
  const from = stored?.comments ? stored.comments.fields.from : base.dates.from;
  // An order that started as a quotation retains the original quotation comparison.
  const pendingLines = base.documentKind === 'quote' ? lines.map((line) => line.fulfilled > line.ordered
    ? { ...line, fulfilled: line.ordered } : line) : lines;
  return purchaseOrderStockDifference({ ...base, dates: { ...base.dates, from } }, pendingLines, 'order');
}

export class TransferPurchaseOrderBranch {
  constructor(
    private readonly legacy: PurchaseOrderEditLegacyDataSource,
    private readonly storage: PurchaseOrderEditStorage & PurchaseOrderBranchTransferStorage,
    private readonly creation: PurchaseOrderCreateStorage,
    private readonly orders: PurchaseOrdersRepository,
  ) {}

  private context(id: number) {
    return loadPurchaseOrderWriteContext(id, this.legacy, this.storage, this.creation);
  }

  private writeReason({ documentKind, rules, stored, version }: OrderContext) {
    if (documentKind !== 'order') return 'La acción requiere un pedido de compra.';
    if (rules.activeCompanyId !== mexicoCompanyId || rules.companyId !== rules.activeCompanyId) {
      return 'El pedido no pertenece a la compañía activa de TUVANSA.';
    }
    if (stored && stored.legacyVersion !== version) return 'El documento de origen cambió.';
    if (!this.storage.writable()) return 'El traslado entre sucursales requiere PostgreSQL.';
    return '';
  }

  async get(id: number) {
    const context = await this.context(id);
    const { base, stored, version } = context;
    const lines = context.lines.filter(({ productCode }) => productCode);
    const reason = this.writeReason(context) || (!lines.length ? 'El pedido no tiene partidas disponibles.' : '');
    return { id, number: base.number, revision: stored?.revision ?? 0, legacyVersion: version, canWrite: !reason, reason, lines };
  }

  async execute(sourceId: number, input: PurchaseOrderBranchTransferInput) {
    if (!this.storage.writable()) {
      throw new ApplicationError('El traslado entre sucursales requiere PostgreSQL.', 'PURCHASE_ORDER_POSTGRES_UNAVAILABLE', 503);
    }
    const destinationNumber = input.destinationNumber.trim().toUpperCase();
    const fingerprint = createHash('sha256').update(JSON.stringify([
      sourceId, input.revision, input.legacyVersion, input.mode, input.sourceLineId, destinationNumber,
      input.destinationRevision, input.destinationLegacyVersion, input.quantity, input.destinationBranch,
    ])).digest('hex');
    const prior = await this.storage.findBranchTransferRequest(input.requestKey, fingerprint);
    if (prior) return this.readSaved(prior);
    const quantity = checkQuantity(input.quantity);
    if (quantity <= 0 || quantity !== input.quantity) {
      throw invalid('Captura una cantidad o porcentaje positivo con hasta tres decimales.');
    }

    const source = await this.context(sourceId);
    this.assertCurrent(source, input.revision, input.legacyVersion);
    const selected = source.lines.find(({ id, productCode }) => id === input.sourceLineId && productCode);
    if (!selected) throw invalid('Selecciona una partida del pedido de origen.');

    const destinationId = destinationNumber === source.base.number.toUpperCase()
      ? sourceId : (await this.orders.findByNumber(destinationNumber))?.identity.id;
    if (destinationId === undefined) throw new NotFoundError('Pedido de destino');
    const merged = destinationId === sourceId;
    const destination = merged ? source : await this.context(destinationId);
    this.assertCurrent(destination, input.destinationRevision, input.destinationLegacyVersion);

    const initialSource = snapshot(source);
    const divided = input.mode === 'divide';
    const nextSource = divided ? withTransferredQuantity(initialSource, selected, quantity) : initialSource;
    const copied = divided
      ? [appendLine(selected, quantity, input.destinationBranch)]
      : source.lines
        .filter(({ branch, productCode }) => branch === selected.branch && productCode)
        .map((line) => appendLine(line, line.ordered * (quantity / 100), input.destinationBranch));
    const destinationBefore = snapshot(destination);
    const destinationLines = [...(merged ? nextSource.lines : destinationBefore.lines), ...copied];
    const nextDestination = await this.totalizeDestination(destination, destinationBefore, destinationLines);
    await this.storage.saveBranchTransfer(
      input.requestKey, fingerprint, nextSource,
      divided && !merged ? transferStock(source, nextSource.lines) : null,
      nextDestination, transferStock(destination, destinationLines),
    );
    return this.readSaved({ sourceId, destinationId });
  }

  private assertCurrent(context: OrderContext, revision: number, legacyVersion: string) {
    if (revision !== (context.stored?.revision ?? 0) || legacyVersion !== context.version) {
      throw new ConflictError('El pedido de origen o destino cambió. Vuelve a abrir la acción.', 'PURCHASE_ORDER_BRANCH_TRANSFER_STALE');
    }
    const reason = this.writeReason(context);
    if (reason) throw new ApplicationError(reason, 'PURCHASE_ORDER_BRANCH_TRANSFER_NOT_ALLOWED', 409);
  }

  private async totalizeDestination(context: OrderContext, current: PurchaseOrderEditSnapshot, lines: PurchaseOrderLine[]) {
    const products = await this.legacy.findProducts([...new Set(lines.map(({ productCode }) => productCode))], false);
    const taxability = new Map(products.map(({ id, taxable }) => [id, taxable]));
    if (lines.some(({ productId }) => !taxability.has(productId))) {
      throw invalid('Falta el producto de una partida para recalcular el pedido de destino.');
    }
    const { base, stored } = context;
    const header = { ...base, totals: current.totals };
    const effective = stored?.comments ? applyPurchaseOrderCommentFields(header, stored.comments.fields) : header;
    return { ...current, lines, ...totalizePurchaseOrder(effective, lines, ({ productId }) => taxability.get(productId) === true) };
  }

  private async readSaved({ sourceId, destinationId }: PurchaseOrderBranchTransferIdentity) {
    const source = this.orders.findById(sourceId);
    const destination = sourceId === destinationId ? source : this.orders.findById(destinationId);
    const [savedSource, savedDestination] = await Promise.all([source, destination]);
    if (!savedSource || !savedDestination) throw new NotFoundError('Orden de compra');
    return { source: savedSource.toPrimitives(), destination: savedDestination.toPrimitives() };
  }
}
