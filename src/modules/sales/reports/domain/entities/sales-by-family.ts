export type SalesCriteria = { from: string; to: string; branch: string; family: string };
export type SalesOptions = { company: string; defaultFrom: string; defaultTo: string; defaultBranch: string;
  branches: Array<{ code: string; name: string; companyId: number }>; families: Array<{ code: string; name: string }> };
export type SalesBalance = { productId: number; code: string; description: string; family: string; familyName: string;
  companyId: number; unit: string; quantity: string; sales: string; returns: string; net: string;
  movements: number; firstDate: string; lastDate: string; movementTypes: string; missingPrices: number };
export type SalesProduct = SalesBalance & { branch: string; amount: number; saleAmount: number; returnAmount: number;
  units: number; metersPerUnit: number | null; meters: number | null };
export type SalesCell = { branch: string; amount: number; meters: number; percentage: number | null; meterPercentage: number | null };
export type SalesFamily = { code: string; name: string; amount: number; saleAmount: number; returnAmount: number;
  meters: number; percentage: number | null; meterPercentage: number | null; cells: SalesCell[]; products: SalesProduct[] };
export type SalesByFamily = { title: string; company: string; criteria: SalesCriteria; productType: 1; generatedAt: string; source: 'derivada';
  columns: Array<{ code: string; name: string }>; groups: SalesFamily[]; totals: SalesCell[]; amount: number; saleAmount: number;
  returnAmount: number; meters: number; movements: number; missingPrices: number; unconvertedProducts: number; empty: boolean; notes: string[] };

