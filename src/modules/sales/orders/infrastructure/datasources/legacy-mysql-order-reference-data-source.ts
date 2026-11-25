import type { RowDataPacket } from 'mysql2';
import { env } from '../../../../../config/env.js';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { clientCatalogRecord } from '../../../../accounts-receivable/clients/infrastructure/datasources/postgres-client-catalog.js';
import { catalogProductsById } from '../../../../inventories/products/infrastructure/datasources/product-catalog-references.js';
import type { OrderAuthorizationCost, OrderReferenceDataSource } from '../../domain/datasources/order-reference-data-source.js';
import type { CaptureCustomerSearchCriteria, CaptureProductSearchCriteria } from '../../domain/repositories/order-capture-repository.js';
import { LegacyMysqlOrderCaptureDataSource } from './legacy-mysql-order-capture-data-source.js';

// Read-only reference port. No capture/create/update/delete method is exposed here.
export class LegacyMysqlOrderReferenceDataSource implements OrderReferenceDataSource {
  private readonly source = new LegacyMysqlOrderCaptureDataSource();
  constructor(private readonly warehouseCodes: readonly string[] = env.SALES_ORDER_WAREHOUSES) {}
  options() { return this.source.options(this.warehouseCodes); }
  customer(code: string) { return this.source.customer(code); }
  searchCustomers(criteria: CaptureCustomerSearchCriteria, limit: number) { return this.source.searchCustomers(criteria, limit); }
  searchProducts(criteria: CaptureProductSearchCriteria, warehouse: string, limit: number) { return this.source.searchProducts(criteria, warehouse, limit); }
  productFamilies() { return this.source.productFamilies(); }
  product(code: string, warehouse: string, type: string, customerCode: string) { return this.source.product(code,warehouse,type,customerCode); }
  async canAuthorizeCustomer(id: number): Promise<boolean> {
    const client = await clientCatalogRecord(id);
    if (client?.deleted || client?.blocked === true) return false;
    if (client && !client.legacy) return client.blocked === false || client.document.isActive;

    // Derivada: mismos criterios de elegibilidad que en la captura de pedidos.
    type CustomerRow = RowDataPacket & { active: number; restrictedToPos: number };
    const [[customer]] = await legacyMysqlPool.execute<CustomerRow[]>(
      "SELECT CLIBAJA='1900-12-31' AS active, CLISOLOPOS=2 AS restrictedToPos FROM FCLI WHERE CLISEQ=?",
      [id],
    );
    return !!customer && !customer.restrictedToPos && (client?.blocked === false || Boolean(customer.active));
  }
  async authorizationCosts(productIds: number[]): Promise<ReadonlyMap<number, OrderAuthorizationCost>> {
    if (!productIds.length) return new Map();
    type CostRow = RowDataPacket & { id: number; currency: number; pesoCost: number | null; dollarCost: number | null };
    // Derivada: consulta en lote de las mismas listas de costo que usa Captura.
    const [[rows], catalog] = await Promise.all([
      legacyMysqlPool.query<CostRow[]>(
        'SELECT ISEQ AS id, IMONEDA1 AS currency, ILISTA5 AS pesoCost, ILISTA6 AS dollarCost FROM FINV WHERE ISEQ IN (?)',
        [productIds],
      ),
      catalogProductsById(productIds),
    ]);
    const legacy = new Map(rows.map((row) => [row.id, row]));
    const costs = new Map<number, OrderAuthorizationCost>();
    for (const id of productIds) {
      const reference = catalog.get(id);
      if (reference?.deleted || reference?.document.isActive === false) continue;
      const base = legacy.get(id);
      const prices = reference && (reference.revision > 0 || !base) ? reference.document.prices : undefined;
      const currency = prices?.sale[0]?.currencyId ?? base?.currency;
      if (currency !== 1 && currency !== 2) continue;
      const cost = currency === 1 ? (prices ? prices.costs.last : base?.pesoCost)
        : (prices ? prices.costs.previous : base?.dollarCost);
      if (cost != null && Number.isFinite(cost) && cost >= 0) costs.set(id, { cost, costCurrencyId: currency });
    }
    return costs;
  }
  async customerById(id: number) {
    const record = await clientCatalogRecord(id);
    if (record) return this.customer(record.document.code);
    const [rows] = await legacyMysqlPool.execute<(RowDataPacket & {code:string})[]>('SELECT CLICOD AS code FROM FCLI WHERE CLISEQ=? LIMIT 1',[id]);
    if (!rows[0]) throw new NotFoundError('Cliente');
    return this.customer(rows[0].code);
  }
  async productCodeById(id: number) {
    const product = (await catalogProductsById([id])).get(id);
    if (product?.deleted || product?.document.isActive === false) throw new NotFoundError('Producto');
    if (product) return product.document.code;
    const [rows] = await legacyMysqlPool.execute<(RowDataPacket & {code:string})[]>('SELECT ICOD AS code FROM FINV WHERE ISEQ=? LIMIT 1',[id]);
    if (!rows[0]) throw new NotFoundError('Producto');
    return rows[0].code;
  }
  async hasInvoices(number: string) {
    const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>('SELECT DSEQ FROM FDOC WHERE DREFER=? AND DEST=0 LIMIT 1',[number]);
    return rows.length > 0;
  }
}
