import { sumInventoryValues, valueInventoryProduct, type InventoryValuation, type InventoryValueCell } from './inventory-valuation.js';
import { historicalInventoryValue, sumHistoricalInventoryValues, type HistoricalInventoryCosts, type HistoricalInventoryValue } from './historical-inventory-value.js';
export type InventoryCriteria = { asOf: string; warehouse: string; family: string; scope?: 'branch' | 'warehouse'; includeUndated?: boolean };
export type InventoryOptions = {
  company: string; defaultDate: string; defaultWarehouse: string;
  warehouses: Array<{ code: string; name: string; branchCode?: string | null }>;
  families: Array<{ code: string; name: string }>;
};
export type InventoryProductBalance = {
  productId: number; code: string; description: string;
  family: string; familyName: string; warehouse: string;
  unitId: number; unit: string;
  incoming: number; outgoing: number; quantity: number;
  firstDate: string | null; lastDate: string | null; movements: number;
  undatedMovements: number; undatedQuantity: number;
  undatedIncoming?: number; undatedOutgoing?: number; averageCost?: number;
  historicalCosts: HistoricalInventoryCosts;
};
export type InventoryTotals = {
  unitId: number; unit: string; incoming: number; outgoing: number; quantity: number;
  undatedMovements: number; undatedQuantity: number;
};
export type InventoryMeters = { incoming: number; outgoing: number; quantity: number; undatedQuantity: number };
export type ConvertedInventoryProduct = InventoryProductBalance & { metersPerUnit: number | null; meters: InventoryMeters | null;
  datedQuantity: number; datedIncoming: number; datedOutgoing: number; valuation: InventoryValuation; historical: HistoricalInventoryValue };
export type InventoryMeterColumn = { warehouse: string; name: string };
export type InventoryMeterCell = InventoryMeters & { warehouse: string; percentage: number | null };
export type InventoryFamilyGroup = {
  code: string; name: string; products: ConvertedInventoryProduct[]; totals: InventoryTotals[];
  meters: InventoryMeters; byWarehouse: InventoryMeterCell[]; percentage: number | null;
  unconverted: InventoryTotals[];
  valuation: InventoryValuation; valueByWarehouse: InventoryValueCell[]; valuationPercentage: number | null;
  historical: HistoricalInventoryValue; historicalByWarehouse: InventoryValueCell[]; historicalPercentage: number | null;
};
export type InventoryByFamily = {
  title: string; company: string; criteria: InventoryCriteria; warehouseName: string;
  generatedAt: string; groups: InventoryFamilyGroup[]; totals: InventoryTotals[];
  empty: boolean; provisional: boolean; undatedMovements: number;
  notes: string[]; source: 'derivada';
  meters: InventoryMeters; meterColumns: InventoryMeterColumn[]; meterTotals: InventoryMeterCell[];
  unconverted: InventoryTotals[];
  valuation: InventoryValuation; valuationTotals: InventoryValueCell[]; includedWarehouses: Array<{ code: string; name: string }>;
  historical: HistoricalInventoryValue; historicalTotals: InventoryValueCell[];
};

export function inventoryBranchCode(options: InventoryOptions, warehouse: string): string | null {
  const item = options.warehouses.find(w => w.code === warehouse);
  if (item && 'branchCode' in item) return item.branchCode ?? null;
  return /^0[1-7]$/.test(warehouse) ? warehouse : null;
}

