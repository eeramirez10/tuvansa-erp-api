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
import type { GetFirstActiveClient } from '../../application/use-cases/get-first-active-client.js';
import type { SearchClients } from '../../application/use-cases/search-clients.js';
import type { CreateClient } from '../../application/use-cases/create-client.js';
import type { DeleteClient } from '../../application/use-cases/delete-client.js';
import type { NavigateClient } from '../../application/use-cases/navigate-client.js';
import type { UpdateClient } from '../../application/use-cases/update-client.js';

const clientParamsSchema = z.object({
  clientId: z.coerce.number().int().positive(),
});

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('all'),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

const optionalText = (maximum: number) => z.string().trim().max(maximum).optional();
const addressSchema = z.object({
  street: optionalText(45),
  exteriorNumber: optionalText(31),
  interiorNumber: optionalText(31),
  neighborhood: optionalText(60),
  borough: optionalText(50),
  city: optionalText(45),
  state: optionalText(16),
  postalCode: optionalText(12),
  countryCode: optionalText(3),
}).strict();
const contactSchema = z.object({
  name: optionalText(20),
  phones: optionalText(35),
  fax: optionalText(35),
  email: optionalText(75),
  website: optionalText(35),
}).strict();
const fiscalSchema = z.object({
  taxId: optionalText(15),
  curp: optionalText(35),
  branch: optionalText(15),
  accountingAccount: optionalText(13),
}).strict();
const termsSchema = z.object({
  priceList: z.number().int().nonnegative().optional(),
  discounts: z.tuple([z.number(), z.number(), z.number()]).optional(),
  paymentTermDays: z.number().int().nonnegative().optional(),
  creditLimit: z.number().nonnegative().optional(),
  creditExpiresAt: z.union([z.iso.date(), z.null()]).optional(),
  reviewDay: optionalText(9),
  reviewTime: optionalText(15),
  paymentDay: optionalText(9),
  paymentTime: optionalText(15),
  applyToClientCode: optionalText(6),
  reviewStartsFromInvoice: z.boolean().optional(),
}).strict();

const mutationFields = {
  code: z.string().trim().min(1).max(6).optional(),
  name: z.string().trim().min(1).max(255).optional(),
  address: addressSchema.optional(),
  contact: contactSchema.optional(),
  fiscal: fiscalSchema.optional(),
  terms: termsSchema.optional(),
};
const createClientBodySchema = z.object(mutationFields).strict().extend({
  code: z.string().trim().min(1).max(6),
  name: z.string().trim().min(1).max(255),
});
const updateClientBodySchema = z.object(mutationFields).strict().refine(
  (body) => {
    const nestedValues = [body.address, body.contact, body.fiscal, body.terms]
      .some((value) => value !== undefined && Object.keys(value).length > 0);
    return body.code !== undefined || body.name !== undefined || nestedValues;
  },
  { message: 'Debe proporcionar al menos un campo para modificar' },
);

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

const classificationsQuerySchema = z.object({
  position: z.coerce.number().int().min(1).max(9).default(1),
});

type ConsultationExecutor = (input: GetClientConsultationInput) => Promise<unknown>;
type ClientActionExecutor = (clientId: number) => Promise<unknown>;
type PaginatedClientActionExecutor = (input: GetClientActionInput) => Promise<unknown>;

