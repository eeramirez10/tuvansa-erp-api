import type { SupplierPanelKey, SupplierPanelResult } from '../../domain/repositories/supplier-panels-repository.js';
import { LegacyMysqlSupplierPanelsDataSource } from './legacy-mysql-supplier-panels-data-source.js';
import { supplierCatalogRecord } from './postgres-supplier-catalog-data-source.js';
import {
  purchaseReceptionSupplierCharges, type SupplierPurchaseReceptionCharge, type SupplierPurchaseReceptionPayment,
} from './purchase-reception-supplier-charges.js';

const money = (amount: number) => Number(amount.toFixed(2));

function balanceRow(charge: SupplierPurchaseReceptionCharge) {
  return {
    id: charge.id, company: charge.company, document: charge.number, date: charge.date,
    receiptId: charge.id, canPay: true,
    dueDate: charge.dueAt, days: charge.days, originalAmount: charge.principal, amount: charge.remaining,
    currency: charge.currencyId, reference: charge.orderNumber || charge.supplierReference, scheduledAt: null,
    secondaryReference: '', route: '', exchangeRate: charge.exchangeRate, folio: charge.supplierReference,
  };
}

function movementRow(charge: SupplierPurchaseReceptionCharge) {
  return {
    id: charge.id, company: charge.company, date: charge.date, document: charge.number,
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
    const original = movementRow(charge);
    const movements = [{ createdAt: charge.createdAt, row: original }];
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
      ...original, id: cancellation.id, date: cancellation.date, amount: -charge.principal, movementType: charge.movementType === 'GA' ? 'CG' : 'K',
      policy: cancellation.policyNumber, policyId: cancellation.id, userId: cancellation.userId,
      paymentReference: cancellation.reason,
    } });
    return movements;
  }).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.row.id - right.row.id)
    .map(({ row }) => row);
}

export class SupplierPanelsWithPurchaseReceptionsDataSource extends LegacyMysqlSupplierPanelsDataSource {
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
      ...(key === 'various' && !local.legacy ? { detail: {
        tolerancePercent: local.tolerancePercent, vatType: local.vatCode, vatWithholdingPercent: local.withheldVat,
        incomeTaxWithholdingPercent: local.withheldIncomeTax, interCompany: local.intercompany,
      } } : {}),
    } : base;
    if (!result || (key !== 'balance' && key !== 'movements')) return result;
    const charges = await purchaseReceptionSupplierCharges(supplierId);
    if (charges.length === 0) return result;

    const balance = charges.reduce((total, charge) => total + charge.remaining, 0);
    const supplier = { ...result.supplier, currentBalance: money(result.supplier.currentBalance + balance) };
    if (key === 'movements') return { ...result, supplier, items: [...result.items, ...localMovements(charges)] };

    const open = charges.filter(({ remaining }) => remaining > 0).map(balanceRow);
    const summary = {
      ...result.summary,
      amount: money(Number(result.summary?.amount ?? 0) + balance),
      originalAmount: money(Number(result.summary?.originalAmount ?? 0) + open.reduce((total, { originalAmount }) => total + originalAmount, 0)),
    };
    return { ...result, supplier, items: [...result.items, ...open], summary };
  }
}
