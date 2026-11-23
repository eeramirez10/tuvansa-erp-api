import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  PurchaseOrderCreateInput, PurchaseOrderCreateLegacyDataSource, PurchaseOrderCreateStorage,
} from '../../domain/datasources/purchase-order-create-data-source.js';
import { buildPurchaseOrderEdit, productEditOptions } from '../../domain/entities/purchase-order-edit.js';
import type { PurchaseOrderProps } from '../../domain/entities/purchase-order.js';
import type { PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';

const invalid = (message: string) => new ApplicationError(message, 'INVALID_PURCHASE_ORDER', 422);

export class CreatePurchaseOrder {
  constructor(
    private readonly legacy: PurchaseOrderCreateLegacyDataSource,
    private readonly storage: PurchaseOrderCreateStorage,
    private readonly orders: PurchaseOrdersRepository,
  ) {}

  private async defaults() {
    const defaults = await this.legacy.creationDefaults();
    if (!defaults) throw new ApplicationError('El movimiento O no está disponible para compras.', 'PURCHASE_ORDER_MOVEMENT_UNAVAILABLE', 409);
    return defaults;
  }

  async get() {
    const { movement, today, from, dueAt, warehouse, taxPercentage, discountLocked, maxLines } = await this.defaults();
    return { movement, today, from, dueAt, warehouse, taxPercentage, discountLocked, maxLines, canWrite: this.storage.writable() };
  }

  private async supplier(code: string) {
    const [supplier] = await this.legacy.creationSuppliers(code, true);
    if (!supplier) throw new NotFoundError('Proveedor activo');
    return supplier;
  }

  async suppliers(query: string) {
    const [defaults, suppliers] = await Promise.all([this.defaults(), this.legacy.creationSuppliers(query)]);
    return suppliers.map(({ supplier, terms, taxType, rules, classifications }) => ({
      ...supplier, terms, taxType, agent: classifications[0]?.replace(/^1/, '') ?? '',
      taxPercentage: defaults.taxRates[taxType] ?? defaults.taxPercentage,
      discountPercentages: [...rules.supplierDiscounts, 0],
      currencyId: rules.currencyId, currencyName: rules.currencyName,
      priceLocked: rules.priceLocked, supplierUnits: rules.supplierUnits,
    }));
  }

  async products(code: string, query: string) {
    const { rules } = await this.supplier(code);
    return (await this.legacy.searchProducts(query, rules.supplierUnits)).map((product) => productEditOptions(product, rules, true));
  }

  async save(input: PurchaseOrderCreateInput) {
    if (!this.storage.writable()) throw new ApplicationError('El alta de órdenes requiere PostgreSQL.', 'PURCHASE_ORDER_POSTGRES_UNAVAILABLE', 503);
    const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const existing = await this.storage.findLocalRequest(input.requestKey, fingerprint);
    if (existing) return this.readSaved(existing.id);

    const [defaults, supplier, validWarehouse] = await Promise.all([
      this.defaults(), this.supplier(input.supplierCode), this.legacy.hasWarehouse(input.warehouse),
    ]);
    const { orderedAt, from, dueAt } = input;
    if ((defaults.periodStart && orderedAt < defaults.periodStart) || (defaults.periodEnd && orderedAt > defaults.periodEnd)) {
      throw invalid('La fecha de la orden está fuera del periodo de captura.');
    }
    if (orderedAt > from || from > dueAt) throw invalid('Las fechas deben estar en orden: Fecha, Desde y Vence.');
    if (!validWarehouse) throw invalid('El almacén no existe.');
    if (input.lines.some((line) => line.id !== null || line.quantity < 0)) {
      throw invalid('Cada partida nueva requiere una cantidad positiva y un producto del catálogo.');
    }
    const lines = input.lines.filter((line) => line.productCode && line.quantity > 0);
    if (lines.length === 0) throw invalid('Captura al menos una partida con cantidad mayor a cero.');
    if (defaults.maxLines > 0 && lines.length > defaults.maxLines) {
      throw invalid(`El movimiento permite hasta ${defaults.maxLines} partidas.`);
    }
    const { rules } = supplier;
    if (input.agent && `1${input.agent}` !== supplier.classifications[0] && !await this.legacy.hasPurchaseAgent(input.agent)) {
      throw invalid('El clasificador de compras no existe.');
    }
    const discountPercentages: [number, number, number] = defaults.discountLocked ? [...rules.supplierDiscounts, 0] : input.discountPercentages;
    const classifications = [...supplier.classifications];
    classifications[0] = `1${input.agent}`;
    const header: Omit<PurchaseOrderProps, 'id' | 'number'> = {
      supplierOrderNumber: input.supplierOrderNumber,
      supplier: supplier.supplier, documentKind: 'order', status: '0',
      received: { quantity: 0, pieces: 0 }, branch: 0, department: '', dates: { orderedAt, from, dueAt },
      warehouse: input.warehouse, initial: false, taxPercentage: input.taxPercentage, discountPercentages,
      otherLabel: input.otherLabel, classifications, lines: [],
      totals: {
        assigned: 0, ordered: 0, fulfilled: 0, remaining: 0, subtotal: 0, discount: 0, exciseTax: 0,
        freight: input.freight, insurance: input.insurance, other: input.other, tax: 0, total: 0,
      },
    };
    const products = await this.legacy.findProducts([...new Set(lines.map((line) => line.productCode))], rules.supplierUnits);
    const calculation = buildPurchaseOrderEdit({ ...header, id: 0, number: '' }, [], { lines, revision: 0, legacyVersion: '', removeZero: false }, rules, products,
      { initial: true, supplierTaxType: supplier.taxType });
    if (!calculation || calculation.lines.some((line) => line.ordered <= 0)) {
      throw invalid('Cada partida debe conservar una cantidad mayor a cero al convertir su unidad.');
    }
    const { stock, ...document } = calculation;
    const saved = await this.storage.create(input.requestKey, fingerprint, {
      header, document, stock,
      metadata: {
        rules, terms: supplier.terms, taxType: supplier.taxType, onAccount: input.onAccount, exchangeRate: defaults.exchangeRates[rules.currencyId] ?? 0,
        labels: defaults.labels, createdAt: defaults.today,
      },
    });
    return this.readSaved(saved.id);
  }

  private async readSaved(id: number) {
    const saved = await this.orders.findById(id);
    if (!saved) throw new NotFoundError('Orden de compra');
    return saved.toPrimitives();
  }
}