export class ClientsController {
  constructor(
    private readonly getClient: GetClient,
    private readonly getFirstActiveClient: GetFirstActiveClient,
    private readonly searchClients: SearchClients,
    private readonly getClientMovements: GetClientMovements,
    private readonly getClientBalance: GetClientBalance,
    private readonly getClientConsultations: GetClientConsultations,
    private readonly getClientActions: GetClientActions,
    private readonly navigateClient: NavigateClient,
    private readonly createClient: CreateClient,
    private readonly updateClient: UpdateClient,
    private readonly deleteClient: DeleteClient,
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

  getFirstActive: RequestHandler = async (_request, response, next) => {
    try {
      response.json({ data: await this.getFirstActiveClient.execute() });
    } catch (error) {
      next(error);
    }
  };

  getPrevious: RequestHandler = async (request, response, next) => {
    try {
      const { clientId } = clientParamsSchema.parse(request.params);
      response.json({ data: await this.navigateClient.execute(clientId, 'previous') });
    } catch (error) {
      next(error);
    }
  };

  getNext: RequestHandler = async (request, response, next) => {
    try {
      const { clientId } = clientParamsSchema.parse(request.params);
      response.json({ data: await this.navigateClient.execute(clientId, 'next') });
    } catch (error) {
      next(error);
    }
  };

  create: RequestHandler = async (request, response, next) => {
    try {
      const input = createClientBodySchema.parse(request.body);
      response.status(201).json({ data: await this.createClient.execute(input) });
    } catch (error) {
      next(error);
    }
  };

  update: RequestHandler = async (request, response, next) => {
    try {
      const { clientId } = clientParamsSchema.parse(request.params);
      const input = updateClientBodySchema.parse(request.body);
      response.json({ data: await this.updateClient.execute(clientId, input) });
    } catch (error) {
      next(error);
    }
  };

  delete: RequestHandler = async (request, response, next) => {
    try {
      const { clientId } = clientParamsSchema.parse(request.params);
      await this.deleteClient.execute(clientId);
      response.status(204).send();
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

  getInvoices: RequestHandler = this.consultation((input) =>
    this.getClientConsultations.invoices(input));
  getOrders: RequestHandler = this.consultation((input) =>
    this.getClientConsultations.orders(input));
  getOrderedProducts: RequestHandler = this.consultation((input) =>
    this.getClientConsultations.orderedProducts(input));
  getQuotedProducts: RequestHandler = this.consultation((input) =>
    this.getClientConsultations.quotedProducts(input));
  getSoldProducts: RequestHandler = this.consultation((input) =>
    this.getClientConsultations.soldProducts(input));
  getSoldProductDetails: RequestHandler = this.consultation((input) =>
    this.getClientConsultations.soldProductDetails(input));
  getAnnualSales: RequestHandler = this.consultation((input) =>
    this.getClientConsultations.annualSales(input));
  getAnnualSalesSummary: RequestHandler = this.consultation((input) =>
    this.getClientConsultations.annualSalesSummary(input));
  getSalesByBranch: RequestHandler = this.consultation((input) =>
    this.getClientConsultations.salesByBranch(input));
  getEdiSales: RequestHandler = this.consultation((input) =>
    this.getClientConsultations.ediSales(input));
  getWorkInProgress: RequestHandler = this.consultation((input) =>
    this.getClientConsultations.workInProgress(input));
  getCtOrderedProducts: RequestHandler = this.consultation((input) =>
    this.getClientConsultations.ctOrderedProducts(input));
  getCtSoldProducts: RequestHandler = this.consultation((input) =>
    this.getClientConsultations.ctSoldProducts(input));
  getCtWorkInProgress: RequestHandler = this.consultation((input) =>
    this.getClientConsultations.workInProgress(input));
  getClassifications: RequestHandler = async (request, response, next) => {
    try {
      const { clientId } = clientParamsSchema.parse(request.params);
      const { position } = classificationsQuerySchema.parse(request.query);
      response.json(await this.getClientActions.classifications({ clientId, position }));
    } catch (error) {
      next(error);
    }
  };
  getDestinations: RequestHandler = this.action((clientId) =>
    this.getClientActions.destinations(clientId));
  getBlockStatus: RequestHandler = this.action((clientId) =>
    this.getClientActions.blockStatus(clientId));
  getPhoto: RequestHandler = this.action((clientId) =>
    this.getClientActions.photo(clientId));
  getDiscounts: RequestHandler = this.paginatedAction((input) =>
    this.getClientActions.discounts(input));
  getEvents: RequestHandler = this.paginatedAction((input) =>
    this.getClientActions.events(input));
  getBranches: RequestHandler = this.paginatedAction((input) =>
    this.getClientActions.branches(input));
  getContacts: RequestHandler = this.paginatedAction((input) =>
    this.getClientActions.contacts(input));
}
