import type { ClientConsultationsDataSource } from '../../domain/datasources/client-consultations-data-source.js';
import type { ClientConsultationsRepository } from '../../domain/repositories/client-consultations-repository.js';

export class ClientConsultationsRepositoryImpl implements ClientConsultationsRepository {
  constructor(private readonly dataSource: ClientConsultationsDataSource) {}

  findInvoices: ClientConsultationsRepository['findInvoices'] = (criteria) =>
    this.dataSource.findInvoices(criteria);
  findOrders: ClientConsultationsRepository['findOrders'] = (criteria) =>
    this.dataSource.findOrders(criteria);
  findOrderedProducts: ClientConsultationsRepository['findOrderedProducts'] = (criteria) =>
    this.dataSource.findOrderedProducts(criteria);
  findQuotedProducts: ClientConsultationsRepository['findQuotedProducts'] = (criteria) =>
    this.dataSource.findQuotedProducts(criteria);
  findSoldProducts: ClientConsultationsRepository['findSoldProducts'] = (criteria) =>
    this.dataSource.findSoldProducts(criteria);
  findSoldProductDetails: ClientConsultationsRepository['findSoldProductDetails'] = (criteria) =>
    this.dataSource.findSoldProductDetails(criteria);
  findAnnualSales: ClientConsultationsRepository['findAnnualSales'] = (criteria) =>
    this.dataSource.findAnnualSales(criteria);
  findAnnualSalesSummary: ClientConsultationsRepository['findAnnualSalesSummary'] = (criteria) =>
    this.dataSource.findAnnualSalesSummary(criteria);
  findSalesByBranch: ClientConsultationsRepository['findSalesByBranch'] = (criteria) =>
    this.dataSource.findSalesByBranch(criteria);
  findEdiSales: ClientConsultationsRepository['findEdiSales'] = (criteria) =>
    this.dataSource.findEdiSales(criteria);
  findWorkInProgress: ClientConsultationsRepository['findWorkInProgress'] = (criteria) =>
    this.dataSource.findWorkInProgress(criteria);
  findCtOrderedProducts: ClientConsultationsRepository['findCtOrderedProducts'] = (criteria) =>
    this.dataSource.findCtOrderedProducts(criteria);
  findCtSoldProducts: ClientConsultationsRepository['findCtSoldProducts'] = (criteria) =>
    this.dataSource.findCtSoldProducts(criteria);
}
