import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { SupplierCatalogReferences, SupplierCatalogSettings } from '../../domain/datasources/supplier-catalog-data-source.js';
import type { SupplierCatalogParameters } from '../../domain/entities/supplier-catalog.js';
import { LegacyMysqlSuppliersDataSource } from './legacy-mysql-suppliers-data-source.js';

const nativeDependencies = [
  ['FDOC', 'El proveedor tiene documentos o movimientos del mes.'],
  ['FAX', 'El proveedor tiene movimientos en cuentas por pagar.'],
  ['FAXINV', 'El proveedor tiene movimientos de inventario.'],
  ['FPENC', 'El proveedor tiene órdenes o cotizaciones de compra.'],
  ['FPLIN', 'El proveedor tiene partidas de órdenes de compra.'],
  ['FCANU2', 'El proveedor tiene compras anuales.'],
] as const;

export class MysqlSupplierCatalogReferences implements SupplierCatalogReferences {
  constructor(private readonly legacy = new LegacyMysqlSuppliersDataSource()) {}

  async settings(): Promise<SupplierCatalogSettings | null> {
    const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & SupplierCatalogSettings>>(
      `SELECT CIACTAPRV AS defaultAccount, SUBSTRING(CIAPLUGS,4,1)='X' AS accountingEnabled,
         SUBSTRING(CIAPLUGS,4,1)='X' AND SUBSTRING(CIACOMPORTA,84,1)<>'1' AS accountingAccountRequired
       FROM FCIA WHERE CIASEQ=1 AND CIAALIAS='TUVANSA' LIMIT 1`,
    );
    const row = rows[0];
    return row ? {
      defaultAccount: row.defaultAccount, accountingEnabled: Boolean(row.accountingEnabled),
      accountingAccountRequired: Boolean(row.accountingAccountRequired),
    } : null;
  }

  findById(id: number) { return this.legacy.findById(id); }

  async parameters(id: number): Promise<SupplierCatalogParameters | null> {
    const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & SupplierCatalogParameters>>(
      `SELECT PRVTOLERANCIA AS tolerancePercent, PRVTIPOIVA AS vatCode,
       PRVRETIVA AS withheldVat, PRVRETISR AS withheldIncomeTax, PRVINTERCIA AS intercompany
       FROM FPRV WHERE PRVSEQ=? LIMIT 1`, [id],
    );
    const row = rows[0];
    return row ? {
      tolerancePercent: Number(row.tolerancePercent), vatCode: Number(row.vatCode),
      withheldVat: Number(row.withheldVat), withheldIncomeTax: Number(row.withheldIncomeTax), intercompany: Number(row.intercompany),
    } : null;
  }

  async codeExists(code: string, excludeId = 0): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
      'SELECT PRVSEQ FROM FPRV WHERE PRVCOD=? AND PRVSEQ<>? LIMIT 1', [code, excludeId],
    );
    return rows.length > 0;
  }

  async leafAccount(code: string): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
      'SELECT BSEQ FROM FBENC WHERE BCOD=? AND BSUBCTAS=0 LIMIT 1', [code],
    );
    return rows.length > 0;
  }

  async dependency(id: number, code: string): Promise<string | null> {
    // Derivada de MPRV/22. Las seis relaciones conservan el orden de los avisos de Omnis.
    const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & { relation: number }>>(
      `SELECT ${nativeDependencies.map(([table], index) => `EXISTS(SELECT 1 FROM ${table} WHERE PRVSEQ=? LIMIT 1) AS relation${index}`).join(',')},
         EXISTS(SELECT 1 FROM FPRV WHERE PRVAPLICAR=? AND PRVAPLICAR<>'' AND PRVSEQ<>? LIMIT 1) AS applications`,
      [...nativeDependencies.map(() => id), code, id],
    );
    const row = rows[0];
    const relation = nativeDependencies.findIndex((_, index) => Boolean(row?.[`relation${index}`]));
    return nativeDependencies[relation]?.[1] ?? (row?.applications ? 'Otro proveedor aplica movimientos a este código.' : null);
  }
}
