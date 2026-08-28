import cors from 'cors';
import express from 'express';
import type { Express } from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { createClientsModule } from './modules/accounts-receivable/clients/clients-module.js';
import { createProductsModule } from './modules/inventories/products/products-module.js';
import { createOrdersModule } from './modules/sales/orders/orders-module.js';
import { errorHandler } from './shared/infrastructure/http/error-handler.js';
import { notFoundHandler } from './shared/infrastructure/http/not-found-handler.js';

export const createApp = (): Express => {
  const app = express();

  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS }));
  app.use(express.json());

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.use(`${env.API_PREFIX}/accounts-receivable/clients`, createClientsModule());
  app.use(`${env.API_PREFIX}/inventories/products`, createProductsModule());
  app.use(`${env.API_PREFIX}/sales/orders`, createOrdersModule());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
