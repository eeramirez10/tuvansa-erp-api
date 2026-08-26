import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { ProductsDataSource } from '../../domain/datasources/products-data-source.js';
import { Product, type ProductProps, type ProductType } from '../../domain/entities/product.js';
import type {
  DeleteProductResult,
  ProductCreateValues,
  ProductNavigationDirection,
  ProductSearchCriteria,
  ProductSearchResult,
  ProductWriteValues,
} from '../../domain/repositories/products-repository.js';

interface ProductRow extends RowDataPacket {
  id: number;
  code: string;
  description: string;
  typeId: number;
  deactivatedAt: string | null;
  familyCode: string;
  unitId: number;
  unitCode: string | null;
  unitDescription: string | null;
  unitType: number | null;
  hasPhoto: number;
  salePrice1: number;
  salePrice2: number;
  salePrice3: number;
  saleCurrency1: number;
  saleCurrency2: number;
  saleCurrency3: number;
  averageCost: number;
  lastCost: number;
  previousCost: number;
  costCurrency: number;
  adValorem: number;
  minimum: number;
  maximum: number;
  location: string;
  ean: string;
  upc: string;
  primaryAccount: string;
  secondaryAccount: string;
  costOfSalesAccount: string;
  lastPurchaseAt: string | null;
  lastSaleAt: string | null;
  assigned: number;
  confirmed: number;
  customerOrders: number;
  customerQuotes: number;
  supplierOrders: number;
  supplierQuotes: number;
  currentStock: number;
  previousStock: number;
  accumulatedStock: number;
  previousQuantity: number;
  accumulatedQuantity: number;
  pieceStock: number;
  salesLastSixMonths: number;
  inventoryDays: number;
  createdAt: string | null;
}

interface CountRow extends RowDataPacket { total: number }
interface ExistsRow extends RowDataPacket { found: number }
interface IdCodeRow extends RowDataPacket { id: number; code: string }
interface UnitRow extends RowDataPacket { code: string }

const selectProductFields = `
  FINV.ISEQ AS id,
  ICOD AS code,
  IDESCR AS description,
  ITIPO AS typeId,
  NULLIF(IBAJA, '1900-12-31') AS deactivatedAt,
  IFAM AS familyCode,
  FINV.USEQ AS unitId,
  FUNIDAD.UCOD AS unitCode,
  FUNIDAD.UDESCR AS unitDescription,
  FUNIDAD.UTIPO AS unitType,
  IFOTO AS hasPhoto,
  ILISTA1 AS salePrice1,
  ILISTA2 AS salePrice2,
  ILISTA3 AS salePrice3,
  IMONEDA1 AS saleCurrency1,
  IMONEDA2 AS saleCurrency2,
  IMONEDA3 AS saleCurrency3,
  ILISTA4 AS averageCost,
  ILISTA5 AS lastCost,
  ILISTA6 AS previousCost,
  IMONEDA AS costCurrency,
  IADVALOREM AS adValorem,
  IMINIMO AS minimum,
  IMAXIMO AS maximum,
  ILOCALIZ AS location,
  IEAN AS ean,
  IUPC AS upc,
  ICTA AS primaryAccount,
  ICTADEV AS secondaryAccount,
  ICTA3 AS costOfSalesAccount,
  NULLIF(IULTCPR, '1900-12-31') AS lastPurchaseAt,
  NULLIF(IULTVTA, '1900-12-31') AS lastSaleAt,
  IASIGNADO AS assigned,
  ICONFIRMADO AS confirmed,
  IPEDCLI AS customerOrders,
  IPEDCOTIZ AS customerQuotes,
  IPEDPRV AS supplierOrders,
  IORDCOTIZ AS supplierQuotes,
  ISTKACT AS currentStock,
  ISTKANT AS previousStock,
  ISTKACU AS accumulatedStock,
  ICANTAN AS previousQuantity,
  ICANTAC AS accumulatedQuantity,
  ISTKPZS AS pieceStock,
  IVTA AS salesLastSixMonths,
  IDIASSTK AS inventoryDays,
  NULLIF(IALTA, '1900-12-31') AS createdAt
`;

