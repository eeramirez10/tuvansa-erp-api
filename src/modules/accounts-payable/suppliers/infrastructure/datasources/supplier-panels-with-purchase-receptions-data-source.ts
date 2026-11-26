import type { SupplierPanelKey, SupplierPanelResult } from '../../domain/repositories/supplier-panels-repository.js';
import { readHistoricalReceptionCancellations, type HistoricalReceiptCancellation } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/historical-purchase-reception-cancellation-reads.js';
import { postgresConfigured } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { readSupplierGroupingMovements } from '../../../../../shared/infrastructure/datasources/supplier-balance-grouping-reads.js';
import { supplierGroupingBalanceItems, supplierGroupingMovementRows } from './postgres-supplier-balance-grouping.js';
import { projectSupplierActivity } from '../../domain/entities/supplier-activity.js';
import { blankSupplierVarious } from '../../domain/entities/supplier-catalog.js';
import { LegacyMysqlSupplierPanelsDataSource } from './legacy-mysql-supplier-panels-data-source.js';
import { supplierCatalogRecord } from './postgres-supplier-catalog-data-source.js';
import { readSupplierClassifications } from './mysql-supplier-catalog-references.js';
import {
  purchaseReceptionSupplierCharges, type SupplierPurchaseReceptionCharge, type SupplierPurchaseReceptionPayment,
} from './purchase-reception-supplier-charges.js';

const money = (amount: number) => Number(amount.toFixed(2));

function balanceRow(charge: SupplierPurchaseReceptionCharge) {
  return {
    id: charge.id, company: charge.company, document: charge.number, date: charge.date,
    receiptId: charge.id, canPay: charge.canPay,
    dueDate: charge.dueAt, days: charge.days, originalAmount: charge.principal, amount: charge.remaining,
    currency: charge.currencyId, reference: charge.orderNumber || charge.supplierReference, scheduledAt: null,
    secondaryReference: '', route: '', exchangeRate: charge.exchangeRate, folio: charge.supplierReference,
  };
}

function movementRow(charge: SupplierPurchaseReceptionCharge) {
  return {
    id: charge.sourceMovementId ?? charge.id, company: charge.company, date: charge.date, document: charge.number,
    ...(charge.historicalTransferIn ? { receiptId: charge.id } : {}),
    amount: charge.principal, movementType: charge.movementType, paymentReference: charge.orderNumber || charge.supplierReference,
    userId: charge.userId, exchangeDifference: 0, exchangeRate: charge.exchangeRate,
    policy: charge.policyNumber ?? '', policyId: charge.policyId, documentReference: charge.supplierReference,
    accountType: 0, currency: charge.currencyId,
    ...(charge.cancellation ? { cancellation: charge.cancellation } : {}),
  };
}

function paymentRow(charge: SupplierPurchaseReceptionCharge, payment: SupplierPurchaseReceptionPayment) {
  return {
    id: payment.id, company: charge.company, date: payment.date, document: charge.number,
    amount: -payment.amount, movementType: 'PP', paymentReference: payment.number,
    userId: payment.userId, exchangeDifference: 0, exchangeRate: charge.exchangeRate,
    policy: payment.policyNumber, policyId: payment.id, documentReference: charge.supplierReference,
    accountType: 0, currency: charge.currencyId,
    paymentId: payment.id, canReverse: true,
    ...(payment.reversal ? { reversal: payment.reversal } : {}),
  };
}

function localMovements(charges: SupplierPurchaseReceptionCharge[]) {
  return charges.flatMap((charge) => {
    if (charge.historicalTransferOut) return [];
    const original = movementRow(charge);
    const movements = charge.historicalDocumentation ? [] : [{ createdAt: charge.createdAt, row: original }];
    const documentation = charge.documentation;
    if (documentation) movements.push({ createdAt: documentation.createdAt, row: {
      ...original, id: documentation.id, date: documentation.date, amount: -documentation.amount,
      movementType: 'DO', policy: '', policyId: null, userId: documentation.userId, paymentReference: '',
    } });
    for (const payment of charge.payments) {
      movements.push({ createdAt: payment.createdAt, row: paymentRow(charge, payment) });
      const reversal = payment.reversal;
      if (reversal) movements.push({ createdAt: reversal.createdAt, row: {
        ...original, id: reversal.id, date: reversal.date, amount: payment.amount, movementType: 'RP',
        policy: reversal.policyNumber, policyId: reversal.id, userId: reversal.userId, paymentReference: payment.number,
      } });
    }
    const cancellation = charge.cancellation;
    if (cancellation) movements.push({ createdAt: cancellation.createdAt, row: {
      ...original, id: cancellation.id, date: cancellation.date, amount: -charge.principal,
      movementType: charge.movementType === 'GA' ? 'CG' : charge.movementType === '3' ? '3' : 'K',
      policy: cancellation.policyNumber, policyId: cancellation.policyId ?? cancellation.id, userId: cancellation.userId,
      paymentReference: cancellation.reason,
    } });
    return movements;
  }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.row.id - right.row.id)
    .map(({ row }) => row);
}

function historicalCancellationRow(
  { receiptId, number, supplierReference, amount, result, userId }: HistoricalReceiptCancellation,
  original?: Record<string, unknown>,
) {
  return {
    id: result.id, receiptId, company: original?.company ?? 1, date: result.date, document: number,
    amount: -amount, movementType: 'K', paymentReference: result.reason, userId, exchangeDifference: 0,
    exchangeRate: original?.exchangeRate ?? 1, policy: result.policyNumber, policyId: result.id,
    documentReference: supplierReference, accountType: original?.accountType ?? 2, currency: original?.currency ?? 1,
  };
}

