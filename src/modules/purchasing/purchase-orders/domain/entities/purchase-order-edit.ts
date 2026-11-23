import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { amountInWords } from '../../../../../shared/domain/format/amount-in-words.js';
import type {
  PurchaseOrderEditInput, PurchaseOrderEditProduct, PurchaseOrderEditRules, PurchaseOrderStockChange,
} from '../datasources/purchase-order-edit-data-source.js';
import type { PurchaseOrderLine, PurchaseOrderProps } from './purchase-order.js';

const round = (value: number, digits: number) => {
  const precision = 10 ** digits;
  return Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * precision) / precision;
};
const invalidLine = (message: string) => new ApplicationError(message, 'INVALID_PURCHASE_ORDER_LINE', 422);

export function stockAfterPurchaseOrderRemoval(legacyLines: PurchaseOrderLine[]): PurchaseOrderStockChange[] {
  const stock = new Map<number, number>();
  for (const line of legacyLines) {
    const remaining = Math.max(line.ordered - line.fulfilled, 0);
    stock.set(line.productId, round((stock.get(line.productId) ?? 0) - remaining, 3));
  }
  return [...stock].filter(([, pending]) => pending !== 0)
    .map(([productId, pending]) => ({ productId, pending, nextReceiptAt: null }));
}

export const displayPurchaseOrderEditLines = (lines: PurchaseOrderLine[]) => lines.map((line) => {
  const factor = line.factor || 1;
  return {
    id: line.id, productCode: line.productCode, description: line.description, unit: line.unit, branch: line.branch, factor,
    quantity: round(line.ordered / factor, 3), price: round(line.price * factor, 5), discount: line.discount,
    pieces: line.piecesAssignment ?? '',
  };
});

function initialPurchasePrice(product: PurchaseOrderEditProduct, rules: PurchaseOrderEditRules, creation = false) {
  const discountFactor = rules.supplierDiscounts.reduce((factor, discount) => factor * (1 - discount / 100), 1);
  // MOCOM/41 inicia la cotización en ILISTA5 o ILISTA6 antes de las reglas especiales de proveedor.
  if (product.currencyId > 1 && !creation) return product.dollarCost;
  return discountFactor === 0 ? null : (product.currencyId > 1 ? product.dollarCost : product.cost) / discountFactor;
}

const productEligible = (product: PurchaseOrderEditProduct, rules: PurchaseOrderEditRules) =>
  !product.inactive && (!rules.validateSupplier || !product.supplierCode || product.supplierCode === rules.supplierCode);

export function productEditOptions(product: PurchaseOrderEditProduct, rules: PurchaseOrderEditRules, creation = false) {
  const basePrice = initialPurchasePrice(product, rules, creation);
  return {
    code: product.code, description: product.description, eligible: productEligible(product, rules), taxable: product.taxable,
    exciseTaxPercentage: product.exciseTaxPercentage ?? 0,
    defaultUnit: product.units.some(({ code }) => code === product.secondaryUnit)
      ? product.secondaryUnit : product.units[0]?.code ?? '',
    units: product.units.map(({ code, factor }) => ({ code, factor, suggestedPrice: basePrice === null ? null : round(basePrice * factor, 5) })),
  };
}

function purchaseUnitFactor(product: PurchaseOrderEditProduct, unit: string, rules: PurchaseOrderEditRules) {
  const configured = product.units.find((option) => option.code === unit)?.factor;
  return configured ?? (rules.supplierUnits && /^\d{3}$/.test(unit) ? Number(unit) || 1 : undefined);
}

