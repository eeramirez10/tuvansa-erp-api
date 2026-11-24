import type { Router } from 'express';
import { ReversePurchasePosting } from '../../purchasing/purchase-receptions/application/use-cases/reverse-purchase-posting.js';
import { MysqlPostingReversalReferences } from '../../purchasing/purchase-receptions/infrastructure/datasources/mysql-posting-reversal-references.js';
import { PostgresPurchasePostingReversals } from '../../purchasing/purchase-receptions/infrastructure/datasources/postgres-purchase-posting-reversals.js';
import { BankAccountsWithCatalogDataSource } from '../../treasury/banking/infrastructure/datasources/bank-accounts-with-catalog-data-source.js';
import { CaptureSupplierPayment } from './application/use-cases/capture-supplier-payment.js';
import { GetFirstSupplier } from './application/use-cases/get-first-supplier.js';
import { GetSupplier } from './application/use-cases/get-supplier.js';
import { NavigateSupplier } from './application/use-cases/navigate-supplier.js';
import { SearchSuppliers } from './application/use-cases/search-suppliers.js';
import { GetSupplierPanel } from './application/use-cases/get-supplier-panel.js';
import { GetSupplierClassifications } from './application/use-cases/get-supplier-classifications.js';
import { WriteSupplierCatalog } from './application/use-cases/write-supplier-catalog.js';
import { MysqlSupplierCatalogReferences } from './infrastructure/datasources/mysql-supplier-catalog-references.js';
import { PostgresSupplierCatalogDataSource } from './infrastructure/datasources/postgres-supplier-catalog-data-source.js';
import { SuppliersWithPurchaseReceptionsDataSource } from './infrastructure/datasources/suppliers-with-purchase-receptions-data-source.js';
import { SuppliersRepositoryImpl } from './infrastructure/repositories/suppliers-repository-impl.js';
import { SupplierPanelsWithPurchaseReceptionsDataSource } from './infrastructure/datasources/supplier-panels-with-purchase-receptions-data-source.js';
import { SupplierPanelsRepositoryImpl } from './infrastructure/repositories/supplier-panels-repository-impl.js';
import { MysqlSupplierPaymentReferences } from './infrastructure/datasources/mysql-supplier-payment-references.js';
import { PostgresSupplierPayments } from './infrastructure/datasources/postgres-supplier-payments.js';
import { SuppliersController } from './presentation/http/suppliers-controller.js';
import { SupplierCatalogController } from './presentation/http/supplier-catalog-controller.js';
import { createSuppliersRouter } from './presentation/http/suppliers-routes.js';

export const createSuppliersModule = (): Router => {
  const catalog = new PostgresSupplierCatalogDataSource();
  const dataSource = new SuppliersWithPurchaseReceptionsDataSource(undefined, catalog);
  const bankCatalog = new BankAccountsWithCatalogDataSource();
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
    new CaptureSupplierPayment(
      new PostgresSupplierPayments(undefined, undefined, bankCatalog), new MysqlSupplierPaymentReferences(bankCatalog),
    ),
  );

  const reversals = new ReversePurchasePosting(new PostgresPurchasePostingReversals(), new MysqlPostingReversalReferences());
  return createSuppliersRouter(controller, reversals, new SupplierCatalogController(
    new WriteSupplierCatalog(catalog, new MysqlSupplierCatalogReferences()), dataSource,
  ));
};