const typeFromId = (typeId: number): ProductType => {
  const types: ProductType[] = [
    'rawMaterial', 'finishedProduct', 'set', 'assembly', 'service',
  ];
  return types[typeId] ?? 'unknown';
};

const typeToId: Record<Exclude<ProductType, 'unknown'>, number> = {
  rawMaterial: 0,
  finishedProduct: 1,
  set: 2,
  assembly: 3,
  service: 4,
};

const toProduct = (row: ProductRow): Product => {
  const props: ProductProps = {
    id: row.id,
    code: row.code,
    description: row.description,
    isActive: row.deactivatedAt === null,
    deactivatedAt: row.deactivatedAt,
    classification: {
      type: typeFromId(row.typeId),
      familyCode: row.familyCode,
      unit: {
        id: row.unitId,
        code: row.unitCode ?? '',
        description: row.unitDescription ?? '',
      },
      usesColorAndSize: (row.unitType ?? 0) !== 0,
      hasPhoto: row.hasPhoto === 1,
    },
    prices: {
      sale: [
        { amount: row.salePrice1, currencyId: row.saleCurrency1 },
        { amount: row.salePrice2, currencyId: row.saleCurrency2 },
        { amount: row.salePrice3, currencyId: row.saleCurrency3 },
      ],
      costs: {
        average: row.averageCost,
        last: row.lastCost,
        previous: row.previousCost,
        currencyId: row.costCurrency,
        adValorem: row.adValorem,
      },
    },
    warehouse: {
      minimum: row.minimum,
      maximum: row.maximum,
      location: row.location,
      ean: row.ean,
      upc: row.upc,
      accounts: {
        primary: row.primaryAccount,
        secondary: row.secondaryAccount,
        costOfSales: row.costOfSalesAccount,
      },
    },
    accumulated: {
      lastPurchaseAt: row.lastPurchaseAt,
      lastSaleAt: row.lastSaleAt,
      assigned: row.assigned,
      confirmed: row.confirmed,
      customerOrders: row.customerOrders,
      customerQuotes: row.customerQuotes,
      supplierOrders: row.supplierOrders,
      supplierQuotes: row.supplierQuotes,
      currentStock: row.currentStock,
      previousStock: row.previousStock,
      accumulatedStock: row.accumulatedStock,
      previousQuantity: row.previousQuantity,
      accumulatedQuantity: row.accumulatedQuantity,
      pieceStock: row.pieceStock,
      salesLastSixMonths: row.salesLastSixMonths,
      inventoryDays: row.inventoryDays,
    },
    createdAt: row.createdAt,
  };
  return Product.create(props);
};

const columnByField: Omit<Record<keyof ProductWriteValues, string>, 'unitId'> = {
  code: 'ICOD',
  description: 'IDESCR',
  type: 'ITIPO',
  familyCode: 'IFAM',
  hasPhoto: 'IFOTO',
  salePrice1: 'ILISTA1',
  salePrice2: 'ILISTA2',
  salePrice3: 'ILISTA3',
  saleCurrency1: 'IMONEDA1',
  saleCurrency2: 'IMONEDA2',
  saleCurrency3: 'IMONEDA3',
  averageCost: 'ILISTA4',
  lastCost: 'ILISTA5',
  previousCost: 'ILISTA6',
  costCurrency: 'IMONEDA',
  adValorem: 'IADVALOREM',
  minimum: 'IMINIMO',
  maximum: 'IMAXIMO',
  location: 'ILOCALIZ',
  ean: 'IEAN',
  upc: 'IUPC',
  primaryAccount: 'ICTA',
  secondaryAccount: 'ICTADEV',
  costOfSalesAccount: 'ICTA3',
};

type WriteField = Exclude<keyof ProductWriteValues, 'unitId'>;
type SqlValue = string | number;

const storedValue = (field: WriteField, value: string | number | boolean): SqlValue => {
  if (field === 'type') return typeToId[value as Exclude<ProductType, 'unknown'>] ?? 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
};

