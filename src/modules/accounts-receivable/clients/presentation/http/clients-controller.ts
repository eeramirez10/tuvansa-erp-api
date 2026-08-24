import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { GetClient } from '../../application/use-cases/get-client.js';
import type { SearchClients } from '../../application/use-cases/search-clients.js';

const clientParamsSchema = z.object({
  clientCode: z.string().trim().min(1).max(50),
});

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

export class ClientsController {
  constructor(
    private readonly getClient: GetClient,
    private readonly searchClients: SearchClients,
  ) {}

  search: RequestHandler = async (request, response, next) => {
    try {
      const query = searchQuerySchema.parse(request.query);
      const result = await this.searchClients.execute({
        ...(query.q === undefined ? {} : { query: query.q }),
        page: query.page,
        pageSize: query.pageSize,
      });
      response.json(result);
    } catch (error) {
      next(error);
    }
  };

  getByCode: RequestHandler = async (request, response, next) => {
    try {
      const { clientCode } = clientParamsSchema.parse(request.params);
      const result = await this.getClient.execute(clientCode);
      response.json({ data: result });
    } catch (error) {
      next(error);
    }
  };
}
