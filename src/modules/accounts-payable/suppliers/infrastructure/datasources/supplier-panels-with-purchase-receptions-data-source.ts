import type { SupplierPanelKey } from '../../domain/repositories/supplier-panels-repository.js';
import { LegacyMysqlSupplierPanelsDataSource } from './legacy-mysql-supplier-panels-data-source.js';
import { purchaseReceptionSupplierCharges, type SupplierPurchaseReceptionCharge } from './purchase-reception-supplier-charges.js';

const money = (amount: number) => Number(amount.toFixed(2));

function balanceRow({ result: { reception }, movement: { header }, payable, days }: SupplierPurchaseReceptionCharge) {
  return {
    id: reception.id, company: header.company, document: reception.number, date: reception.dates.receivedAt,
    dueDate: payable.dueAt, days, originalAmount: payable.amount, amount: payable.amount,
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

export class SupplierPanelsWithPurchaseReceptionsDataSource extends LegacyMysqlSupplierPanelsDataSource {
  override async findPanel(supplierId: number, key: SupplierPanelKey) {
    const result = await super.findPanel(supplierId, key);
    if (!result || (key !== 'balance' && key !== 'movements')) return result;
    const charges = await purchaseReceptionSupplierCharges(supplierId);
    if (charges.length === 0) return result;

    const balance = charges.reduce((total, charge) => total + charge.payable.amount, 0);
    const supplier = { ...result.supplier, currentBalance: money(result.supplier.currentBalance + balance) };
    const local = key === 'balance' ? charges.map(balanceRow) : charges.map(movementRow);
    const items = [...result.items, ...local];
    if (key === 'movements') return { ...result, supplier, items };
    const summary = {
      ...result.summary,
      amount: money(Number(result.summary?.amount ?? 0) + balance),
      originalAmount: money(Number(result.summary?.originalAmount ?? 0) + balance),
    };
    return { ...result, supplier, items, summary };
  }
}