const writeEntries = (
  values: ProductWriteValues,
): Array<[WriteField, string | number | boolean]> =>
  (Object.entries(values) as Array<[
    keyof ProductWriteValues,
    string | number | boolean | undefined,
  ]>)
    .filter((entry): entry is [WriteField, string | number | boolean] =>
      entry[0] !== 'unitId' && entry[1] !== undefined);

const statusCondition = (status: ProductSearchCriteria['status']): string => {
  if (status === 'active') return " AND IBAJA = '1900-12-31'";
  if (status === 'inactive') return " AND IBAJA <> '1900-12-31'";
  return '';
};

const productDependencyTables = ['faxinv', 'fplin', 'fvanu2', 'fcanu2'] as const;

export class LegacyMysqlProductsDataSource implements ProductsDataSource {
  async findById(productId: number): Promise<Product | null> {
    const [rows] = await legacyMysqlPool.execute<ProductRow[]>(
      `SELECT ${selectProductFields}
       FROM finv
       LEFT JOIN funidad ON FINV.USEQ = FUNIDAD.USEQ
       WHERE FINV.ISEQ = ?
       LIMIT 1`,
      [productId],
    );
    return rows[0] === undefined ? null : toProduct(rows[0]);
  }

  async search(criteria: ProductSearchCriteria): Promise<ProductSearchResult> {
    const searchCondition = criteria.query === undefined
      ? ''
      : ` AND (UPPER(ICOD) LIKE UPPER(?) OR UPPER(IDESCR) LIKE UPPER(?)
        OR UPPER(IEAN) LIKE UPPER(?) OR UPPER(IUPC) LIKE UPPER(?))`;
    const where = `1 = 1${statusCondition(criteria.status)}${searchCondition}`;
    const parameters = criteria.query === undefined
      ? []
      : Array(4).fill(`%${criteria.query}%`);
    const [rows] = await legacyMysqlPool.execute<ProductRow[]>(
      `SELECT ${selectProductFields}
       FROM finv
       LEFT JOIN funidad ON FINV.USEQ = FUNIDAD.USEQ
       WHERE ${where}
       ORDER BY ICOD
       LIMIT ? OFFSET ?`,
      [...parameters, criteria.limit, criteria.offset],
    );
    const [countRows] = await legacyMysqlPool.execute<CountRow[]>(
      `SELECT COUNT(*) AS total FROM finv WHERE ${where}`,
      parameters,
    );
    return { items: rows.map(toProduct), total: countRows[0]?.total ?? 0 };
  }

  async findAdjacent(
    productId: number,
    direction: ProductNavigationDirection,
  ): Promise<Product | null> {
    const [currentRows] = await legacyMysqlPool.execute<IdCodeRow[]>(
      'SELECT ISEQ AS id, ICOD AS code FROM finv WHERE ISEQ = ? LIMIT 1',
      [productId],
    );
    const current = currentRows[0];
    if (current === undefined) return null;
    const operator = direction === 'previous' ? '<' : '>';
    const order = direction === 'previous' ? 'DESC' : 'ASC';
    const [rows] = await legacyMysqlPool.execute<ProductRow[]>(
      `SELECT ${selectProductFields}
       FROM finv
       LEFT JOIN funidad ON FINV.USEQ = FUNIDAD.USEQ
       WHERE ICOD ${operator} ?
       ORDER BY ICOD ${order}, FINV.ISEQ ${order}
       LIMIT 1`,
      [current.code],
    );
    return rows[0] === undefined ? null : toProduct(rows[0]);
  }

