import type { SupplierPanelKey } from '../../domain/repositories/supplier-panels-repository.js';
import { LegacyMysqlSupplierPanelsDataSource } from './legacy-mysql-supplier-panels-data-source.js';
import {
  purchaseReceptionSupplierCharges, type SupplierPurchaseReceptionCharge, type SupplierPurchaseReceptionPayment,
} from './purchase-reception-supplier-charges.js';

const money = (amount: number) => Number(amount.toFixed(2));

function balanceRow({ result: { reception }, movement: { header }, payable, days, remaining }: SupplierPurchaseReceptionCharge) {
  return {
    id: reception.id, company: header.company, document: reception.number, date: reception.dates.receivedAt,
    receiptId: reception.id, canPay: true,
    dueDate: payable.dueAt, days, originalAmount: payable.amount, amount: remaining,
    currency: payable.currencyId, reference: reception.orderNumber, scheduledAt: null,
    secondaryReference: '', route: '', exchangeRate: payable.exchangeRate, folio: reception.supplierReference,
  };
}

function movementRow({ result: { reception }, movement: { header }, payable, accounting }: SupplierPurchaseReceptionCharge) {
  return {
    id: reception.id, company: header.company, date: reception.dates.receivedAt, document: reception.number,
    amount: payable.amount, movementType: header.type, paymentReference: reception.orderNumber,
    userId: header.userId, exchangeDifference: 0, exchangeRate: payable.exchangeRate,
    policy: accounting?.number ?? '', documentReference: reception.supplierReference,
    accountType: 0, currency: payable.currencyId,
  };
}

function paymentRow(charge: SupplierPurchaseReceptionCharge, payment: SupplierPurchaseReceptionPayment) {
  const { result: { reception }, movement: { header }, payable } = charge;
  return {
    id: payment.id, company: header.company, date: payment.date, document: reception.number,
    amount: -payment.amount, movementType: 'PP', paymentReference: payment.number,
    userId: payment.userId, exchangeDifference: 0, exchangeRate: payable.exchangeRate,
    policy: payment.policyNumber, documentReference: reception.supplierReference,
    accountType: 0, currency: payable.currencyId,
  };
}

function localMovements(charges: SupplierPurchaseReceptionCharge[]) {
  return charges.flatMap((charge) => [
    { createdAt: charge.createdAt, row: movementRow(charge) },
    ...charge.payments.map((payment) => ({ createdAt: payment.createdAt, row: paymentRow(charge, payment) })),
  ]).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.row.id - right.row.id)
    .map(({ row }) => row);
}

export class SupplierPanelsWithPurchaseReceptionsDataSource extends LegacyMysqlSupplierPanelsDataSource {
  override async findPanel(supplierId: number, key: SupplierPanelKey) {
    const result = await super.findPanel(supplierId, key);
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
