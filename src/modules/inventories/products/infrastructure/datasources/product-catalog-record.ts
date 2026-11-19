import type { ProductProps } from '../../domain/entities/product.js';
import type { ProductWriteValues } from '../../domain/repositories/products-repository.js';

export type ProductUnit = ProductProps['classification']['unit'] & { usesColorAndSize: boolean };

export const blankProduct = (id: number, date: string): ProductProps => ({
  id,
  code: '',
  description: '',
  isActive: true,
  deactivatedAt: null,
  classification: {
    type: 'rawMaterial', familyCode: '', unit: { id: 0, code: '', description: '' },
    usesColorAndSize: false, hasPhoto: false,
  },
  prices: {
    sale: [
      { amount: 0, currencyId: 0 },
      { amount: 0, currencyId: 0 },
      { amount: 0, currencyId: 0 },
    ],
    costs: { average: 0, last: 0, previous: 0, currencyId: 0, adValorem: 0 },
  },
  warehouse: {
    minimum: 0, maximum: 0, location: '', ean: '', upc: '',
    accounts: { primary: '', secondary: '', costOfSales: '' },
  },
  accumulated: {
    lastPurchaseAt: null, lastSaleAt: null, assigned: 0, confirmed: 0,
    customerOrders: 0, customerQuotes: 0, supplierOrders: 0, supplierQuotes: 0,
    currentStock: 0, previousStock: 0, accumulatedStock: 0, previousQuantity: 0,
    accumulatedQuantity: 0, pieceStock: 0, salesLastSixMonths: 0, inventoryDays: 0,
  },
  createdAt: date,
});

export const applyProductWriteValues = (
  previous: ProductProps,
  values: ProductWriteValues,
  unit?: ProductUnit,
): ProductProps => {
  const { classification, prices, warehouse } = previous;
  return {
    ...previous,
    code: values.code ?? previous.code,
    description: values.description ?? previous.description,
    classification: {
      type: values.type ?? classification.type,
      familyCode: values.familyCode ?? classification.familyCode,
      unit: unit ? { id: unit.id, code: unit.code, description: unit.description } : classification.unit,
      usesColorAndSize: unit?.usesColorAndSize ?? classification.usesColorAndSize,
      hasPhoto: values.hasPhoto ?? classification.hasPhoto,
    },
    prices: {
      sale: [
        { amount: values.salePrice1 ?? prices.sale[0].amount, currencyId: values.saleCurrency1 ?? prices.sale[0].currencyId },
        { amount: values.salePrice2 ?? prices.sale[1].amount, currencyId: values.saleCurrency2 ?? prices.sale[1].currencyId },
        { amount: values.salePrice3 ?? prices.sale[2].amount, currencyId: values.saleCurrency3 ?? prices.sale[2].currencyId },
      ],
      costs: {
        average: values.averageCost ?? prices.costs.average,
        last: values.lastCost ?? prices.costs.last,
        previous: values.previousCost ?? prices.costs.previous,
        currencyId: values.costCurrency ?? prices.costs.currencyId,
        adValorem: values.adValorem ?? prices.costs.adValorem,
      },
    },
    warehouse: {
      minimum: values.minimum ?? warehouse.minimum,
      maximum: values.maximum ?? warehouse.maximum,
      location: values.location ?? warehouse.location,
      ean: values.ean ?? warehouse.ean,
      upc: values.upc ?? warehouse.upc,
      accounts: {
        primary: values.primaryAccount ?? warehouse.accounts.primary,
        secondary: values.secondaryAccount ?? warehouse.accounts.secondary,
        costOfSales: values.costOfSalesAccount ?? warehouse.accounts.costOfSales,
      },
    },
  };
};
