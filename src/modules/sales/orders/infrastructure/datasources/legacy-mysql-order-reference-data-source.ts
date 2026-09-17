import type { RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { OrderReferenceDataSource } from '../../domain/datasources/order-reference-data-source.js';
import { LegacyMysqlOrderCaptureDataSource } from './legacy-mysql-order-capture-data-source.js';

// Read-only reference port. No capture/create/update/delete method is exposed here.
export class LegacyMysqlOrderReferenceDataSource implements OrderReferenceDataSource {
  private readonly source = new LegacyMysqlOrderCaptureDataSource();
  options() { return this.source.options(); }
  customer(code: string) { return this.source.customer(code); }
  product(code: string, warehouse: string, type: string, customerCode: string) { return this.source.product(code,warehouse,type,customerCode); }
  async customerById(id: number) {
    const [rows] = await legacyMysqlPool.execute<(RowDataPacket & {code:string})[]>('SELECT CLICOD AS code FROM FCLI WHERE CLISEQ=? LIMIT 1',[id]);
    if (!rows[0]) throw new NotFoundError('Cliente');
    return this.customer(rows[0].code);
  }
  async productCodeById(id: number) {
    const [rows] = await legacyMysqlPool.execute<(RowDataPacket & {code:string})[]>('SELECT ICOD AS code FROM FINV WHERE ISEQ=? LIMIT 1',[id]);
    if (!rows[0]) throw new NotFoundError('Producto');
    return rows[0].code;
  }
  async hasInvoices(number: string) {
    const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>('SELECT DSEQ FROM FDOC WHERE DREFER=? AND DEST=0 LIMIT 1',[number]);
    return rows.length > 0;
  }
}
