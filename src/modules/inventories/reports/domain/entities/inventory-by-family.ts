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
export type InventoryFamilyGroup = {
  code: string; name: string; products: InventoryProductBalance[]; totals: InventoryTotals[];
};
export type InventoryByFamily = {
  title: string; company: string; criteria: InventoryCriteria; warehouseName: string;
  generatedAt: string; groups: InventoryFamilyGroup[]; totals: InventoryTotals[];
  empty: boolean; provisional: boolean; undatedMovements: number;
  notes: string[]; source: 'derivada';
};

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
    const group = families.get(row.family) ?? { code: row.family, name: row.familyName, products: [], totals: [] };
    group.products.push(row);
    families.set(row.family, group);
  }
  const groups = [...families.values()].sort((a, b) => a.code.localeCompare(b.code));
  for (const group of groups) {
    group.products.sort((a, b) => a.code.localeCompare(b.code) || a.warehouse.localeCompare(b.warehouse) || a.productId - b.productId);
    group.totals = summarize(group.products);
  }
  const undatedMovements = balances.reduce((sum, row) => sum + row.undatedMovements, 0);
  const notes = [
    'Existencia = entradas menos salidas de AICANT desde el primer movimiento fechado hasta la fecha indicada, inclusive. AIMES=1; documentos vigentes (DEST=0).',
    'Se consulta el historial de la base configurada, sin sumar copias anuales ni añadir ISTKACT o ISTKANT. Los traslados conservan ambos signos.',
    'Familia IFAMB, descripción y unidad corresponden al catálogo actual; no existe una clasificación histórica confirmada.',
    'Los totales se separan por unidad. Este reporte expresa cantidades, sin valuación monetaria.',
  ];
  if (undatedMovements > 0) notes.unshift(
    `PROVISIONAL: ${undatedMovements} movimientos sin documento o fecha verificable no están incluidos en la existencia fechada. Su cantidad se informa por separado; no puede asignarse al corte.`,
  );
  return { title: 'Inventario por familia', company: options.company, criteria,
    warehouseName: criteria.warehouse === 'all' ? 'Todos los almacenes' : options.warehouses.find(w => w.code === criteria.warehouse)?.name ?? criteria.warehouse,
    generatedAt, groups, totals: summarize(balances), empty: balances.length === 0,
    provisional: undatedMovements > 0, undatedMovements, notes, source: 'derivada' };
}
