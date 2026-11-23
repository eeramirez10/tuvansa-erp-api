import type { RowDataPacket } from 'mysql2/promise';
import type { PurchaseOrderSupplierChoice, PurchaseOrderSupplierFilters } from '../../domain/datasources/purchase-order-supplier-change-data-source.js';
import { env } from '../../../../../config/env.js';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type {
  PurchaseOrderEditLegacyDataSource, PurchaseOrderEditProduct, PurchaseOrderEditRules,
} from '../../domain/datasources/purchase-order-edit-data-source.js';
import type {
  PurchaseOrderCreateDefaults, PurchaseOrderCreateLegacyDataSource, PurchaseOrderSupplier, PurchaseOrderWarehouse,
} from '../../domain/datasources/purchase-order-create-data-source.js';
import type { LegacyMysqlPurchaseOrdersDataSource } from './legacy-mysql-purchase-orders-data-source.js';

type RulesRow = RowDataPacket & Omit<PurchaseOrderEditRules, 'supplierDiscounts' | 'activeCompanyId'> & {
  discount1: number;
  discount2: number;
};

type ProductRow = RowDataPacket & Omit<PurchaseOrderEditProduct, 'units'> & {
  baseUnit: string;
  baseType: number;
  baseEquivalence: number;
  density: number;
  weightPerMeter: number;
  box: number;
  box2: number;
};
type UnitRow = RowDataPacket & { code: string; type: number; equivalence: number };

const currencies = Array.from({ length: 10 }, (_, index) => `FCIA.CIAPDD${index}`).join(', ');
const exchangeRates = Array.from({ length: 10 }, (_, index) => `FCIA.CIATIP${index}`).join(', ');
const company = env.PURCHASE_ORDER_EDIT_COMPANY_ID;
const warehouseCodes = env.PURCHASE_ORDER_WAREHOUSES ?? (company === 1 ? ['01', '11', '12', '13', '97', '99'] : []);
const mexicoDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' });

type DefaultsRow = RowDataPacket & {
  movement: string; alias: string; periodStart: string | null; periodEnd: string | null; maxLines: number;
  discountLocked: number; selectWarehouse: number; warehouse: string; tax0: number; tax1: number; tax2: number;
};
type SupplierRow = RulesRow & {
  id: number; code: string; name: string; terms: number; taxType: number;
};
const classifierColumns = [1, 2, 3, 4, 5, 6, 8, 9];

// MRECEP/70. FUNIDAD.UEQUIV es relativo a la unidad base del producto.
function unitsForProduct(row: ProductRow, catalog: UnitRow[]) {
  const units = [{ code: row.baseUnit, factor: 1 }];
  for (const unit of catalog) {
    if (unit.code === row.baseUnit) continue;
    const equivalent = (unit.equivalence || 1) / (row.baseEquivalence || 1);
    let factor: number | undefined;
    if (unit.type === row.baseType) factor = equivalent;
    else if (unit.type === 1 && row.baseType === 2 && row.density) factor = equivalent * row.density;
    else if (unit.type === 2 && row.baseType === 1 && row.density) factor = equivalent / row.density;
    else if (unit.type === 3 && row.baseType === 2 && row.weightPerMeter) factor = equivalent * row.weightPerMeter;
    else if (unit.type === 2 && row.baseType === 3 && row.weightPerMeter) factor = equivalent / row.weightPerMeter;
    else if (unit.type === 5) factor = equivalent * row.box || 1;
    else if (unit.type === 6) factor = equivalent * row.box2 || 1;
    if (factor && factor > 0 && Number.isFinite(factor)) units.push({ code: unit.code, factor });
  }
  if (catalog.length > 0 && /^\d{3}$/.test(row.secondaryUnit) && !units.some((unit) => unit.code === row.secondaryUnit)) {
    units.push({ code: row.secondaryUnit, factor: Number(row.secondaryUnit) || 1 });
  }
  return units;
}

export class LegacyMysqlPurchaseOrderEditDataSource implements PurchaseOrderEditLegacyDataSource, PurchaseOrderCreateLegacyDataSource {
  constructor(private readonly orders: LegacyMysqlPurchaseOrdersDataSource) {}

  findById(id: number) { return this.orders.findById(id); }

  readComments(id: number) { return this.orders.getPanel(id, 'comments'); }

