import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { GetClientBalance } from '../../application/use-cases/get-client-balance.js';
import type {
  GetClientActionInput,
  GetClientActions,
} from '../../application/use-cases/get-client-actions.js';
import type {
  GetClientConsultationInput,
  GetClientConsultations,
} from '../../application/use-cases/get-client-consultations.js';
import type { GetClientMovements } from '../../application/use-cases/get-client-movements.js';
import type { GetClient } from '../../application/use-cases/get-client.js';
import type { SearchClients } from '../../application/use-cases/search-clients.js';

const clientParamsSchema = z.object({
  clientId: z.coerce.number().int().positive(),
});

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('all'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

const movementsQuerySchema = z.object({
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
}).superRefine((query, context) => {
  if (
    query.dateFrom !== undefined
    && query.dateTo !== undefined
    && query.dateFrom > query.dateTo
  ) {
    context.addIssue({
      code: 'custom',
      message: 'dateFrom no puede ser posterior a dateTo',
      path: ['dateFrom'],
    });
  }
});

const balanceQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  dueStatus: z.enum(['all', 'overdue', 'notDue']).default('all'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

const consultationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

type ConsultationExecutor = (input: GetClientConsultationInput) => Promise<unknown>;
type ClientActionExecutor = (clientId: number) => Promise<unknown>;
type PaginatedClientActionExecutor = (input: GetClientActionInput) => Promise<unknown>;

export class ClientsController {
  constructor(
    private readonly getClient: GetClient,
    private readonly searchClients: SearchClients,
    private readonly getClientMovements: GetClientMovements,
    private readonly getClientBalance: GetClientBalance,
    private readonly getClientConsultations: GetClientConsultations,
    private readonly getClientActions: GetClientActions,
  ) {}

  private consultation(execute: ConsultationExecutor): RequestHandler {
    return async (request, response, next) => {
      try {
        const { clientId } = clientParamsSchema.parse(request.params);
        const query = consultationQuerySchema.parse(request.query);
        const result = await execute({
          clientId,
          page: query.page,
          pageSize: query.pageSize,
        });
        response.json(result);
      } catch (error) {
        next(error);
      }
    };
  }

  private action(execute: ClientActionExecutor): RequestHandler {
    return async (request, response, next) => {
      try {
        const { clientId } = clientParamsSchema.parse(request.params);
        response.json(await execute(clientId));
      } catch (error) {
        next(error);
      }
    };
  }

  private paginatedAction(execute: PaginatedClientActionExecutor): RequestHandler {
    return async (request, response, next) => {
      try {
        const { clientId } = clientParamsSchema.parse(request.params);
        const query = consultationQuerySchema.parse(request.query);
        response.json(await execute({
          clientId,
          page: query.page,
          pageSize: query.pageSize,
        }));
      } catch (error) {
        next(error);
      }
    };
  }

  search: RequestHandler = async (request, response, next) => {
    try {
      const query = searchQuerySchema.parse(request.query);
      const result = await this.searchClients.execute({
        ...(query.q === undefined ? {} : { query: query.q }),
        status: query.status,
        page: query.page,
        pageSize: query.pageSize,
      });
      response.json(result);
    } catch (error) {
      next(error);
    }
  };

  getById: RequestHandler = async (request, response, next) => {
    try {
      const { clientId } = clientParamsSchema.parse(request.params);
      const result = await this.getClient.execute(clientId);
      response.json({ data: result });
    } catch (error) {
      next(error);
    }
  };

  getMovements: RequestHandler = async (request, response, next) => {
    try {
      const { clientId } = clientParamsSchema.parse(request.params);
      const query = movementsQuerySchema.parse(request.query);
      const result = await this.getClientMovements.execute({
        clientId,
        ...(query.dateFrom === undefined ? {} : { dateFrom: query.dateFrom }),
        ...(query.dateTo === undefined ? {} : { dateTo: query.dateTo }),
        page: query.page,
        pageSize: query.pageSize,
      });
      response.json(result);
    } catch (error) {
      next(error);
    }
  };

  getBalance: RequestHandler = async (request, response, next) => {
    try {
      const { clientId } = clientParamsSchema.parse(request.params);
      const query = balanceQuerySchema.parse(request.query);
      const result = await this.getClientBalance.execute({
        clientId,
        ...(query.q === undefined ? {} : { query: query.q }),
        dueStatus: query.dueStatus,
        page: query.page,
        pageSize: query.pageSize,
      });
      response.json(result);
    } catch (error) {
      next(error);
    }
  };

  getInvoices = this.consultation((input) => this.getClientConsultations.invoices(input));
  getOrders = this.consultation((input) => this.getClientConsultations.orders(input));
  getOrderedProducts = this.consultation((input) =>
    this.getClientConsultations.orderedProducts(input));
  getQuotedProducts = this.consultation((input) =>
    this.getClientConsultations.quotedProducts(input));
  getSoldProducts = this.consultation((input) =>
    this.getClientConsultations.soldProducts(input));
  getSoldProductDetails = this.consultation((input) =>
    this.getClientConsultations.soldProductDetails(input));
  getAnnualSales = this.consultation((input) =>
    this.getClientConsultations.annualSales(input));
  getAnnualSalesSummary = this.consultation((input) =>
    this.getClientConsultations.annualSalesSummary(input));
  getSalesByBranch = this.consultation((input) =>
    this.getClientConsultations.salesByBranch(input));
  getEdiSales = this.consultation((input) => this.getClientConsultations.ediSales(input));
  getWorkInProgress = this.consultation((input) =>
    this.getClientConsultations.workInProgress(input));
  getCtOrderedProducts = this.consultation((input) =>
    this.getClientConsultations.ctOrderedProducts(input));
  getCtSoldProducts = this.consultation((input) =>
    this.getClientConsultations.ctSoldProducts(input));
  getCtWorkInProgress = this.consultation((input) =>
    this.getClientConsultations.workInProgress(input));
  getClassifications = this.action((clientId) =>
    this.getClientActions.classifications(clientId));
  getDestinations = this.action((clientId) => this.getClientActions.destinations(clientId));
  getBlockStatus = this.action((clientId) => this.getClientActions.blockStatus(clientId));
  getPhoto = this.action((clientId) => this.getClientActions.photo(clientId));
  getDiscounts = this.paginatedAction((input) => this.getClientActions.discounts(input));
  getEvents = this.paginatedAction((input) => this.getClientActions.events(input));
  getBranches = this.paginatedAction((input) => this.getClientActions.branches(input));
  getContacts = this.paginatedAction((input) => this.getClientActions.contacts(input));
}
