export type InventoryCriteria = { asOf: string; warehouse: string; family: string };
export type InventoryOptions = {
  company: string; defaultDate: string; defaultWarehouse: string;
  warehouses: Array<{ code: string; name: string }>;
  families: Array<{ code: string; name: string }>;
};
export type InventoryProductBalance = {
  productId: number; code: string; description: string;
  family: string; familyName: string; warehouse: string;
  unitId: number; unit: string;
  incoming: number; outgoing: number; quantity: number;
  firstDate: string | null; lastDate: string | null; movements: number;
  undatedMovements: number; undatedQuantity: number;
};
export type InventoryTotals = {
  unitId: number; unit: string; incoming: number; outgoing: number; quantity: number;
  undatedMovements: number; undatedQuantity: number;
};
export type InventoryMeters = { incoming: number; outgoing: number; quantity: number; undatedQuantity: number };
export type ConvertedInventoryProduct = InventoryProductBalance & { metersPerUnit: number | null; meters: InventoryMeters | null };
export type InventoryMeterColumn = { warehouse: string; name: string };
export type InventoryMeterCell = InventoryMeters & { warehouse: string; percentage: number | null };
export type InventoryFamilyGroup = {
  code: string; name: string; products: ConvertedInventoryProduct[]; totals: InventoryTotals[];
  meters: InventoryMeters; byWarehouse: InventoryMeterCell[]; percentage: number | null;
  unconverted: InventoryTotals[];
};
export type InventoryByFamily = {
  title: string; company: string; criteria: InventoryCriteria; warehouseName: string;
  generatedAt: string; groups: InventoryFamilyGroup[]; totals: InventoryTotals[];
  empty: boolean; provisional: boolean; undatedMovements: number;
  notes: string[]; source: 'derivada';
  meters: InventoryMeters; meterColumns: InventoryMeterColumn[]; meterTotals: InventoryMeterCell[];
  unconverted: InventoryTotals[];
};

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
  const families = new Map<string, InventoryFamilyGroup>();
  for (const row of balances) {
    const group = families.get(row.family) ?? { code: row.family, name: row.familyName, products: [], totals: [],
      meters: metersFor([]), byWarehouse: [], percentage: null, unconverted: [] };
    const factor = inventoryMetersPerUnit(row.unit);
    group.products.push({ ...row, metersPerUnit: factor, meters: factor === null ? null : metersFor([row]) });
    families.set(row.family, group);
  }
  // Match the supplied report's family order without hardcoding historical figures.
  const preferred = ['B007','B008','B001','B013','B002','B004','B009','B003','B006','B015','B012','B016','B017','B014','B011','B010','B018','B005','B019','B020','B021'];
  const rank = (code: string) => { const index = preferred.indexOf(code); return index < 0 ? preferred.length : index; };
  const groups = [...families.values()].sort((a, b) => rank(a.code) - rank(b.code) || a.code.localeCompare(b.code));
  const meterColumns: InventoryMeterColumn[] = (criteria.warehouse === 'all'
    ? [...new Set(balances.map(row => row.warehouse))].sort()
    : [criteria.warehouse]).map(warehouse => ({ warehouse,
      name: options.warehouses.find(w => w.code === warehouse)?.name ?? (warehouse || 'Sin almacén') }));
  const meters = metersFor(balances);
  const meterTotals: InventoryMeterCell[] = meterColumns.map(column => ({ warehouse: column.warehouse,
    ...metersFor(balances.filter(row => row.warehouse === column.warehouse)), percentage: null }));
  for (const total of meterTotals) total.percentage = total.quantity === 0 ? null : 100;
  for (const group of groups) {
    group.products.sort((a, b) => a.code.localeCompare(b.code) || a.warehouse.localeCompare(b.warehouse) || a.productId - b.productId);
    group.totals = summarize(group.products);
    group.meters = metersFor(group.products);
    group.unconverted = group.totals.filter(total => inventoryMetersPerUnit(total.unit) === null);
    group.byWarehouse = meterColumns.map((column, index) => {
      const value = metersFor(group.products.filter(row => row.warehouse === column.warehouse));
      return { warehouse: column.warehouse, ...value, percentage: percentage(value.quantity, meterTotals[index]!.quantity) };
    });
    group.percentage = percentage(group.meters.quantity, meters.quantity);
  }
  const undatedMovements = balances.reduce((sum, row) => sum + row.undatedMovements, 0);
  const notes = [
    'Existencia = entradas menos salidas de AICANT desde el primer movimiento fechado hasta la fecha indicada, inclusive. AIMES=1; documentos vigentes (DEST=0).',
    'Se consulta el historial de la base configurada, sin sumar copias anuales ni añadir ISTKACT o ISTKANT. Los traslados conservan ambos signos.',
    'Familia IFAMB, descripción y unidad corresponden al catálogo actual; no existe una clasificación histórica confirmada.',
    'Metros estimados: M/MT/MTR × 1; TR y PZ × 6.40 m por unidad, según equivalencia aproximada solicitada; FT × 0.3048 m. No representa la longitud medida de cada artículo.',
    'El resumen reúne las unidades convertibles en una sola cantidad por familia. El detalle conserva la UM original; las unidades sin equivalencia no se suman como metros. Sin valuación monetaria.',
    'Porcentaje = metros de la familia / total de metros de la columna × 100. Cuando el total es cero se presenta vacío; se conservan saldos negativos.',
  ];
  const unconverted = summarize(balances).filter(total => inventoryMetersPerUnit(total.unit) === null);
  const excluded = unconverted.filter(total => total.quantity !== 0 || total.undatedQuantity !== 0);
  if (excluded.length) notes.push('Unidades con saldo sin equivalencia a metros, excluidas del consolidado: ' + excluded.map(total => total.unit).join(', ') + '. Consulte el detalle en unidades originales.');
  if (undatedMovements > 0) notes.unshift(
    `PROVISIONAL: ${undatedMovements} movimientos sin documento o fecha verificable no están incluidos en la existencia fechada. Su cantidad se informa por separado; no puede asignarse al corte.`,
  );
  return { title: 'Inventario por familia', company: options.company, criteria,
    warehouseName: criteria.warehouse === 'all' ? 'Todos los almacenes' : options.warehouses.find(w => w.code === criteria.warehouse)?.name ?? criteria.warehouse,
    generatedAt, groups, totals: summarize(balances), empty: balances.length === 0,
    provisional: undatedMovements > 0, undatedMovements, notes, source: 'derivada', meters, meterColumns, meterTotals, unconverted };
}
