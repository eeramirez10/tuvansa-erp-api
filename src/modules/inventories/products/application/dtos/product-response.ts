import type { Product, ProductProps } from '../../domain/entities/product.js';

export type ProductResponse = ProductProps;

export const toProductResponse = (product: Product): ProductResponse => product.toPrimitives();
