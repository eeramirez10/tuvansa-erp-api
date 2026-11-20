import type { RowDataPacket } from 'mysql2/promise';
import { env } from '../../../../../config/env.js';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type {
  PurchaseOrderEditLegacyDataSource, PurchaseOrderEditProduct, PurchaseOrderEditRules,
} from '../../domain/datasources/purchase-order-edit-data-source.js';
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

export class LegacyMysqlPurchaseOrderEditDataSource implements PurchaseOrderEditLegacyDataSource {
  constructor(private readonly orders: LegacyMysqlPurchaseOrdersDataSource) {}

  findById(id: number) { return this.orders.findById(id); }

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

  private async products(where: string, values: string[], supplierUnits: boolean, orderBy = 'FINV.ISEQ'): Promise<PurchaseOrderEditProduct[]> {
    const [rows] = await legacyMysqlPool.execute<ProductRow[]>(
      `SELECT FINV.ISEQ AS id, ICOD AS code, IDESCR AS description, IPRV AS supplierCode,
        ICODPRV AS supplierProductCode, (IINACTIVO=1 OR IFAM9='9INA') AS inactive,
        (IPORCIVA=0) AS taxable, IMONEDA AS currencyId,
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
