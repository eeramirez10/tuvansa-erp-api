export const productClassificationKeys = [...'123456789ABCDEFGHIJK'];

export interface ProductClassificationOption {
  id: number;
  key: string;
  code: string;
  number: string;
  description: string;
  parent: string;
}

export type ProductClassificationAssignments = Record<string, string>;

export interface ProductClassificationCatalog {
  product: { id: number; code: string; description: string };
  familyCode: string;
  recalculateFamily: boolean;
  assignments: ProductClassificationAssignments;
  labels: Record<string, string>;
  options: ProductClassificationOption[];
}

export interface StoredProductClassification {
  revision: number;
  familyCode: string | null;
  changes: ProductClassificationAssignments;
}

export interface ProductClassificationRepository {
  catalog(productId: number): Promise<ProductClassificationCatalog | null>;
  writable(productId: number): boolean | Promise<boolean>;
  get(productId: number): Promise<StoredProductClassification | null>;
  save(productId: number, classification: StoredProductClassification): Promise<StoredProductClassification>;
}
