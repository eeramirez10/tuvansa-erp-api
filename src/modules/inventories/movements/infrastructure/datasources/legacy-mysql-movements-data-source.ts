import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { legacyReceiptSupplierSearch } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/legacy-receipt-supplier-search.js';
import { readReceiptSupplierChanges, type ReceiptSupplierChange } from '../../../../purchasing/purchase-receptions/infrastructure/datasources/purchase-reception-supplier-change-reads.js';
import type { MovementsDataSource } from '../../domain/datasources/movements-data-source.js';
import type { MovementDocument, MovementHeader, MovementLine } from '../../domain/entities/inventory-movement.js';
import type { MovementSearchCriteria, MovementSearchResult } from '../../domain/repositories/movements-repository.js';

interface HeaderRow extends RowDataPacket, MovementHeader {}
interface LineRow extends RowDataPacket, Omit<MovementLine, 'pieces'> {}
interface CountRow extends RowDataPacket { total: number }

const headerFields = (supplierCode = 'FPRV.PRVCOD') => `
  FDOC.DSEQ AS id,
  COALESCE(FDOC.DNUM, '') AS document,
  COALESCE(FDOC.DFECHA, '') AS date,
  COALESCE(FDOC.DREFER, '') AS reference,
  COALESCE(FDOC.DREFERELLOS, '') AS reference2,
  COALESCE(FDOC.DALMACEN, '') AS warehouse,
  COALESCE(${supplierCode}, '') AS supplierCode,
  COALESCE(FCLI.CLICOD, '') AS customerCode,
  COALESCE(FCLI.CLINOM, '') AS customerName,
  COALESCE(FDOC.DITIPMV, '') AS type,
  FDOC.DEST AS status,
  FDOC.DMULTICIA AS company,
  FDOC.DIUSEQ AS userId,
  FDOC.DESINV AS inventoryFlag,
  FDOC.DESFACT AS billingFlag
`;

const headers = `FROM FDOC
  LEFT JOIN FCLI ON FCLI.CLISEQ = FDOC.CLISEQ
  LEFT JOIN FPRV ON FPRV.PRVSEQ = FDOC.PRVSEQ`;

const searchLimit = 1000;

const lineFields = `
  FAXINV.AISEQ AS id,
  FAXINV.ISEQ AS productId,
  COALESCE(FINV.ICOD, '') AS productCode,
  COALESCE(FINV.IDESCR, '') AS description,
  COALESCE(FAXINV.AICANT, 0) AS quantity,
  COALESCE(FAXINV.AIUNIDAD, '') AS unit,
  COALESCE(FAXINV.AICOSTO, 0) AS cost,
  COALESCE(FAXINV.AIPZAS, '') AS piecesText,
  COALESCE(FAXINV.AIALMACEN, '') AS warehouse,
  COALESCE(FAXINV.AITIPMV, '') AS type,
  FAXINV.LOSEQ AS lotId,
  FAXINV.AIUSEQ AS userId
`;

const prefix = (value: string): string => value.replace(/[!%_]/g, '!$&') + '%';

export class LegacyMysqlMovementsDataSource implements MovementsDataSource {
  constructor(private readonly supplierChanges = () => readReceiptSupplierChanges({ historical: true })) {}

  async search(criteria: MovementSearchCriteria): Promise<MovementSearchResult> {
    const conditions = ['FDOC.DESINV = 1'];
    const parameters: string[] = [];
    if (![criteria.document, criteria.reference, criteria.reference2, criteria.warehouse, criteria.supplier, criteria.customer, criteria.date]
      .some((value) => value !== undefined)) return { items: [], total: 0 };
    const supplier = legacyReceiptSupplierSearch(await this.supplierChanges());
    const filters = [
      ['FDOC.DNUM', criteria.document],
      ['FDOC.DREFER', criteria.reference],
      ['FDOC.DREFERELLOS', criteria.reference2],
      ['FDOC.DALMACEN', criteria.warehouse],
      [supplier.code, criteria.supplier],
      ['FCLI.CLICOD', criteria.customer],
    ] as const;
    for (const [field, value] of filters) {
      if (value === undefined) continue;
      conditions.push(`${field} LIKE ? ESCAPE '!'`);
      parameters.push(prefix(value));
    }
    if (criteria.date !== undefined) {
      conditions.push('FDOC.DFECHA = ?');
      parameters.push(criteria.date);
    }
    if (parameters.length === 0) return { items: [], total: 0 };
    const sortFields = [
      ['FDOC.DFECHA', criteria.date],
      ['FDOC.DREFER', criteria.reference],
      ['FDOC.DREFERELLOS', criteria.reference2],
      [supplier.code, criteria.supplier],
      ['FCLI.CLICOD', criteria.customer],
    ] as const;
    const sort = sortFields.find(([, value]) => value !== undefined)?.[0] ?? 'FDOC.DNUM';
    const limit = Math.max(0, Math.min(criteria.limit, searchLimit - criteria.offset));
    const scope = `${headers} ${supplier.join} WHERE ${conditions.join(' AND ')}`;
    const [rows] = await legacyMysqlPool.execute<HeaderRow[]>(
      `SELECT ${headerFields(supplier.code)} ${scope}
       ORDER BY ${sort}, FDOC.DSEQ LIMIT ? OFFSET ?`,
      [...supplier.values, ...parameters, limit, criteria.offset],
    );
    const [count] = await legacyMysqlPool.execute<CountRow[]>(
      `SELECT COUNT(*) AS total FROM (SELECT 1 ${scope} LIMIT ?) AS matched`,
      [...supplier.values, ...parameters, searchLimit],
    );
    return { items: rows, total: Number(count[0]?.total ?? 0) };
  }

  async findById(id: number, changes: ReceiptSupplierChange[] = []): Promise<MovementDocument | null> {
    const supplier = legacyReceiptSupplierSearch(changes);
    const [result] = await legacyMysqlPool.execute<HeaderRow[]>(
      `SELECT ${headerFields(supplier.code)} ${headers} ${supplier.join} WHERE FDOC.DSEQ = ? LIMIT 1`,
      [...supplier.values, id],
    );
    const header = result[0];
    if (!header) return null;
    const [lineRows] = await legacyMysqlPool.execute<LineRow[]>(
      `SELECT ${lineFields}
       FROM FAXINV LEFT JOIN FINV ON FINV.ISEQ = FAXINV.ISEQ
       WHERE FAXINV.DSEQ = ? ORDER BY FAXINV.AISEQ`,
      [id],
    );
    const totals = { quantity: 0, cost: 0 };
    const lines = lineRows.map((line): MovementLine => {
      totals.quantity += line.quantity;
      totals.cost += line.quantity * line.cost;
      const pieces = Number(line.piecesText);
      return { ...line, pieces: Number.isFinite(pieces) ? pieces : 0 };
    });
    return { header, lines, totals };
  }
}