function decimal(value: string, scale: number): bigint {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error('Invalid sales decimal');
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
  if (fraction.length > scale) throw new Error('Sales decimal exceeds supported precision');
  const result = BigInt(whole!) * (10n ** BigInt(scale)) + BigInt(fraction.padEnd(scale, '0'));
  return value.startsWith('-') ? -result : result;
}
function cents(value: string): number {
  const raw = decimal(value, 8);
  const rounded = raw >= 0n ? (raw + 500_000n) / 1_000_000n : -((-raw + 500_000n) / 1_000_000n);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER) || rounded < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Sales amount exceeds supported precision');
  return Number(rounded) / 100;
}
const moneySum = (rows: SalesProduct[], key: 'amount' | 'saleAmount' | 'returnAmount') => rows.reduce((sum, row) => sum + Math.round(row[key] * 100), 0) / 100;
const meterSum = (rows: SalesProduct[]) => rows.reduce((sum, row) => sum + Math.round((row.meters ?? 0) * 10_000_000), 0) / 10_000_000;
const percentage = (value: number, total: number) => total === 0 ? null : Math.round(value / total * 1_000_000) / 10_000;
export function salesMetersPerUnit(unit: string): number | null {
  const normalized = unit.toUpperCase().replace(/[.\s]/g, '');
  return ['M', 'MT', 'MTR'].includes(normalized) ? 1 : ['TR', 'PZ'].includes(normalized) ? 6.4 : normalized === 'FT' ? 0.3048 : null;
}
export function buildSalesByFamily(options: SalesOptions, criteria: SalesCriteria, balances: SalesBalance[], generatedAt: string): SalesByFamily {
  const products: SalesProduct[] = balances.map(row => {
    const branch = options.branches.find(b => b.companyId === row.companyId)?.code ?? 'unassigned';
    const factor = salesMetersPerUnit(row.unit);
    return { ...row, branch, amount: cents(row.net), saleAmount: cents(row.sales), returnAmount: cents(row.returns), units: Number(row.quantity),
      metersPerUnit: factor, meters: factor === null ? null : Number(decimal(row.quantity, 3) * BigInt(Math.round(factor * 10000))) / 10_000_000 };
  });
  const codes = criteria.branch === 'all' ? [...new Set([...options.branches.map(b => b.code), ...products.map(p => p.branch)])].sort() : [criteria.branch];
  const columns = codes.map(code => ({ code, name: options.branches.find(b => b.code === code)?.name ?? 'Sin sucursal asignada' }));
  const cells = (rows: SalesProduct[]): SalesCell[] => columns.map(column => {
    const selected = rows.filter(p => p.branch === column.code);
    return { branch: column.code, amount: moneySum(selected, 'amount'), meters: meterSum(selected), percentage: null, meterPercentage: null };
  });
  const totals = cells(products); totals.forEach(cell => { cell.percentage = percentage(cell.amount, cell.amount); cell.meterPercentage = percentage(cell.meters, cell.meters); });
  const amount = moneySum(products, 'amount'), meters = meterSum(products);
  const families = new Map<string, SalesProduct[]>();
  for (const row of products) { const group = families.get(row.family) ?? []; group.push(row); families.set(row.family, group); }
  const preferred = ['B007','B008','B001','B013','B002','B004','B009','B003','B006','B015','B012','B016','B017','B014','B011','B010','B018','B005','B019','B020','B021'];
  const rank = (code: string) => preferred.includes(code) ? preferred.indexOf(code) : preferred.length;
  const groups = [...families].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b)).map(([code, rows]): SalesFamily => {
    const value = moneySum(rows, 'amount'), length = meterSum(rows);
    const groupCells = cells(rows); groupCells.forEach((cell, index) => { cell.percentage = percentage(cell.amount, totals[index]!.amount); cell.meterPercentage = percentage(cell.meters, totals[index]!.meters); });
    return { code, name: rows[0]!.familyName, amount: value, saleAmount: moneySum(rows, 'saleAmount'), returnAmount: moneySum(rows, 'returnAmount'),
      meters: length, percentage: percentage(value, amount), meterPercentage: percentage(length, meters), cells: groupCells,
      products: rows.sort((a, b) => a.code.localeCompare(b.code) || a.branch.localeCompare(b.branch) || a.productId - b.productId) };
  });
  return { title: 'Ventas por familia', company: options.company, criteria, productType: 1, generatedAt, source: 'derivada', columns, groups, totals, amount,
    saleAmount: moneySum(products, 'saleAmount'), returnAmount: moneySum(products, 'returnAmount'), meters,
    movements: products.reduce((sum, p) => sum + p.movements, 0), missingPrices: products.reduce((sum, p) => sum + p.missingPrices, 0),
    unconvertedProducts: products.filter(p => p.meters === null && p.units !== 0).length, empty: balances.length === 0,
    notes: ['Sólo productos FINV.ITIPO=1, agrupados por FINV.IFAMB; clasificación y UM del catálogo actual.',
      'Documentos de venta DESFACT=1, vigentes DEST=0, AIMES=1, con cliente existente; DOTROSTXT distinto de POS y DCONTROLPOS=0. No se restringe a FA: devoluciones y notas de crédito conservan su signo en AICANTF.',
      'Importe registrado = SUM(AICANTF × AIPRECIO), sin IVA ni cargos de encabezado. Conserva el cálculo capturado de Ventas por cliente; no usa AICOSTO ni reaplica descuentos o tipos de cambio.',
      'Se suman ocho decimales y se redondea a centavos por producto/sucursal. Restar columnas previamente redondeadas puede diferir por centavos del neto exacto.',
      'Sucursal determinada por FDOC.DMULTICIA y el catálogo FALMCAT, incluyendo ventas desde sus resguardos. No es AISUCURSAL del cliente ni un filtro físico por almacén.',
      'Rango de fechas inclusivo; una sola base configurada. Movimientos sin documento o fecha verificable no se asignan al periodo; no se suman respaldos anuales.',
      'Metros estimados: M/MT/MTR × 1, TR/PZ × 6.40 y FT × 0.3048. Sólo convierte cantidades; no multiplica el importe. Otras UM quedan fuera de metros y se conservan en el detalle.'] };
}