// DERIVADA: TR/PZ equivalence explicitly requested by the user (2026-10-29).
// Fixed integer factors preserve seven decimals: source thousandths × factor/10000.
export function inventoryMetersPerUnit(unit: string): number | null {
  const code = unit.trim().toUpperCase().replace(/[.\s]/g, '');
  if (['M', 'MT', 'MTR'].includes(code)) return 1;
  if (['TR', 'PZ'].includes(code)) return 6.4;
  if (code === 'FT') return 0.3048;
  return null;
}
const meterKeys = ['incoming', 'outgoing', 'quantity', 'undatedQuantity'] as const;
function metersFor(rows: InventoryProductBalance[]): InventoryMeters {
  const total: InventoryMeters = { incoming: 0, outgoing: 0, quantity: 0, undatedQuantity: 0 };
  for (const row of rows) {
    const factor = inventoryMetersPerUnit(row.unit);
    if (factor === null) continue;
    for (const key of meterKeys) total[key] += Math.round(row[key] * 1000) * Math.round(factor * 10000);
  }
  for (const key of meterKeys) total[key] /= 10_000_000;
  return total;
}
function percentage(value: number, total: number): number | null {
  return total === 0 ? null : Math.round(value / total * 1_000_000) / 10_000;
}

// Source quantities are DECIMAL(18,3). Sum thousandths, keeping units separate.
function summarize(rows: InventoryProductBalance[]): InventoryTotals[] {
  const totals = new Map<number, InventoryTotals>();
  for (const row of rows) {
    const total = totals.get(row.unitId) ?? { unitId: row.unitId, unit: row.unit,
      incoming: 0, outgoing: 0, quantity: 0, undatedMovements: 0, undatedQuantity: 0 };
    for (const key of ['incoming', 'outgoing', 'quantity', 'undatedQuantity'] as const) {
      total[key] = (Math.round(total[key] * 1000) + Math.round(row[key] * 1000)) / 1000;
    }
    total.undatedMovements += row.undatedMovements;
    totals.set(row.unitId, total);
  }
  return [...totals.values()].sort((a, b) => a.unit.localeCompare(b.unit) || a.unitId - b.unitId);
}

