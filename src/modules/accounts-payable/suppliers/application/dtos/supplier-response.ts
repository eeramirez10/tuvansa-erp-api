import type { Supplier, SupplierProps } from '../../domain/entities/supplier.js';

export type SupplierResponse = SupplierProps;

export const toSupplierResponse = (supplier: Supplier): SupplierResponse => supplier.toPrimitives();
