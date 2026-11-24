import type { RowDataPacket } from 'mysql2';
import { env } from '../../../../../config/env.js';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { clientCatalogRecord } from '../../../../accounts-receivable/clients/infrastructure/datasources/postgres-client-catalog.js';
import { catalogProductsById } from '../../../../inventories/products/infrastructure/datasources/product-catalog-references.js';
import type { OrderReferenceDataSource } from '../../domain/datasources/order-reference-data-source.js';
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
  product(code: string, warehouse: string, type: string, customerCode: string) { return this.source.product(code,warehouse,type,customerCode); }
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
