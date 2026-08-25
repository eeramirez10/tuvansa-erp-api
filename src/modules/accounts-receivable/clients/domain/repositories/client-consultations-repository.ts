import type {
  ClientAnnualSale,
  ClientAnnualSalesSummaryItem,
  ClientBranchSale,
  ClientConsultationIdentity,
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
} from '../entities/client-consultation.js';

export interface ClientConsultationCriteria {
  clientId: number;
  limit: number;
  offset: number;
}

export interface ClientConsultationResult<T> {
  client: ClientConsultationIdentity;
  items: T[];
  total: number;
}

export interface ClientConsultationsRepository {
  findInvoices(criteria: ClientConsultationCriteria): Promise<ClientConsultationResult<ClientInvoice> | null>;
  findOrders(criteria: ClientConsultationCriteria): Promise<ClientConsultationResult<ClientOrder> | null>;
  findOrderedProducts(criteria: ClientConsultationCriteria): Promise<ClientConsultationResult<ClientOrderedProduct> | null>;
  findQuotedProducts(criteria: ClientConsultationCriteria): Promise<ClientConsultationResult<ClientQuotedProduct> | null>;
  findSoldProducts(criteria: ClientConsultationCriteria): Promise<ClientConsultationResult<ClientSoldProduct> | null>;
  findSoldProductDetails(criteria: ClientConsultationCriteria): Promise<ClientConsultationResult<ClientSoldProductDetail> | null>;
  findAnnualSales(criteria: ClientConsultationCriteria): Promise<ClientConsultationResult<ClientAnnualSale> | null>;
  findAnnualSalesSummary(criteria: ClientConsultationCriteria): Promise<ClientConsultationResult<ClientAnnualSalesSummaryItem> | null>;
  findSalesByBranch(criteria: ClientConsultationCriteria): Promise<ClientConsultationResult<ClientBranchSale> | null>;
  findEdiSales(criteria: ClientConsultationCriteria): Promise<ClientConsultationResult<ClientEdiSale> | null>;
  findWorkInProgress(criteria: ClientConsultationCriteria): Promise<ClientConsultationResult<ClientWorkInProgressItem> | null>;
  findCtOrderedProducts(criteria: ClientConsultationCriteria): Promise<ClientConsultationResult<ClientCtOrderedProduct> | null>;
  findCtSoldProducts(criteria: ClientConsultationCriteria): Promise<ClientConsultationResult<ClientCtSoldProduct> | null>;
}