function historicalCancellationMovements(cancellations: HistoricalReceiptCancellation[], items: SupplierPanelResult['items']) {
  const originalCharges = new Map(items.filter(({ movementType }) => movementType === 'RA')
    .map((item) => [Number(item.receiptId), item]));
  return cancellations.map((cancellation) => historicalCancellationRow(cancellation, originalCharges.get(cancellation.receiptId)));
}

export class SupplierPanelsWithPurchaseReceptionsDataSource extends LegacyMysqlSupplierPanelsDataSource {
  override async findClassifications(id: number, position: number) {
    const local = await supplierCatalogRecord(id);
    if (!local) {
      const panel = await super.findClassifications(id, position);
      return panel && { ...panel, canWrite: postgresConfigured() && Boolean(panel.supplier.code) };
    }
    if (local.deleted) return null;
    const current = local.classifications ?? (local.legacy ? await readSupplierClassifications(id) : Array<string>(9).fill(''));
    if (!current) return null;
    const { code, name, totals } = local.supplier;
    return this.classificationPanel({ id, code, name, currentBalance: totals.currentBalance }, position, current, local.revision, true);
  }

  override async findPanel(supplierId: number, key: SupplierPanelKey) {
    const local = await supplierCatalogRecord(supplierId);
    if (local?.deleted) return null;
    const base = local && !local.legacy ? null : await super.findPanel(supplierId, key);
    const record = local?.supplier;
    const result: SupplierPanelResult | null = local && record && (!local.legacy || base) ? {
      ...base, items: base?.items ?? [],
      supplier: { id: record.id, code: record.code, name: record.name, currentBalance: base?.supplier.currentBalance ?? 0 },
      ...(key === 'discounts' ? { detail: { discount1: record.terms.discounts[0], discount2: record.terms.discounts[1] } } : {}),
      ...(key === 'block-status' && !local.legacy ? { detail: { isActive: record.isActive, deactivatedAt: record.deactivatedAt } } : {}),
    } : base;
    if (result && key === 'various') {
      const fields = local?.various ?? (local && !local.legacy ? blankSupplierVarious(local) : result.detail);
      return {
        ...result,
        detail: {
          ...result.detail, ...fields,
          banamexId: fields?.banamexId ?? result.detail?.banamexId ?? 0,
          ...(local?.variousWrite ? { changedOn: local.variousWrite.date } : {}),
          revision: local?.revision ?? 0, canWrite: postgresConfigured() && Boolean(result.supplier.code),
        },
      };
    }
    if (result && (key === 'events' || key === 'contacts')) {
      return {
        ...result, items: [...projectSupplierActivity(result.items, local?.activity ?? [], key).values()],
        detail: { canWrite: postgresConfigured() && Boolean(result.supplier.code) },
      };
    }
    if (result && key === 'invoices') {
      const groupings = await readSupplierGroupingMovements({ supplierId });
      const settled = new Map(groupings.filter(({ amount }) => amount < 0).map((movement) => [movement.receiptId, movement]));
      return { ...result, items: result.items.map((row) => {
        const movement = settled.get(Number(row.id));
        return movement && movement.document === row.document && (!row.paidAt || row.paidAt === '1900-12-31')
          ? { ...row, paidAt: movement.date } : row;
      }) };
    }
    if (!result || (key !== 'balance' && key !== 'movements')) return result;
    const [charges, historical, groupings] = await Promise.all([
      purchaseReceptionSupplierCharges(supplierId), readHistoricalReceptionCancellations({ supplierIds: [supplierId] }),
      readSupplierGroupingMovements({ supplierId }),
    ]);

    const movedOut = new Set(charges.filter((charge) => charge.historicalTransferOut).map((charge) => charge.id));
    const projectedReversals = new Set(charges.filter((charge) => charge.historicalTransferIn && charge.cancellation).map((charge) => charge.id));
    const separateReversals = historical.filter(({ receiptId }) => !projectedReversals.has(receiptId));
    const balance = charges.reduce((total, charge) => total + charge.remaining, 0);
    const reversed = separateReversals.reduce((total, cancellation) => total + cancellation.amount, 0);
    const supplier = { ...result.supplier, currentBalance: money(result.supplier.currentBalance + balance - reversed) };
    if (key === 'movements') {
      const visible = result.items.filter(({ receiptId }) => !movedOut.has(Number(receiptId)));
      return {
        ...result, supplier,
        items: [...visible, ...localMovements(charges), ...historicalCancellationMovements(separateReversals, visible),
          ...supplierGroupingMovementRows(groupings)],
      };
    }

    const canceledIds = new Set(historical.map(({ receiptId }) => receiptId));
    const open = charges.filter(({ id, remaining }) => remaining > 0 && !canceledIds.has(id)).map(balanceRow);
    for (const receiptId of movedOut) canceledIds.add(receiptId);
    for (const charge of charges) {
      if (charge.historicalDocumentation && charge.documentation) canceledIds.add(charge.documentation.sourceId);
    }
    const visible = supplierGroupingBalanceItems(
      result.items.filter(({ id }) => !canceledIds.has(Number(id))), groupings, postgresConfigured(),
    );
    const items = [...visible, ...open];
    const summary = {
      ...result.summary,
      amount: money(items.reduce((sum, row) => sum + Number(row.amount ?? 0), 0)),
      originalAmount: money(items.reduce((sum, row) => sum + Number(row.originalAmount ?? 0), 0)),
    };
    return { ...result, supplier, items, summary };
  }
}
