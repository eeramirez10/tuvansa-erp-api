import type { Router } from 'express';
import { CreateProduct } from './application/use-cases/create-product.js';
import { DeleteProduct } from './application/use-cases/delete-product.js';
import { EditProductClassification } from './application/use-cases/edit-product-classification.js';
import { EditProductOtherData } from './application/use-cases/edit-product-other-data.js';
import { GetProduct } from './application/use-cases/get-product.js';
import { GetFirstActiveProduct } from './application/use-cases/get-first-active-product.js';
import { GetProductPanel } from './application/use-cases/get-product-panel.js';
import { NavigateProduct } from './application/use-cases/navigate-product.js';
import { SearchProducts } from './application/use-cases/search-products.js';
import { UpdateProduct } from './application/use-cases/update-product.js';
import { SetProductBlockStatus } from './application/use-cases/set-product-block-status.js';
import { env } from '../../../config/env.js';
import { connectPostgres, postgresConfigured } from '../../../shared/infrastructure/database/postgres-pool.js';
import { LegacyMysqlProductClassificationDataSource } from './infrastructure/datasources/legacy-mysql-product-classification-data-source.js';
import { LegacyMysqlProductOtherDataSource } from './infrastructure/datasources/legacy-mysql-product-other-data-source.js';
import { ProductsWithPurchaseOrderPendingDataSource } from './infrastructure/datasources/products-with-purchase-order-pending-data-source.js';
import { ProductPanelsWithPurchaseReceptionsDataSource } from './infrastructure/datasources/product-panels-with-purchase-receptions-data-source.js';
import { PostgresProductClassificationDataSource } from './infrastructure/datasources/postgres-product-classification-data-source.js';
import { PostgresProductOtherDataSource } from './infrastructure/datasources/postgres-product-other-data-source.js';
import { PostgresProductCatalogEditDataSource } from './infrastructure/datasources/postgres-product-catalog-edit-data-source.js';
import { LegacyMysqlProductsDataSource } from './infrastructure/datasources/legacy-mysql-products-data-source.js';
import { PostgresProductsDataSource } from './infrastructure/datasources/postgres-products-data-source.js';
import { ProductClassificationRepositoryImpl } from './infrastructure/repositories/product-classification-repository-impl.js';
import { ProductOtherDataRepositoryImpl } from './infrastructure/repositories/product-other-data-repository-impl.js';
import { ProductPanelsRepositoryImpl } from './infrastructure/repositories/product-panels-repository-impl.js';
import { ProductsRepositoryImpl } from './infrastructure/repositories/products-repository-impl.js';
import { ProductsController } from './presentation/http/products-controller.js';
import { ProductClassificationsController } from './presentation/http/product-classifications-controller.js';
import { ProductOtherDataController } from './presentation/http/product-other-data-controller.js';
import { createProductsRouter } from './presentation/http/products-routes.js';

export const createProductsModule = (): Router => {
  const legacy = new LegacyMysqlProductsDataSource();
  const catalog = new PostgresProductsDataSource(connectPostgres, postgresConfigured, legacy);
  const dataSource = new ProductsWithPurchaseOrderPendingDataSource(catalog);
  const editProducts = env.INVENTORY_PRODUCT_EDIT_PILOT_PRODUCTS;
  const edits = new PostgresProductCatalogEditDataSource(editProducts);
  const classificationRepository = new ProductClassificationRepositoryImpl(
    new LegacyMysqlProductClassificationDataSource(),
    new PostgresProductClassificationDataSource(env.INVENTORY_CLASSIFICATION_PILOT_PRODUCTS, undefined, undefined, editProducts, true),
    edits,
  );
  const otherDataRepository = new ProductOtherDataRepositoryImpl(
    new LegacyMysqlProductOtherDataSource(),
    new PostgresProductOtherDataSource(env.INVENTORY_OTHER_DATA_PILOT_PRODUCTS, undefined, undefined, editProducts, true),
    edits,
  );
  const repository = new ProductsRepositoryImpl(dataSource, classificationRepository, otherDataRepository, edits);
  const panelsRepository = new ProductPanelsRepositoryImpl(
    new ProductPanelsWithPurchaseReceptionsDataSource(),
    otherDataRepository,
    edits,
    catalog,
  );
  const controller = new ProductsController(
    new GetProduct(repository),
    new GetFirstActiveProduct(repository),
    new SearchProducts(repository),
    new NavigateProduct(repository),
    new CreateProduct(repository),
    new UpdateProduct(repository),
    new DeleteProduct(repository),
    new GetProductPanel(panelsRepository),
    new SetProductBlockStatus(panelsRepository),
  );
  const classifications = new ProductClassificationsController(new EditProductClassification(classificationRepository));
  const otherData = new ProductOtherDataController(new EditProductOtherData(otherDataRepository));
  return createProductsRouter(controller, classifications, otherData);
};
