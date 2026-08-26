import type { ProductType } from '../../domain/entities/product.js';
import type {
  ProductCreateValues,
  ProductWriteValues,
} from '../../domain/repositories/products-repository.js';

type OptionalValues<T> = { [Key in keyof T]?: T[Key] | undefined };

export interface ProductMutationInput {
  code?: string | undefined;
  description?: string | undefined;
  classification?: OptionalValues<{
    type: ProductType;
    unitId: number;
    familyCode: string;
    hasPhoto: boolean;
  }> | undefined;
  prices?: {
    sale?: [
      OptionalValues<{ amount: number; currencyId: number }>,
      OptionalValues<{ amount: number; currencyId: number }>,
      OptionalValues<{ amount: number; currencyId: number }>,
    ] | undefined;
    costs?: OptionalValues<{
      average: number;
      last: number;
      previous: number;
      currencyId: number;
      adValorem: number;
    }> | undefined;
  } | undefined;
  warehouse?: OptionalValues<{
    minimum: number;
    maximum: number;
    location: string;
    ean: string;
    upc: string;
    accounts: OptionalValues<{
      primary: string;
      secondary: string;
      costOfSales: string;
    }>;
  }> | undefined;
}

export interface CreateProductInput extends ProductMutationInput {
  code: string;
  description: string;
}

export type UpdateProductInput = ProductMutationInput;

export const toProductWriteValues = (input: ProductMutationInput): ProductWriteValues => ({
  ...(input.code === undefined ? {} : { code: input.code }),
  ...(input.description === undefined ? {} : { description: input.description }),
  ...(input.classification?.type === undefined ? {} : { type: input.classification.type }),
  ...(input.classification?.unitId === undefined
    ? {} : { unitId: input.classification.unitId }),
  ...(input.classification?.familyCode === undefined
    ? {} : { familyCode: input.classification.familyCode }),
  ...(input.classification?.hasPhoto === undefined
    ? {} : { hasPhoto: input.classification.hasPhoto }),
  ...(input.prices?.sale?.[0].amount === undefined
    ? {} : { salePrice1: input.prices.sale[0].amount }),
  ...(input.prices?.sale?.[1].amount === undefined
    ? {} : { salePrice2: input.prices.sale[1].amount }),
  ...(input.prices?.sale?.[2].amount === undefined
    ? {} : { salePrice3: input.prices.sale[2].amount }),
  ...(input.prices?.sale?.[0].currencyId === undefined
    ? {} : { saleCurrency1: input.prices.sale[0].currencyId }),
  ...(input.prices?.sale?.[1].currencyId === undefined
    ? {} : { saleCurrency2: input.prices.sale[1].currencyId }),
  ...(input.prices?.sale?.[2].currencyId === undefined
    ? {} : { saleCurrency3: input.prices.sale[2].currencyId }),
  ...(input.prices?.costs?.average === undefined
    ? {} : { averageCost: input.prices.costs.average }),
  ...(input.prices?.costs?.last === undefined ? {} : { lastCost: input.prices.costs.last }),
  ...(input.prices?.costs?.previous === undefined
    ? {} : { previousCost: input.prices.costs.previous }),
  ...(input.prices?.costs?.currencyId === undefined
    ? {} : { costCurrency: input.prices.costs.currencyId }),
  ...(input.prices?.costs?.adValorem === undefined
    ? {} : { adValorem: input.prices.costs.adValorem }),
  ...(input.warehouse?.minimum === undefined ? {} : { minimum: input.warehouse.minimum }),
  ...(input.warehouse?.maximum === undefined ? {} : { maximum: input.warehouse.maximum }),
  ...(input.warehouse?.location === undefined ? {} : { location: input.warehouse.location }),
  ...(input.warehouse?.ean === undefined ? {} : { ean: input.warehouse.ean }),
  ...(input.warehouse?.upc === undefined ? {} : { upc: input.warehouse.upc }),
  ...(input.warehouse?.accounts?.primary === undefined
    ? {} : { primaryAccount: input.warehouse.accounts.primary }),
  ...(input.warehouse?.accounts?.secondary === undefined
    ? {} : { secondaryAccount: input.warehouse.accounts.secondary }),
  ...(input.warehouse?.accounts?.costOfSales === undefined
    ? {} : { costOfSalesAccount: input.warehouse.accounts.costOfSales }),
});

export const toProductCreateValues = (input: CreateProductInput): ProductCreateValues => ({
  ...toProductWriteValues(input),
  code: input.code,
  description: input.description,
});
