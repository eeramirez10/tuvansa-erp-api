import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  ClientAnnualSale,
  ClientAnnualSalesSummaryItem,
  ClientBranchSale,
  ClientCtOrderedProduct,
  ClientCtSoldProduct,
  ClientEdiSale,
  ClientInvoice,
  ClientOrder,
  ClientOrderedProduct,
  ClientQuotedProduct,
  ClientSoldProduct,
  ClientSoldProductDetail,
  ClientWorkInProgressItem,
} from '../../domain/entities/client-consultation.js';
import type {
  ClientConsultationResult,
  ClientConsultationsRepository,
} from '../../domain/repositories/client-consultations-repository.js';

export interface GetClientConsultationInput {
  clientId: number;
  page: number;
  pageSize: number;
}

export interface GetClientConsultationOutput<T> {
  data: {
    client: ClientConsultationResult<T>['client'];
    items: T[];
  };
  pagination: {
    page: number;
    pageSize: number;
    total: number;
  };
}

type Finder<T> = (criteria: {
  clientId: number;
  limit: number;
  offset: number;
}) => Promise<ClientConsultationResult<T> | null>;

export class GetClientConsultations {
  constructor(private readonly repository: ClientConsultationsRepository) {}

  private async execute<T>(
    input: GetClientConsultationInput,
    finder: Finder<T>,
  ): Promise<GetClientConsultationOutput<T>> {
    const result = await finder({
      clientId: input.clientId,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    });

    if (result === null) throw new NotFoundError('Cliente');

    return {
      data: { client: result.client, items: result.items },
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        total: result.total,
      },
    };
  }

  invoices = (input: GetClientConsultationInput): Promise<GetClientConsultationOutput<ClientInvoice>> =>
    this.execute(input, (criteria) => this.repository.findInvoices(criteria));

  orders = (input: GetClientConsultationInput): Promise<GetClientConsultationOutput<ClientOrder>> =>
    this.execute(input, (criteria) => this.repository.findOrders(criteria));

  orderedProducts = (input: GetClientConsultationInput): Promise<GetClientConsultationOutput<ClientOrderedProduct>> =>
    this.execute(input, (criteria) => this.repository.findOrderedProducts(criteria));

  quotedProducts = (input: GetClientConsultationInput): Promise<GetClientConsultationOutput<ClientQuotedProduct>> =>
    this.execute(input, (criteria) => this.repository.findQuotedProducts(criteria));

  soldProducts = (input: GetClientConsultationInput): Promise<GetClientConsultationOutput<ClientSoldProduct>> =>
    this.execute(input, (criteria) => this.repository.findSoldProducts(criteria));

  soldProductDetails = (input: GetClientConsultationInput): Promise<GetClientConsultationOutput<ClientSoldProductDetail>> =>
    this.execute(input, (criteria) => this.repository.findSoldProductDetails(criteria));

  annualSales = (input: GetClientConsultationInput): Promise<GetClientConsultationOutput<ClientAnnualSale>> =>
    this.execute(input, (criteria) => this.repository.findAnnualSales(criteria));

  annualSalesSummary = (input: GetClientConsultationInput): Promise<GetClientConsultationOutput<ClientAnnualSalesSummaryItem>> =>
    this.execute(input, (criteria) => this.repository.findAnnualSalesSummary(criteria));

  salesByBranch = (input: GetClientConsultationInput): Promise<GetClientConsultationOutput<ClientBranchSale>> =>
    this.execute(input, (criteria) => this.repository.findSalesByBranch(criteria));

  ediSales = (input: GetClientConsultationInput): Promise<GetClientConsultationOutput<ClientEdiSale>> =>
    this.execute(input, (criteria) => this.repository.findEdiSales(criteria));

  workInProgress = (input: GetClientConsultationInput): Promise<GetClientConsultationOutput<ClientWorkInProgressItem>> =>
    this.execute(input, (criteria) => this.repository.findWorkInProgress(criteria));

  ctOrderedProducts = (input: GetClientConsultationInput): Promise<GetClientConsultationOutput<ClientCtOrderedProduct>> =>
    this.execute(input, (criteria) => this.repository.findCtOrderedProducts(criteria));

  ctSoldProducts = (input: GetClientConsultationInput): Promise<GetClientConsultationOutput<ClientCtSoldProduct>> =>
    this.execute(input, (criteria) => this.repository.findCtSoldProducts(criteria));
}