  async commentCurrencyName(id: number): Promise<string> {
    const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & { currency: string | null }>>(
      `SELECT ELT(? + 1, ${currencies}) AS currency FROM FCIA WHERE CIASEQ=1`, [id],
    );
    return rows[0]?.currency ?? '';
  }

  async splitReferences(id: number, number: string) {
    const [[parents], [children]] = await Promise.all([
      legacyMysqlPool.execute<Array<RowDataPacket & { counter: number }>>('SELECT PEHIJOS AS counter FROM FPENC WHERE PESEQ=? AND PENUM=?', [id, number]),
      legacyMysqlPool.execute<Array<RowDataPacket & { number: string }>>(
        'SELECT PENUM AS number FROM FPENC WHERE LEFT(PENUM,CHAR_LENGTH(?))=? AND CHAR_LENGTH(PENUM)=CHAR_LENGTH(?)+1', [number, number, number],
      ),
    ]);
    return { counter: Number(parents[0]?.counter) || 0, occupied: children.map((row) => row.number.toUpperCase()) };
  }

  async rules(id: number): Promise<PurchaseOrderEditRules | null> {
    const [rows] = await legacyMysqlPool.execute<RulesRow[]>(
      `SELECT PEMULTICIA AS companyId,
        (SUBSTRING(CIACOMPORTA,71,1)='1') AS priceLocked,
        (SUBSTRING(CIACOMPORTA,56,1)='1') AS supplierUnits,
        (SUBSTRING(CIACOMPORTA,97,1)='1') AS validateSupplier,
        PEMONEDA AS currencyId, COALESCE(ELT(PEMONEDA + 1, ${currencies}), '') AS currencyName,
        FPRV.PRVCOD AS supplierCode, FPRV.PRVDESC1 AS discount1, FPRV.PRVDESC2 AS discount2
       FROM FPENC LEFT JOIN FPRV ON FPRV.PRVSEQ=FPENC.PRVSEQ
       LEFT JOIN FCIA ON FCIA.CIASEQ=1
       WHERE FPENC.PESEQ=? AND FPENC.PESPEDIDO IN (2,5)`, [id],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      companyId: row.companyId, activeCompanyId: env.PURCHASE_ORDER_EDIT_COMPANY_ID,
      priceLocked: Boolean(row.priceLocked), supplierUnits: Boolean(row.supplierUnits), validateSupplier: Boolean(row.validateSupplier),
      currencyId: row.currencyId, currencyName: row.currencyName, supplierCode: row.supplierCode ?? '',
      supplierDiscounts: [Number(row.discount1), Number(row.discount2)],
    };
  }

