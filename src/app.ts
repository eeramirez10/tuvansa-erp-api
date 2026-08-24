import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { createClientsModule } from './modules/accounts-receivable/clients/clients-module.js';
import { errorHandler } from './shared/infrastructure/http/error-handler.js';
import { notFoundHandler } from './shared/infrastructure/http/not-found-handler.js';

export const createApp = () => {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.use(`${env.API_PREFIX}/accounts-receivable/clients`, createClientsModule());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
