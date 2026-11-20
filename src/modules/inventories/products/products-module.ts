import type { Router } from 'express';
import { CreateProduct } from './application/use-cases/create-product.js';
import { DeleteProduct } from './application/use-cases/delete-product.js';
import { EditProductClassification } from './application/use-cases/edit-product-classification.js';
import { GetProduct } from './application/use-cases/get-product.js';
import { GetFirstActiveProduct } from './application/use-cases/get-first-active-product.js';
import { GetProductPanel } from './application/use-cases/get-product-panel.js';
import { NavigateProduct } from './application/use-cases/navigate-product.js';
import { SearchProducts } from './application/use-cases/search-products.js';
import { UpdateProduct } from './application/use-cases/update-product.js';
import { SetProductBlockStatus } from './application/use-cases/set-product-block-status.js';
import { env } from '../../../config/env.js';
import { LegacyMysqlProductClassificationDataSource } from './infrastructure/datasources/legacy-mysql-product-classification-data-source.js';
import { LegacyMysqlProductsDataSource } from './infrastructure/datasources/legacy-mysql-products-data-source.js';
import { LegacyMysqlProductPanelsDataSource } from './infrastructure/datasources/legacy-mysql-product-panels-data-source.js';
import { PostgresProductClassificationDataSource } from './infrastructure/datasources/postgres-product-classification-data-source.js';
import { ProductClassificationRepositoryImpl } from './infrastructure/repositories/product-classification-repository-impl.js';
import { ProductPanelsRepositoryImpl } from './infrastructure/repositories/product-panels-repository-impl.js';
import { ProductsRepositoryImpl } from './infrastructure/repositories/products-repository-impl.js';
import { ProductsController } from './presentation/http/products-controller.js';
import { ProductClassificationsController } from './presentation/http/product-classifications-controller.js';
import { createProductsRouter } from './presentation/http/products-routes.js';

export const createProductsModule = (): Router => {
  const dataSource = new LegacyMysqlProductsDataSource();
  const classificationRepository = new ProductClassificationRepositoryImpl(
    new LegacyMysqlProductClassificationDataSource(),
    new PostgresProductClassificationDataSource(env.INVENTORY_CLASSIFICATION_PILOT_PRODUCTS),
  );
  const repository = new ProductsRepositoryImpl(dataSource, classificationRepository);
  const panelsRepository = new ProductPanelsRepositoryImpl(
    new LegacyMysqlProductPanelsDataSource(),
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
  return createProductsRouter(controller, classifications);
};
