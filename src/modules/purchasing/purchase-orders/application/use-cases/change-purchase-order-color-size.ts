import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import {
  purchaseOrderColorSizeQuantityMax,
  purchaseOrderColorSizeQuantityMin,
  type PurchaseOrderColorSizeChangeCell,
  type PurchaseOrderColorSizeChangeInput,
  type PurchaseOrderColorSizeChangeStorage,
} from '../../domain/datasources/purchase-order-color-size-change-data-source.js';
import type { PurchaseOrderCreateStorage } from '../../domain/datasources/purchase-order-create-data-source.js';
import type { PurchaseOrderEditLegacyDataSource, PurchaseOrderEditStorage } from '../../domain/datasources/purchase-order-edit-data-source.js';
import type { LegacyPurchaseOrdersDataSource } from '../../domain/datasources/purchase-orders-data-source.js';
import { purchaseOrderStockDifference } from '../../domain/entities/purchase-order-edit.js';
import type { PurchaseOrderLine } from '../../domain/entities/purchase-order.js';
import type { PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';
import { loadPurchaseOrderWriteContext } from './load-purchase-order-write-context.js';

type ColorSizeGroup = { root: string; sizes: string[]; colors: Array<{ color: string }> };

function editableCells(lines: PurchaseOrderLine[], groups: ColorSizeGroup[]): PurchaseOrderColorSizeChangeCell[] {
  const firstByCode = new Map<string, PurchaseOrderLine>();
  for (const line of lines) {
    const first = firstByCode.get(line.productCode);
    if (!first || line.id < first.id) firstByCode.set(line.productCode, line);
  }

  const cells = new Map<number, PurchaseOrderColorSizeChangeCell>();
  for (const { root, sizes, colors } of groups) {
    for (const { color } of colors) {
      for (const size of sizes) {
        const productCode = root + color + size;
        const line = firstByCode.get(productCode);
        if (line) {
          cells.set(line.id, { lineId: line.id, productCode, root, color, size, quantity: line.ordered, fulfilled: line.fulfilled });
        }
      }
    }
  }
  return [...cells.values()];
}

const storageQuantity = (value: number) => Number(value.toFixed(3));

export class ChangePurchaseOrderColorSize {
  constructor(
    private readonly legacy: PurchaseOrderEditLegacyDataSource,
    private readonly catalog: Pick<LegacyPurchaseOrdersDataSource, 'getPanel'>,
    private readonly storage: PurchaseOrderEditStorage & PurchaseOrderColorSizeChangeStorage,
    private readonly creation: PurchaseOrderCreateStorage,
    private readonly orders: PurchaseOrdersRepository,
  ) {}

  private async context(id: number) {
    const context = await loadPurchaseOrderWriteContext(id, this.legacy, this.storage, this.creation);
    const { base, documentKind, rules, stored, version, lines } = context;
    const snapshot = stored ?? {
      id, number: base.number, revision: 0, legacyVersion: version,
      lines, totals: base.totals, amountInWords: null,
    };
    const panel = await this.catalog.getPanel(id, 'ct', [snapshot], { id, number: base.number });
    const cells = editableCells(lines, (panel?.items ?? []) as Array<Record<string, unknown> & ColorSizeGroup>);
    let reason = '';
    if (documentKind !== 'order') reason = 'Cambio de CT sólo está habilitado para pedidos de compra.';
    else if (rules.companyId !== rules.activeCompanyId) reason = 'La orden pertenece a otra compañía.';
    else if (stored && stored.legacyVersion !== version) reason = 'El documento de origen cambió.';
    else if (!this.storage.writable()) reason = 'Cambio de CT requiere PostgreSQL.';
    else if (!cells.length) reason = 'La orden no tiene partidas con color y talla configurados en la matriz.';
    return { ...context, cells, reason };
  }

  async get(id: number) {
    const { base, stored, version, cells, reason } = await this.context(id);
    return { id, number: base.number, revision: stored?.revision ?? 0, legacyVersion: version, cells, canWrite: !reason, reason };
  }

  async execute(id: number, input: PurchaseOrderColorSizeChangeInput) {
    const { base, stored, version, documentKind, lines, cells, reason } = await this.context(id);
    if (input.revision !== (stored?.revision ?? 0) || input.legacyVersion !== version) {
      throw new ConflictError('El documento cambió. Vuelve a abrir Cambio de CT.', 'PURCHASE_ORDER_COLOR_SIZE_CHANGE_STALE');
    }
    if (reason) throw new ApplicationError(reason, 'PURCHASE_ORDER_COLOR_SIZE_CHANGE_NOT_ALLOWED', this.storage.writable() ? 409 : 503);

    const cell = cells.find(({ lineId }) => lineId === input.lineId);
    if (!cell) {
      throw new ApplicationError('La partida no corresponde a una celda editable de CT.', 'INVALID_PURCHASE_ORDER_COLOR_SIZE_CELL', 422);
    }
    if (!Number.isInteger(input.quantity) || input.quantity < purchaseOrderColorSizeQuantityMin || input.quantity > purchaseOrderColorSizeQuantityMax) {
      throw new ApplicationError('La cantidad debe ser un entero en el rango admitido por CT.', 'INVALID_PURCHASE_ORDER_COLOR_SIZE_QUANTITY', 422);
    }
    if (cell.quantity !== input.quantity) {
      const updatedLines = lines.map((line) => line.id === cell.lineId
        ? { ...line, ordered: input.quantity, remaining: storageQuantity(input.quantity - line.fulfilled) }
        : line);
      const totals = stored?.totals ?? base.totals;
      const ordered = storageQuantity(totals.ordered + input.quantity - cell.quantity);
      await this.storage.saveColorSizeChange({
        id, number: base.number, revision: input.revision, legacyVersion: version, lines: updatedLines,
        totals: { ...totals, ordered, remaining: storageQuantity(ordered - totals.fulfilled) },
        amountInWords: stored?.amountInWords ?? null,
      }, purchaseOrderStockDifference(base, updatedLines, documentKind));
    }
    const order = await this.orders.findById(id);
    if (!order) throw new NotFoundError('Orden de compra');
    return order.toPrimitives();
  }
}
