import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import type {
  ProductsRepository,
  ProductWriteValues,
} from '../../domain/repositories/products-repository.js';

export const validateProductValues = async (
  repository: ProductsRepository,
  values: ProductWriteValues,
): Promise<void> => {
  if (values.unitId !== undefined && !(await repository.unitExists(values.unitId))) {
    throw new ConflictError('La unidad no existe', 'PRODUCT_UNIT_NOT_FOUND');
  }

  const accounts = [
    values.primaryAccount,
    values.secondaryAccount,
    values.costOfSalesAccount,
  ].filter((account): account is string => account !== undefined && account !== '');

  for (const account of accounts) {
    if (!(await repository.accountingAccountExists(account))) {
      throw new ConflictError(
        `La cuenta contable ${account} no existe`,
        'ACCOUNTING_ACCOUNT_NOT_FOUND',
      );
    }
  }
};
