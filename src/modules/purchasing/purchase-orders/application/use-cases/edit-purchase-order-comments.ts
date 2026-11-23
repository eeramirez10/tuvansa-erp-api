import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { PurchaseOrderAuthorizationStorage } from '../../domain/datasources/purchase-order-authorization-data-source.js';
import type { PurchaseOrderCommentsInput, PurchaseOrderCommentsLegacy, PurchaseOrderCommentsStorage } from '../../domain/datasources/purchase-order-comments-data-source.js';
import type { PurchaseOrderCreateStorage } from '../../domain/datasources/purchase-order-create-data-source.js';
import type { PurchaseOrderEditLegacyDataSource, PurchaseOrderEditStorage } from '../../domain/datasources/purchase-order-edit-data-source.js';
import { applyPurchaseOrderCommentFields, type PurchaseOrderCommentFields } from '../../domain/entities/purchase-order-comments.js';
import { totalizePurchaseOrder } from '../../domain/entities/purchase-order-edit.js';
import type { PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';
import { loadPurchaseOrderWriteContext } from './load-purchase-order-write-context.js';

const mexicoDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' });
const dateOnly = (value: unknown) => typeof value === 'string' ? value.slice(0, 10) : null;

export class EditPurchaseOrderComments {
  constructor(
    private readonly legacy: PurchaseOrderEditLegacyDataSource & PurchaseOrderCommentsLegacy,
    private readonly storage: PurchaseOrderEditStorage & PurchaseOrderCommentsStorage & Pick<PurchaseOrderAuthorizationStorage, 'findAuthorizationEvents'>,
    private readonly creation: PurchaseOrderCreateStorage,
    private readonly orders: PurchaseOrdersRepository,
  ) {}

  private async context(id: number) {
    const context = await loadPurchaseOrderWriteContext(id, this.legacy, this.storage, this.creation);
    const { base, stored, local, rules, version } = context;
    const [panel, events] = await Promise.all([
      local ? null : this.legacy.readComments(id),
      this.storage.findAuthorizationEvents(base),
    ]);
    const summary = panel?.summary;
    const line = panel?.items[0];
    const text = (value: unknown) => typeof value === 'string' ? value : '';
    const raw: PurchaseOrderCommentFields = {
      from: base.dates.from, dueAt: base.dates.dueAt, terms: Number(local?.metadata.terms ?? summary?.terms) || 0,
      supplierOrderNumber: base.supplierOrderNumber, department: base.department, discountPercentages: base.discountPercentages,
      exchangeRate: Number(local?.metadata.exchangeRate ?? summary?.exchangeRate) || 0, warehouse: base.warehouse,
      currencyId: rules.currencyId, lines: [text(line?.comments), text(line?.line2), text(line?.line3), text(line?.line4), text(line?.line5)],
      otherLabel: base.otherLabel, freight: base.totals.freight, insurance: base.totals.insurance, other: base.totals.other,
      confirmedAt: dateOnly(summary?.modifiedAt),
    };
    const comments = stored?.comments;
    const approval = events.findLast(({ level, direction }) => level === 'C' && direction === 'approve');
    const manual = comments?.manualConfirmation;
    const approvedAt = approval ? new Date(approval.occurredAt) : null;
    const confirmedAt = approvedAt && (!manual || approvedAt.getTime() >= Date.parse(manual.changedAt))
      ? mexicoDate.format(approvedAt) : manual ? manual.date : raw.confirmedAt;
    const fields = { ...(comments?.fields ?? raw), confirmedAt };
    const sourceVersion = createHash('sha256').update(JSON.stringify({ version, raw, confirmedAt })).digest('hex');
    const reason = rules.companyId !== rules.activeCompanyId ? 'La orden pertenece a otra compañía.'
      : stored && stored.legacyVersion !== version ? 'La orden de origen cambió.'
        : !this.storage.writable() ? 'Guardar comentarios requiere PostgreSQL.' : '';
    return { ...context, fields, sourceVersion, reason };
  }

  async get(id: number) {
    const { fields, sourceVersion, reason, stored } = await this.context(id);
    return { fields, revision: stored?.revision ?? 0, legacyVersion: sourceVersion, canWrite: !reason, reason };
  }

  async execute(id: number, input: PurchaseOrderCommentsInput) {
    const { base, rules, fields, stored, sourceVersion, reason, lines, version } = await this.context(id);
    if (input.revision !== (stored?.revision ?? 0) || input.legacyVersion !== sourceVersion) {
      throw new ConflictError('La orden cambió. Vuelve a abrir Comentarios.', 'PURCHASE_ORDER_COMMENTS_STALE');
    }
    if (reason) {
      throw new ApplicationError(reason, 'PURCHASE_ORDER_COMMENTS_NOT_ALLOWED', this.storage.writable() ? 409 : 503);
    }

    const next = input.fields;
    if (!isDeepStrictEqual(next, fields)) {
      const financial = next.freight !== fields.freight || next.insurance !== fields.insurance || next.other !== fields.other
        || !isDeepStrictEqual(next.discountPercentages, fields.discountPercentages);
      const currencyChanged = next.currencyId !== fields.currencyId;
      const products = financial || (currencyChanged && next.currencyId === 0)
        ? await this.legacy.findProducts([...new Set(lines.map(({ productCode }) => productCode))], rules.supplierUnits) : [];
      const byId = new Map(products.map((product) => [product.id, product]));
      if ((financial || (currencyChanged && next.currencyId === 0)) && lines.some((line) => !byId.has(line.productId))) {
        throw new ApplicationError('No se encontró el producto de una partida para recalcular la orden.', 'PURCHASE_ORDER_COMMENTS_PRODUCT_UNAVAILABLE', 422);
      }
      const currencyName = currencyChanged ? await this.legacy.commentCurrencyName(next.currencyId)
        : stored?.comments?.currencyName ?? rules.currencyName;
      const updatedLines = currencyChanged ? lines.map((line) => {
        const product = byId.get(line.productId);
        return { ...line, currencyId: next.currencyId || product?.currencyId || 0,
          currencyName: next.currencyId ? currencyName : product?.currencyName ?? '' };
      }) : lines;
      const header = applyPurchaseOrderCommentFields({ ...base, totals: stored?.totals ?? base.totals }, next);
      const totals = financial
        ? totalizePurchaseOrder(header, updatedLines, (line) => Boolean(byId.get(line.productId)?.taxable))
        : { totals: header.totals, amountInWords: stored?.amountInWords ?? null };
      await this.storage.saveComments({
        id, number: base.number, revision: input.revision, legacyVersion: version, lines: updatedLines, ...totals,
        comments: {
          fields: next, currencyName, manualConfirmation: next.confirmedAt !== fields.confirmedAt
            ? { date: next.confirmedAt, changedAt: new Date().toISOString() } : stored?.comments?.manualConfirmation ?? null,
        },
      });
    }
    const saved = await this.orders.findById(id);
    if (!saved) throw new NotFoundError('Orden de compra');
    return saved.toPrimitives();
  }
}