export function buildPurchaseOrderEdit(
  base: PurchaseOrderProps, current: PurchaseOrderLine[], input: PurchaseOrderEditInput,
  rules: PurchaseOrderEditRules, products: PurchaseOrderEditProduct[],
  capture?: { initial: boolean; supplierTaxType: number },
) {
  const creation = capture?.initial ?? false;
  const byCode = new Map(products.map((product) => [product.code.trim().toUpperCase(), product]));
  const byId = new Map(current.map((line) => [line.id, line]));
  const displayed = new Map(displayPurchaseOrderEditLines(current).map((line) => [line.id, line]));
  const seen = new Set<number>();
  const lines: PurchaseOrderLine[] = [];
  let changed = false;

  for (const [index, draft] of input.lines.entries()) {
    const prior = draft.id === null ? undefined : byId.get(draft.id);
    if (draft.id !== null) {
      if (!prior || seen.has(draft.id)) throw invalidLine(`Partida inválida o repetida en el renglón ${index + 1}.`);
      seen.add(draft.id);
    }
    if (draft.productCode === '' || (prior && input.removeZero && draft.quantity === 0)) {
      changed ||= prior !== undefined;
      continue;
    }
    const product = byCode.get(draft.productCode);
    if (!product) throw invalidLine(`El producto ${draft.productCode} no existe.`);
    const previous = prior && displayed.get(prior.id);
    const sameProduct = product.id === prior?.productId;
    const sameUnit = sameProduct && draft.unit === prior?.unit;
    // El editor muestra menos decimales que algunos valores almacenados. Un campo intacto conserva su valor original.
    if (prior && sameUnit && previous &&
      previous.quantity === draft.quantity && previous.price === draft.price &&
      previous.discount === draft.discount && previous.branch === draft.branch && previous.pieces === draft.pieces) {
      lines.push(prior);
      continue;
    }
    if (!sameProduct && !productEligible(product, rules)) {
      throw invalidLine(`El producto ${draft.productCode} está inactivo para compras o no corresponde al proveedor.`);
    }
    const unitFactor = sameUnit ? prior?.factor || 1 : purchaseUnitFactor(product, draft.unit, rules);
    if (!unitFactor || unitFactor < 0 || !Number.isFinite(unitFactor)) throw invalidLine(`Unidad inválida para ${draft.productCode}.`);
    if (rules.priceLocked && prior && sameProduct && (
      draft.discount !== prior.discount || (sameUnit && draft.price !== previous?.price)
    )) throw invalidLine(`El precio y el descuento están bloqueados en ${draft.productCode}.`);
    const automaticPrice = rules.priceLocked && !sameProduct ? initialPurchasePrice(product, rules, creation) : null;
    if (rules.priceLocked && !sameProduct && automaticPrice === null) {
      throw invalidLine(`No hay un precio de compra disponible para ${draft.productCode}.`);
    }
    const ordered = sameUnit && previous?.quantity === draft.quantity && prior ? prior.ordered : round(draft.quantity * unitFactor, 3);
    const price = rules.priceLocked && prior && sameProduct ? prior.price
      : sameUnit && previous?.price === draft.price && prior ? prior.price
      : round(automaticPrice ?? draft.price / unitFactor, 5);
    const fulfilled = prior?.fulfilled ?? 0;
    // MOCOM/40 → MBASE/121 → /71. El alta usa el valor predeterminado de PLASIGNPZAS.
    const pieces = prior || creation ? draft.pieces : '';
    changed = true;
    lines.push({
      id: prior?.id ?? 0, productId: product.id, productCode: product.code, description: product.description,
      ordered, fulfilled, remaining: round(ordered - fulfilled, 3),
      unit: draft.unit, classCode: prior?.classCode ?? '', branch: draft.branch, price,
      discount: rules.priceLocked && !sameProduct ? 0 : draft.discount,
      currencyId: rules.currencyId || product.currencyId,
      currencyName: rules.currencyId ? rules.currencyName : product.currencyName,
      confirmed: prior?.confirmed ?? false, assigned: prior?.assigned ?? 0,
      observations: pieces, piecesAssignment: pieces,
      factor: sameUnit && prior ? prior.factor : unitFactor,
      supplierProductCode: product.supplierProductCode,
    });
  }
  if (seen.size !== current.length) throw invalidLine('Faltan partidas de la orden. Para retirar una partida borra su código.');
  if (!changed) return null;

  const totals = { ...base.totals, assigned: 0, ordered: 0, fulfilled: 0, remaining: 0, subtotal: 0, discount: 0, tax: 0, total: 0 };
  const discountFactor = base.discountPercentages.reduce((factor, value) => factor * (1 - value / 100), 1);
  if (capture) {
    totals.exciseTax = capture.supplierTaxType === 2 ? 0 : round(lines.reduce((total, line) => {
      const rate = byCode.get(line.productCode.trim().toUpperCase())?.exciseTaxPercentage ?? 0;
      return total + line.ordered * line.price * (1 - line.discount / 100) * rate / 100;
    }, 0) * discountFactor, 2);
  }
  const charges = totals.exciseTax + totals.freight + totals.insurance + totals.other;
  const taxRate = base.taxPercentage / 100;
  totals.tax = round(charges * taxRate, 2);
  for (const line of lines) {
    totals.ordered = round(totals.ordered + line.ordered, 3);
    totals.fulfilled = round(totals.fulfilled + line.fulfilled, 3);
    totals.assigned = round(totals.assigned + line.assigned, 3);
    const net = line.ordered * line.price * (1 - line.discount / 100);
    totals.subtotal = round(totals.subtotal + net, 2);
    if (byCode.get(line.productCode.trim().toUpperCase())?.taxable) totals.tax = round(totals.tax + net * discountFactor * taxRate, 2);
  }
  totals.remaining = round(totals.ordered - totals.fulfilled, 3);
  totals.discount = round(totals.subtotal * (1 - discountFactor), 2);
  totals.total = round(totals.subtotal - totals.discount + charges + totals.tax, 2);
  if (!Number.isSafeInteger(Math.round(totals.total * 100))) throw invalidLine('El total excede el rango de importes admitido.');
  const totalInWords = (totals.total < 0 ? 'MENOS ' : '') + amountInWords(Math.abs(totals.total));

  return { lines, totals, amountInWords: totalInWords, stock: purchaseOrderStockDifference(base, lines) };
}

export function purchaseOrderStockDifference(
  base: PurchaseOrderProps, lines: PurchaseOrderLine[], target = base.documentKind,
): PurchaseOrderStockChange[] {
  const stock = new Map<number, PurchaseOrderStockChange>();
  const conversion = target !== base.documentKind;
  for (const [items, sign, kind] of [[base.lines, -1, base.documentKind], [lines, 1, target]] as const) {
    for (const line of items) {
      const item = stock.get(line.productId) ?? { productId: line.productId, pending: 0, nextReceiptAt: null };
      const remainder = line.ordered - line.fulfilled;
      const adjustment = (conversion ? remainder : Math.max(remainder, 0)) * sign;
      if (kind === 'quote') item.quotes = round((item.quotes ?? 0) + adjustment, 3);
      else item.pending = round(item.pending + adjustment, 3);
      if (sign === 1 && line.id === 0) item.nextReceiptAt = base.dates.from;
      stock.set(line.productId, item);
    }
  }
  return [...stock.values()];
}