export function buildInventoryByFamily(options: InventoryOptions, criteria: InventoryCriteria,
  balances: InventoryProductBalance[], generatedAt: string): InventoryByFamily {
  const byBranch = criteria.scope !== 'warehouse';
  const columnCode = (warehouse: string) => byBranch ? inventoryBranchCode(options, warehouse) ?? 'unassigned' : warehouse;
  const includeUndated = criteria.includeUndated === true;
  const families = new Map<string, InventoryFamilyGroup>();
  for (const row of balances) {
    const group = families.get(row.family) ?? { code: row.family, name: row.familyName, products: [], totals: [],
      meters: metersFor([]), byWarehouse: [], percentage: null, unconverted: [],
      valuation: sumInventoryValues([]), valueByWarehouse: [], valuationPercentage: null,
      historical: sumHistoricalInventoryValues([]), historicalByWarehouse: [], historicalPercentage: null };
    const factor = inventoryMetersPerUnit(row.unit);
    const selected = { ...row,
      incoming: (Math.round(row.incoming * 1000) + (includeUndated ? Math.round((row.undatedIncoming ?? Math.max(row.undatedQuantity, 0)) * 1000) : 0)) / 1000,
      outgoing: (Math.round(row.outgoing * 1000) + (includeUndated ? Math.round((row.undatedOutgoing ?? Math.max(-row.undatedQuantity, 0)) * 1000) : 0)) / 1000,
      quantity: (Math.round(row.quantity * 1000) + (includeUndated ? Math.round(row.undatedQuantity * 1000) : 0)) / 1000 };
    group.products.push({ ...selected, datedQuantity: row.quantity, datedIncoming: row.incoming, datedOutgoing: row.outgoing,
      metersPerUnit: factor, meters: factor === null ? null : metersFor([selected]),
      valuation: valueInventoryProduct(row.quantity, row.undatedQuantity, row.averageCost, includeUndated),
      historical: historicalInventoryValue(row.historicalCosts, includeUndated) });
    families.set(row.family, group);
  }
  // Match the supplied report's family order without hardcoding historical figures.
  const preferred = ['B007','B008','B001','B013','B002','B004','B009','B003','B006','B015','B012','B016','B017','B014','B011','B010','B018','B005','B019','B020','B021'];
  const rank = (code: string) => { const index = preferred.indexOf(code); return index < 0 ? preferred.length : index; };
  const groups = [...families.values()].sort((a, b) => rank(a.code) - rank(b.code) || a.code.localeCompare(b.code));
  const meterColumns: InventoryMeterColumn[] = (criteria.warehouse === 'all'
    ? [...new Set(balances.map(row => columnCode(row.warehouse)))].sort()
    : [criteria.warehouse]).map(warehouse => ({ warehouse,
      name: options.warehouses.find(w => w.code === warehouse)?.name ?? (warehouse === 'unassigned' ? 'Sin sucursal asignada' : warehouse || 'Sin almacén') }));
  const products = groups.flatMap(group => group.products);
  const meters = metersFor(products);
  const meterTotals: InventoryMeterCell[] = meterColumns.map(column => ({ warehouse: column.warehouse,
    ...metersFor(products.filter(row => columnCode(row.warehouse) === column.warehouse)), percentage: null }));
  const valuation = sumInventoryValues(products);
  const historical = sumHistoricalInventoryValues(products);
  const historicalTotals = meterColumns.map(column => ({ warehouse: column.warehouse,
    amount: sumHistoricalInventoryValues(products.filter(row => columnCode(row.warehouse) === column.warehouse)).reported, percentage: null as number | null }));
  for (const total of historicalTotals) total.percentage = total.amount === 0 ? null : 100;
  const valuationTotals = meterColumns.map(column => ({ warehouse: column.warehouse,
    amount: sumInventoryValues(products.filter(row => columnCode(row.warehouse) === column.warehouse)).reported, percentage: null as number | null }));
  for (const total of valuationTotals) total.percentage = total.amount === 0 ? null : 100;
  for (const total of meterTotals) total.percentage = total.quantity === 0 ? null : 100;
  for (const group of groups) {
    group.products.sort((a, b) => a.code.localeCompare(b.code) || a.warehouse.localeCompare(b.warehouse) || a.productId - b.productId);
    group.totals = summarize(group.products);
    group.meters = metersFor(group.products);
    group.unconverted = group.totals.filter(total => inventoryMetersPerUnit(total.unit) === null);
    group.byWarehouse = meterColumns.map((column, index) => {
      const value = metersFor(group.products.filter(row => columnCode(row.warehouse) === column.warehouse));
      return { warehouse: column.warehouse, ...value, percentage: percentage(value.quantity, meterTotals[index]!.quantity) };
    });
    group.percentage = percentage(group.meters.quantity, meters.quantity);
    group.valuation = sumInventoryValues(group.products);
    group.valuationPercentage = percentage(group.valuation.reported, valuation.reported);
    group.historical = sumHistoricalInventoryValues(group.products);
    group.historicalPercentage = percentage(group.historical.reported, historical.reported);
    group.historicalByWarehouse = meterColumns.map((column, index) => {
      const amount = sumHistoricalInventoryValues(group.products.filter(row => columnCode(row.warehouse) === column.warehouse)).reported;
      return { warehouse: column.warehouse, amount, percentage: percentage(amount, historicalTotals[index]!.amount) };
    });
    group.valueByWarehouse = meterColumns.map((column, index) => {
      const amount = sumInventoryValues(group.products.filter(row => columnCode(row.warehouse) === column.warehouse)).reported;
      return { warehouse: column.warehouse, amount, percentage: percentage(amount, valuationTotals[index]!.amount) };
    });
  }
  const undatedMovements = balances.reduce((sum, row) => sum + row.undatedMovements, 0);
  const notes = [
    'Existencia = entradas menos salidas de AICANT desde el primer movimiento fechado hasta la fecha indicada, inclusive. AIMES=1; documentos vigentes (DEST=0).',
    'Se consulta el historial de la base configurada, sin sumar copias anuales ni añadir ISTKACT o ISTKANT. Los traslados conservan ambos signos.',
    'Familia IFAMB, descripción y unidad corresponden al catálogo actual; no existe una clasificación histórica confirmada.',
    'Metros estimados: M/MT/MTR × 1; TR y PZ × 6.40 m por unidad, según equivalencia aproximada solicitada; FT × 0.3048 m. No representa la longitud medida de cada artículo.',
    'Modo costo promedio actual: existencia en UM original × FINV.ILISTA4, en moneda base del catálogo. No es el costo histórico confirmado a la fecha de corte. TR/PZ × 6.40 sólo convierte cantidades, no multiplica el importe.',
    'Costo histórico de movimientos: SUM(AICANT × AICOSTO), entradas positivas menos salidas a su propio costo. No se usa ILISTA4 ni AIPRECIO. Se suman los importes exactos de ocho decimales y se redondea a centavos por producto/almacén.',
    'Revaluaciones AIREVAL: se conservan aparte, incluidas las de cantidad cero. No se añaden ni restan al costo histórico de movimientos hasta confirmar su tratamiento en la valuación de PROSCAI.',
    'Modo costo promedio actual: importes redondeados a centavos por producto/almacén. Productos con ILISTA4 ausente, cero o negativo se identifican y no aportan importe en ese modo.',
    'Porcentaje = importe o metros de la familia / total de la misma medida de su columna × 100. Divisor cero se muestra vacío; se conservan negativos.',
    byBranch ? 'Sucursal incluye sus almacenes de resguardo según FALMCAT.CATMULTICIA. Los traslados internos conservan salida y entrada y se compensan dentro de la sucursal.' : 'Alcance limitado al almacén individual elegido.',
  ];
  if (valuation.unpricedProducts > 0) notes.push(`VALOR A COSTO ACTUAL INCOMPLETO: ${valuation.unpricedProducts} productos/almacenes con saldo o pendiente sin costo promedio válido en ILISTA4.`);
  if (historical.zeroCostMovements || historical.undatedZeroCostMovements) notes.push(`COSTOS HISTÓRICOS POR REVISAR: ${historical.zeroCostMovements} movimientos fechados y ${historical.undatedZeroCostMovements} sin fecha con costo cero o ausente. Se conserva el importe registrado; no se sustituye por el costo actual.`);
  const unconverted = summarize(products).filter(total => inventoryMetersPerUnit(total.unit) === null);
  const excluded = unconverted.filter(total => total.quantity !== 0 || total.undatedQuantity !== 0);
  if (excluded.length) notes.push('Unidades con saldo sin equivalencia a metros, excluidas del consolidado: ' + excluded.map(total => total.unit).join(', ') + '. Consulte el detalle en unidades originales.');
  if (undatedMovements > 0) notes.unshift(
    includeUndated
      ? `PROVISIONAL — ESCENARIO ESTIMADO: se incluyen TODOS los ${undatedMovements} movimientos sin fecha verificable, aunque no puede confirmarse que correspondan al corte. No equivale a un inventario histórico conciliado.`
      : `PROVISIONAL: ${undatedMovements} movimientos sin documento o fecha verificable quedan separados del saldo fechado. Active el escenario estimado para ver el efecto de incluirlos; no se les asigna una fecha inventada.`,
  );
  const includedWarehouses = options.warehouses.filter(w => criteria.warehouse === 'all' || (byBranch ? inventoryBranchCode(options, w.code) === criteria.warehouse : w.code === criteria.warehouse)).map(w => ({ code: w.code, name: w.name }));
  return { title: 'Inventario por familia', company: options.company, criteria,
    warehouseName: criteria.warehouse === 'all' ? byBranch ? 'Todas las sucursales y sus resguardos' : 'Todos los almacenes' : (options.warehouses.find(w => w.code === criteria.warehouse)?.name ?? criteria.warehouse) + (byBranch ? ' (incluye resguardos)' : ''),
    generatedAt, groups, totals: summarize(products), empty: balances.length === 0,
    provisional: undatedMovements > 0, undatedMovements, notes, source: 'derivada', meters, meterColumns, meterTotals, unconverted,
    valuation, valuationTotals, includedWarehouses, historical, historicalTotals };
}
