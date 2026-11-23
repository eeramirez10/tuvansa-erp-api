import type { Router } from 'express';
import { GetFirstSupplier } from './application/use-cases/get-first-supplier.js';
import { GetSupplier } from './application/use-cases/get-supplier.js';
import { NavigateSupplier } from './application/use-cases/navigate-supplier.js';
import { SearchSuppliers } from './application/use-cases/search-suppliers.js';
import { GetSupplierPanel } from './application/use-cases/get-supplier-panel.js';
import { GetSupplierClassifications } from './application/use-cases/get-supplier-classifications.js';
import { SuppliersWithPurchaseReceptionsDataSource } from './infrastructure/datasources/suppliers-with-purchase-receptions-data-source.js';
import { SuppliersRepositoryImpl } from './infrastructure/repositories/suppliers-repository-impl.js';
import { SupplierPanelsWithPurchaseReceptionsDataSource } from './infrastructure/datasources/supplier-panels-with-purchase-receptions-data-source.js';
import { SupplierPanelsRepositoryImpl } from './infrastructure/repositories/supplier-panels-repository-impl.js';
import { SuppliersController } from './presentation/http/suppliers-controller.js';
import { createSuppliersRouter } from './presentation/http/suppliers-routes.js';

export const createSuppliersModule = (): Router => {
  const dataSource = new SuppliersWithPurchaseReceptionsDataSource();
  const repository = new SuppliersRepositoryImpl(dataSource);
  const panelsRepository = new SupplierPanelsRepositoryImpl(
    new SupplierPanelsWithPurchaseReceptionsDataSource(),
  );
  const controller = new SuppliersController(
    new GetSupplier(repository),
    new GetFirstSupplier(repository),
    new SearchSuppliers(repository),
    new NavigateSupplier(repository),
    new GetSupplierPanel(panelsRepository),
    new GetSupplierClassifications(panelsRepository),
  );

  return createSuppliersRouter(controller);
};