  async creationDefaults(): Promise<PurchaseOrderCreateDefaults | null> {
    const [rows] = await legacyMysqlPool.execute<DefaultsRow[]>(
      `SELECT TIDESCR AS movement, TILARGO AS maxLines, CIAALIAS AS alias,
        NULLIF(CIAFI, '1900-12-31') AS periodStart, NULLIF(CIAFF, '1900-12-31') AS periodEnd,
        TIIVA0 AS tax0, TIIVA1 AS tax1, TIIVA2 AS tax2,
        SUBSTRING(CIACOMPORTA, 95, 1) = '1' AS discountLocked,
        SUBSTRING(CIACOMPORTA, 37, 1) = '1' AS selectWarehouse, CIAALM AS warehouse, ${exchangeRates},
        TICOML1, TICOML2, TICOML3, TICOML4, TICOML5
       FROM FTIPMV JOIN FCIA ON FCIA.CIASEQ=1
       WHERE TICLA='O' AND (TIMODULO=6 OR SUBSTRING(CIACOMPORTA, 76, 1)<>'1')
       ORDER BY TISEQ LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    const today = mexicoDate.format();
    const dueAt = new Date(`${today}T00:00:00Z`);
    if (row.alias === 'STYLO') dueAt.setUTCDate(dueAt.getUTCDate() + 30);
    return {
      today, from: today, dueAt: dueAt.toISOString().slice(0, 10),
      warehouse: warehouseCodes[0] ?? row.warehouse,
      selectWarehouse: Boolean(row.selectWarehouse),
      movement: row.movement,
      periodStart: row.periodStart, periodEnd: row.periodEnd, maxLines: Number(row.maxLines),
      taxPercentage: Number(row.tax0), taxRates: [row.tax0, row.tax1, row.tax2].map(Number),
      discountLocked: Boolean(row.discountLocked),
      exchangeRates: Array.from({ length: 10 }, (_, index) => Number(row[`CIATIP${index}`])),
      labels: Array.from({ length: 5 }, (_, index) => String(row[`TICOML${index + 1}`] ?? '')),
    };
  }

  async creationSuppliers(query: string, exact = false): Promise<PurchaseOrderSupplier[]> {
    const [rows] = await legacyMysqlPool.execute<SupplierRow[]>(
      `SELECT PRVSEQ AS id, TRIM(PRVCOD) AS code, PRVNOM AS name, PRVPLAZO AS terms,
        PRVTIPOIVA AS taxType, PRVMONEDA AS currencyId,
        COALESCE(ELT(PRVMONEDA + 1, ${currencies}), '') AS currencyName,
        (SUBSTRING(CIACOMPORTA,71,1)='1') AS priceLocked,
        (SUBSTRING(CIACOMPORTA,56,1)='1') AS supplierUnits,
        (SUBSTRING(CIACOMPORTA,97,1)='1') AS validateSupplier,
        PRVDESC1 AS discount1, PRVDESC2 AS discount2,
        ${classifierColumns.map((col) => `PRVPAR${col}`).join(', ')}
       FROM FPRV JOIN FCIA ON FCIA.CIASEQ=1
       WHERE PRVBAJA='1900-12-31' AND (${exact ? 'PRVCOD=?' : 'PRVCOD LIKE ? OR PRVNOM LIKE ?'})
       ORDER BY PRVCOD=? DESC, PRVCOD, PRVSEQ LIMIT ${exact ? 1 : 35}`,
      exact ? [query, query] : [`${query}%`, `%${query}%`, query],
    );
    return rows.map((row) => ({
      supplier: { id: row.id, code: row.code, name: row.name },
      terms: Number(row.terms), taxType: Number(row.taxType),
      classifications: Array.from({ length: 9 }, (_, index) => String(row[`PRVPAR${index + 1}`] ?? '')),
      rules: {
        companyId: env.PURCHASE_ORDER_EDIT_COMPANY_ID, activeCompanyId: env.PURCHASE_ORDER_EDIT_COMPANY_ID,
        priceLocked: Boolean(row.priceLocked), supplierUnits: Boolean(row.supplierUnits), validateSupplier: Boolean(row.validateSupplier),
        currencyId: row.currencyId, currencyName: row.currencyName, supplierCode: row.code,
        supplierDiscounts: [Number(row.discount1), Number(row.discount2)],
      },
    }));
  }

  async changeSuppliers({ code, name }: PurchaseOrderSupplierFilters, exact = false): Promise<PurchaseOrderSupplierChoice[]> {
    const filters: string[] = [];
    const params: string[] = [];
    if (code) {
      filters.push(exact ? 'PRVCOD=?' : 'PRVCOD LIKE ?');
      params.push(exact ? code : `${code}%`);
    }
    if (name) {
      if (name.startsWith('**')) {
        filters.push('PRVVARIOS1=?');
        params.push(name.slice(2).toUpperCase());
      } else if (name.startsWith('*')) {
        filters.push('LOCATE(UPPER(?), UPPER(PRVNOM))>0');
        params.push(name.slice(1));
      } else {
        filters.push('PRVNOM LIKE ?');
        params.push(`${name}%`);
      }
    }
    if (filters.length === 0) return [];
    const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & {
      id: number; code: string; name: string; discount1: number; discount2: number; taxType: number;
    }>>(
      `SELECT PRVSEQ AS id, TRIM(PRVCOD) AS code, PRVNOM AS name, PRVDESC1 AS discount1, PRVDESC2 AS discount2, PRVTIPOIVA AS taxType
       FROM FPRV WHERE PRVSEQ>0 AND ${filters.join(' AND ')}
       ORDER BY ${name ? 'PRVNOM, ' : ''}PRVCOD, PRVSEQ LIMIT ${exact ? 1 : 35}`, params,
    );
    return rows.map(({ id, code, name, discount1, discount2, taxType }) => ({
      supplier: { id, code, name }, supplierDiscounts: [Number(discount1), Number(discount2)], taxType: Number(taxType),
    }));
  }

  async creationWarehouses(): Promise<PurchaseOrderWarehouse[]> {
    // EALM#1/240 filtra con el usuario de Omnis. La API usa el alcance de captura configurado.
    const scope = warehouseCodes.length > 0
      ? `CATALM IN (${warehouseCodes.map(() => '?').join(', ')})`
      : "CATUSUARIOS=''";
    const [rows] = await legacyMysqlPool.execute<(RowDataPacket & PurchaseOrderWarehouse)[]>(
      `SELECT CATALM AS code, CATDESCR AS description FROM FALMCAT
       WHERE CATTIPO='' AND CATMULTICIA IN (0, ?) AND CATALM<>'' AND ${scope}
       ORDER BY CATALM, CATSEQ`, [company, ...warehouseCodes],
    );
    const warehouses = new Map<string, PurchaseOrderWarehouse>();
    for (const { code, description } of rows) {
      if (!warehouses.has(code)) warehouses.set(code, { code, description });
    }
    return [...warehouses.values()];
  }

  async hasPurchaseAgent(code: string): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
      "SELECT 1 AS found FROM FAG WHERE AGTNUM=? AND AGT='1' AND AGTIPO IN (0, 2) LIMIT 1", [`1${code}`],
    );
    return rows.length > 0;
  }

  private async products(where: string, values: string[], supplierUnits: boolean, orderBy = 'FINV.ISEQ'): Promise<PurchaseOrderEditProduct[]> {
    const [rows] = await legacyMysqlPool.execute<ProductRow[]>(
      `SELECT FINV.ISEQ AS id, ICOD AS code, IDESCR AS description, IPRV AS supplierCode,
        ICODPRV AS supplierProductCode, (IINACTIVO=1 OR IFAM9='9INA') AS inactive,
        (IPORCIVA=0) AS taxable, IPORCIEPES AS exciseTaxPercentage, IMONEDA AS currencyId,
        COALESCE(ELT(IMONEDA + 1, ${currencies}), '') AS currencyName,
        ILISTA5 AS cost, ILISTA6 AS dollarCost, IUM AS baseUnit, IUM2 AS secondaryUnit,
        FUNIDAD.UTIPO AS baseType, FUNIDAD.UEQUIV AS baseEquivalence,
        FINV.IDENSIDAD AS density, FINV.IPESOMTRO AS weightPerMeter,
        FINV.ICANTCAJA AS box, FINV.ICANTCAJA2 AS box2
       FROM FINV LEFT JOIN FCIA ON FCIA.CIASEQ=1
       LEFT JOIN FUNIDAD ON FUNIDAD.USEQ=FINV.USEQ
       WHERE ${where} ORDER BY ${orderBy}`,
      values,
    );
    const [catalog] = supplierUnits && rows.length > 0
      ? await legacyMysqlPool.query<UnitRow[]>('SELECT UCOD AS code, UTIPO AS type, UEQUIV AS equivalence FROM FUNIDAD WHERE UCOD <> \'\' ORDER BY USEQ')
      : [[]];
    return rows.map((row) => ({
      id: row.id, code: row.code, description: row.description, supplierCode: row.supplierCode,
      supplierProductCode: row.supplierProductCode, inactive: Boolean(row.inactive), taxable: Boolean(row.taxable),
      exciseTaxPercentage: Number(row.exciseTaxPercentage ?? 0),
      currencyId: row.currencyId, currencyName: row.currencyName, cost: row.cost, dollarCost: row.dollarCost,
      secondaryUnit: row.secondaryUnit, units: unitsForProduct(row, catalog),
    }));
  }

  findProducts(codes: string[], supplierUnits: boolean) {
    if (codes.length === 0) return Promise.resolve([]);
    return this.products(`ICOD IN (${codes.map(() => '?').join(',')})`, codes, supplierUnits);
  }

  searchProducts(query: string, supplierUnits: boolean) {
    return this.products('ICOD LIKE ? OR IDESCR LIKE ?', [`${query}%`, `%${query}%`, query], supplierUnits, 'FINV.ICOD = ? DESC, FINV.ICOD, FINV.ISEQ LIMIT 35');
  }
}