  async codeExists(code: string, excludingProductId?: number): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<ExistsRow[]>(
      excludingProductId === undefined
        ? 'SELECT 1 AS found FROM finv WHERE ICOD = ? LIMIT 1'
        : 'SELECT 1 AS found FROM finv WHERE ICOD = ? AND ISEQ <> ? LIMIT 1',
      excludingProductId === undefined ? [code] : [code, excludingProductId],
    );
    return rows.length > 0;
  }

  async unitExists(unitId: number): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<ExistsRow[]>(
      'SELECT 1 AS found FROM funidad WHERE USEQ = ? LIMIT 1',
      [unitId],
    );
    return rows.length > 0;
  }

  async accountingAccountExists(account: string): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<ExistsRow[]>(
      'SELECT 1 AS found FROM fbenc WHERE BCOD = ? LIMIT 1',
      [account],
    );
    return rows.length > 0;
  }

  private async unitCode(unitId: number): Promise<string> {
    const [rows] = await legacyMysqlPool.execute<UnitRow[]>(
      'SELECT UCOD AS code FROM funidad WHERE USEQ = ? LIMIT 1',
      [unitId],
    );
    return rows[0]?.code ?? '';
  }

  async create(values: ProductCreateValues): Promise<Product> {
    const unitId = values.unitId ?? 1;
    const unitCode = await this.unitCode(unitId);
    const normalized: ProductCreateValues = {
      ...values,
      type: values.type ?? 'rawMaterial',
    };
    const entries = writeEntries(normalized);
    const columns = entries.map(([field]) => columnByField[field]);
    const parameters = entries.map(([field, value]) => storedValue(field, value));
    const placeholders = entries.map(() => '?');
    const [result] = await legacyMysqlPool.execute<ResultSetHeader>(
      `INSERT INTO finv
         (${columns.join(', ')}, USEQ, IUM, ILOTE, ICANTCAJA, IBODEGA,
          IFECHACAMBIO, IALTA, IUM2, IUM2FACTOR, IRENGLON, IEDIEMP,
          IFECHACAMBIOPR)
       VALUES
         (${placeholders.join(', ')}, ?, ?, 1, 1, 1,
          CURDATE(), CURDATE(), ?, 1, 'A', 'BX', CURDATE())`,
      [...parameters, unitId, unitCode, unitCode],
    );
    const product = await this.findById(result.insertId);
    if (product === null) throw new Error('No fue posible recuperar el producto creado');
    return product;
  }

  async update(productId: number, values: ProductWriteValues): Promise<Product | null> {
    const entries = writeEntries(values);
    const assignments = entries.map(([field]) => `${columnByField[field]} = ?`);
    const parameters = entries.map(([field, value]) => storedValue(field, value));
    if (values.unitId !== undefined) {
      const unitCode = await this.unitCode(values.unitId);
      assignments.push('USEQ = ?', 'IUM = ?', 'IUM2 = ?');
      parameters.push(values.unitId, unitCode, unitCode);
    }
    if (assignments.length === 0) return this.findById(productId);
    await legacyMysqlPool.execute<ResultSetHeader>(
      `UPDATE finv
       SET ${assignments.join(', ')}, IFECHACAMBIO = CURDATE()
       WHERE ISEQ = ?`,
      [...parameters, productId],
    );
    return this.findById(productId);
  }

  async delete(productId: number): Promise<DeleteProductResult> {
    const connection = await legacyMysqlPool.getConnection();
    try {
      await connection.beginTransaction();
      const [productRows] = await connection.execute<IdCodeRow[]>(
        'SELECT ISEQ AS id, ICOD AS code FROM finv WHERE ISEQ = ? LIMIT 1 FOR UPDATE',
        [productId],
      );
      const product = productRows[0];
      if (product === undefined) {
        await connection.rollback();
        return { status: 'not-found' };
      }

      const [assemblyRows] = await connection.execute<ExistsRow[]>(
        'SELECT 1 AS found FROM fens WHERE EPRO = ? OR EART = ? LIMIT 1',
        [product.code, product.code],
      );
      if (assemblyRows.length > 0) {
        await connection.rollback();
        return { status: 'in-use', relation: 'fens' };
      }

      for (const table of productDependencyTables) {
        const [rows] = await connection.execute<ExistsRow[]>(
          `SELECT 1 AS found FROM ${table} WHERE ISEQ = ? LIMIT 1`,
          [productId],
        );
        if (rows.length > 0) {
          await connection.rollback();
          return { status: 'in-use', relation: table };
        }
      }

      await connection.execute<ResultSetHeader>('DELETE FROM falm WHERE ISEQ = ?', [productId]);
      await connection.execute<ResultSetHeader>('DELETE FROM finv WHERE ISEQ = ?', [productId]);
      await connection.commit();
      return { status: 'deleted' };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}
