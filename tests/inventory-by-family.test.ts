import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GetInventoryByFamily } from '../src/modules/inventories/reports/application/use-cases/get-inventory-by-family.js';
import { buildInventoryByFamily, type InventoryOptions, type InventoryProductBalance } from '../src/modules/inventories/reports/domain/entities/inventory-by-family.js';
import type { InventoryReportsRepository } from '../src/modules/inventories/reports/domain/repositories/inventory-reports-repository.js';
import { createInventoryReportsRouter } from '../src/modules/inventories/reports/presentation/http/inventory-reports-routes.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';
import { historicalInventoryValue } from '../src/modules/inventories/reports/domain/entities/historical-inventory-value.js';

const pool = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../src/shared/infrastructure/database/legacy-mysql-pool.js', () => ({ legacyMysqlPool: pool }));
import { LegacyMysqlInventoryReportsDataSource } from '../src/modules/inventories/reports/infrastructure/datasources/legacy-mysql-inventory-reports-data-source.js';

const options: InventoryOptions = { company: 'TEST', defaultDate: '', defaultWarehouse: '01', warehouses: [{ code: '01', name: 'MEXICO' }, { code: '02', name: 'MTY' }], families: [{ code: 'B008', name: 'TSC' }, { code: '', name: 'Sin familia' }] };
const criteria = { asOf: '2026-09-30', warehouse: '01', family: 'all' };
const balance = (overrides: Partial<InventoryProductBalance> = {}): InventoryProductBalance => ({
  productId: 1, code: '001', description: 'PRODUCTO', family: 'B008', familyName: 'TSC', warehouse: '01', unitId: 3, unit: 'M',
  incoming: 10, outgoing: 2, quantity: 8, averageCost: 10, firstDate: '2018-01-22', lastDate: '2026-09-30', movements: 4, undatedMovements: 0, undatedQuantity: 0,
  historicalCosts: { incoming: '100', outgoing: '20', dated: '80', unlinked: '0', revaluation: '0', undatedRevaluation: '0', zeroCostMovements: 0, undatedZeroCostMovements: 0 }, ...overrides,
});
const repository = (): InventoryReportsRepository => ({ options: vi.fn().mockResolvedValue(options), balances: vi.fn().mockResolvedValue([balance()]) });
afterEach(() => vi.clearAllMocks());

describe('Inventario por familia a una fecha', () => {
  it('separa familias, productos, almacenes y unidades sin sumar piezas con metros', () => {
    const result = buildInventoryByFamily(options, { ...criteria, warehouse: 'all' }, [balance(), balance({ productId: 2, code: '002', unitId: 1, unit: 'PZ', quantity: 4 }), balance({ warehouse: '02', quantity: -1 }), balance({ productId: 3, family: '', familyName: 'Sin familia', quantity: 2 })], '');
    expect(result.groups.map(g => g.code)).toEqual(['B008', '']);
    expect(result.groups[0]?.products).toHaveLength(3);
    expect(result.totals.map(t => [t.unit, t.quantity])).toEqual([['M', 9], ['PZ', 4]]);
    expect(result.provisional).toBe(false);
    expect(result.warehouseName).toBe('Todas las sucursales y sus resguardos');
  });
  it('convierte PZ y TR a 6.40 metros y reúne una sola cantidad por familia, conservando UM originales', () => {
    const result = buildInventoryByFamily(options, criteria, [
      balance({ incoming: 10, outgoing: 2, quantity: 8 }),
      balance({ productId: 2, unitId: 1, unit: 'PZ', incoming: 3, outgoing: 1, quantity: 2 }),
      balance({ productId: 3, unitId: 5, unit: 'TR', incoming: 2, outgoing: 1, quantity: 1 }),
    ], '');
    expect(result.groups[0]?.meters).toEqual({ incoming: 42, outgoing: 14.8, quantity: 27.2, undatedQuantity: 0 });
    expect(result.groups[0]?.products[1]).toMatchObject({ quantity: 2, unit: 'PZ', metersPerUnit: 6.4, meters: { quantity: 12.8 } });
    expect(result.totals).toHaveLength(3);
    expect(result.meters.quantity).toBe(27.2);
    expect(result.groups[0]?.percentage).toBe(100);
  });
  it('no mezcla kilos, litros ni servicios como metros y conserva los saldos no convertibles', () => {
    const result = buildInventoryByFamily(options, criteria, [balance({ quantity: 8 }),
      balance({ productId: 2, unitId: 2, unit: 'K', quantity: 50 }),
      balance({ productId: 3, unitId: 4, unit: 'L', quantity: 20 }),
    ], '');
    expect(result.meters.quantity).toBe(8);
    expect(result.unconverted.map(total => total.unit)).toEqual(['K', 'L']);
    expect(result.groups[0]?.products.find(row => row.unit === 'K')?.meters).toBeNull();
    expect(result.notes.some(note => note.includes('K, L'))).toBe(true);
  });
  it('mantiene precisión de conversiones fraccionarias y pies sin redondear cada producto', () => {
    const result = buildInventoryByFamily(options, criteria, [
      balance({ quantity: 0.001, unit: 'TR' }), balance({ productId: 2, quantity: 0.001, unit: 'PZ' }),
      balance({ productId: 3, quantity: 0.001, unit: 'FT' }),
    ], '');
    expect(result.meters.quantity).toBe(0.0131048);
    expect(result.groups[0]?.products.find(p => p.unit === 'FT')?.metersPerUnit).toBe(0.3048);
  });
  it('calcula porcentajes con el total propio de cada almacén y conserva negativos y divisores cero', () => {
    const result = buildInventoryByFamily(options, { ...criteria, warehouse: 'all' }, [
      balance({ quantity: 30 }), balance({ productId: 2, family: 'B007', familyName: 'TCC', quantity: 70 }),
      balance({ productId: 3, quantity: 5, warehouse: '02' }), balance({ productId: 4, family: 'B007', quantity: -5, warehouse: '02' }),
    ], '');
    const tsc = result.groups.find(g => g.code === 'B008')!;
    expect(tsc.byWarehouse.map(cell => cell.percentage)).toEqual([30, null]);
    expect(result.meterTotals.map(cell => cell.quantity)).toEqual([100, 0]);
    expect(result.meters.quantity).toBe(100);
    expect(tsc.percentage).toBe(35);
  });
  it('convierte la cantidad sin fecha por separado, sin incorporarla al corte', () => {
    const result = buildInventoryByFamily(options, criteria, [balance({ unit: 'TR', quantity: 1, undatedMovements: 2, undatedQuantity: -2 })], '');
    expect(result.meters).toMatchObject({ quantity: 6.4, undatedQuantity: -12.8 });
    expect(result.provisional).toBe(true);
  });
  it('no redondea las existencias a enteros ni introduce artefactos binarios', () => {
    const report = buildInventoryByFamily(options, criteria, [balance({ quantity: 0.1 }), balance({ productId: 2, quantity: 0.2 })], '');
    expect(report.totals[0]?.quantity).toBe(0.3);
  });
  it('conserva entradas y salidas de un producto agotado para que los totales históricos concilien', () => {
    const report = buildInventoryByFamily(options, criteria, [balance({ incoming: 10, outgoing: 10, quantity: 0 })], '');
    expect(report.empty).toBe(false);
    expect(report.groups[0]?.products).toHaveLength(1);
    expect(report.totals[0]).toMatchObject({ incoming: 10, outgoing: 10, quantity: 0 });
  });
  it('expone las cantidades sin fecha como provisionales sin mezclarlas con existencias fechadas', () => {
    const report = buildInventoryByFamily(options, criteria, [balance({ undatedMovements: 2, undatedQuantity: -5 })], '');
    expect(report).toMatchObject({ provisional: true, undatedMovements: 2, source: 'derivada' });
    expect(report.totals[0]).toMatchObject({ quantity: 8, undatedQuantity: -5 });
    expect(report.notes[0]).toContain('PROVISIONAL');
    expect(buildInventoryByFamily(options, criteria, [], '').empty).toBe(true);
  });
  it('usa fecha de México y valida catálogos sin aceptar identificadores del cliente', async () => {
    const repo = repository(); const report = new GetInventoryByFamily(repo, () => new Date('2026-01-01T03:00:00Z'));
    expect((await report.options()).defaultDate).toBe('2025-12-31');
    for (const input of [{ ...criteria, warehouse: '99' }, { ...criteria, family: 'XXXX' }, { ...criteria, asOf: '2026-02-30' }, { ...criteria, asOf: '1900-01-01' }]) {
      await expect(report.execute(input)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(repo.balances).not.toHaveBeenCalled();
    expect((await report.execute(criteria)).criteria).toEqual({ ...criteria, scope: 'branch', includeUndated: false });
  });
  it('rechaza fechas imposibles, listas, claves desconocidas y filtros extra en HTTP', async () => {
    const repo = repository(); const app = express().use(createInventoryReportsRouter(new GetInventoryByFamily(repo))).use(errorHandler);
    for (const query of ['asOf=2026-02-30', 'asOf=2026-09-30&warehouse=99', 'asOf=2026-09-30&family=XXXX', 'asOf=2026-09-30&database=tuvansa2025', 'asOf=2026-09-30&warehouse=01&warehouse=02', "asOf=2026-09-30&family='OR1"]) {
      await request(app).get('/by-family?' + query).expect(400);
    }
    expect(repo.balances).not.toHaveBeenCalled();
    await request(app).get('/by-family/options').expect(200).expect('Cache-Control', 'no-store');
    const result = await request(app).get('/by-family?asOf=2026-09-30').expect(200).expect('Cache-Control', 'no-store');
    expect(result.body.data.criteria).toEqual({ ...criteria, scope: 'branch', includeUndated: false });
    await request(app).post('/by-family').expect(404);
  });
  it('acumula AICANT firmado desde el inicio, limita el corte al día siguiente y conserva huérfanos', async () => {
    pool.execute.mockResolvedValueOnce([[{ ...balance(), incoming: '12.250', outgoing: '10.125', quantity: '2.125' }], []]);
    const source = new LegacyMysqlInventoryReportsDataSource(pool as never);
    const rows = await source.balances({ ...criteria, family: 'B008', scope: 'warehouse' });
    const [sql, parameters] = pool.execute.mock.calls[0]!;
    expect(parameters).toEqual(['2026-10-01', '01', 'B008']);
    expect(sql).toContain('a.AICANT>0'); expect(sql).toContain('THEN -a.AICANT');
    expect(sql).toContain('a.AIMES=1'); expect(sql).toContain('(d.DEST=0 OR d.DSEQ IS NULL)');
    expect(sql).toContain('d.DFECHA<?'); expect(sql).not.toContain('DFECHA>=');
    expect(sql).toContain('i.IFAMB'); expect(sql).not.toContain('AICANTF');
    expect(sql).not.toContain('ISTKACT'); expect(sql).not.toContain('ISTKANT');
    expect(sql).not.toContain('DMULTICIA=1'); expect(sql).not.toContain('IBAJA');
    expect(sql).toContain('GROUP BY FAMTNUM');
    expect(sql).toContain('a.AICANT*COALESCE(a.AICOSTO,0)');
    expect(sql).toContain('(a.AICANT<>0 OR a.AIREVAL<>0)');
    expect(sql).toContain('AS CHAR) AS historicalDated');
    expect(rows[0]?.quantity).toBe(2.125);
  });
  it('incluye todos los almacenes sin copiar la restricción México del Auxiliar antiguo', async () => {
    pool.execute.mockResolvedValueOnce([[], []]);
    await new LegacyMysqlInventoryReportsDataSource(pool as never).balances({ ...criteria, asOf: '2024-02-29', warehouse: 'all' });
    const [sql, parameters] = pool.execute.mock.calls[0]!;
    expect(parameters).toEqual(['2024-03-01']); expect(sql).not.toContain('a.AIALMACEN=?');
  });
  it('agrupa resguardos por propietario y compensa traslados internos sin perder el almacén original', () => {
    const catalog = { ...options, warehouses: [...options.warehouses.map(w => ({ ...w, branchCode: w.code })), { code: '15', name: 'RESGUARDO QRO', branchCode: '01' }] };
    const result = buildInventoryByFamily(catalog, criteria, [balance({ warehouse: '01', quantity: -10 }), balance({ warehouse: '15', quantity: 10 })], '');
    expect(result.meterColumns).toEqual([{ warehouse: '01', name: 'MEXICO' }]);
    expect(result.groups[0]?.byWarehouse[0]?.quantity).toBe(0);
    expect(result.groups[0]?.valueByWarehouse[0]?.amount).toBe(0);
    expect(result.groups[0]?.products.map(row => row.warehouse)).toEqual(['01', '15']);
    expect(result.includedWarehouses.map(w => w.code)).toEqual(['01', '15']);
  });
  it('valúa en UM original: dos tramos a 100 suman 200, sin multiplicar el importe por 6.40', () => {
    const result = buildInventoryByFamily(options, criteria, [balance({ unit: 'TR', quantity: 2, averageCost: 100 })], '');
    expect(result.meters.quantity).toBe(12.8);
    expect(result.valuation.reported).toBe(200);
    expect(result.groups[0]?.products[0]?.valuation.reported).toBe(200);
  });
  it('usa el costo propio de cada movimiento, aunque el stock sea cero y el costo actual sea otro', () => {
    // Two units enter at 10, then two leave at 12. This is not 0 × current cost.
    const result = buildInventoryByFamily(options, criteria, [balance({ quantity: 0, incoming: 2, outgoing: 2, averageCost: 999,
      historicalCosts: { incoming: '20', outgoing: '24', dated: '-4', unlinked: '0', revaluation: '4', undatedRevaluation: '0', zeroCostMovements: 0, undatedZeroCostMovements: 0 } })], '');
    expect(result.historical).toMatchObject({ incoming: 20, outgoing: 24, dated: -4, reported: -4, revaluation: 4 });
    expect(result.valuation.reported).toBe(0);
    expect(result.groups[0]?.historicalByWarehouse[0]?.amount).toBe(-4);
    expect(result.historicalTotals[0]?.amount).toBe(-4);
    expect(result.groups[0]?.historicalPercentage).toBe(100);
  });
  it('mantiene revaluaciones sin cantidad separadas y nunca las suma dos veces al valor de movimientos', () => {
    const result = buildInventoryByFamily(options, criteria, [balance({ quantity: 0, incoming: 0, outgoing: 0,
      historicalCosts: { incoming: '0', outgoing: '0', dated: '0', unlinked: '0', revaluation: '123.45', undatedRevaluation: '-5', zeroCostMovements: 0, undatedZeroCostMovements: 0 } })], '');
    expect(result.empty).toBe(false);
    expect(result.historical).toMatchObject({ reported: 0, revaluation: 123.45, undatedRevaluation: -5 });
  });
  it('respeta los cinco decimales de AICOSTO, acumula ocho y redondea el escenario después de sumar', () => {
    // Preserve the precision actually present in FAXINV, including half-cent boundaries.
    const costs = { incoming: '0.00499999', outgoing: '0', dated: '0.00499999', unlinked: '0.00000001', revaluation: '0', undatedRevaluation: '0', zeroCostMovements: 1, undatedZeroCostMovements: 2 };
    expect(historicalInventoryValue(costs, false)).toMatchObject({ dated: 0, unlinked: 0, reported: 0, zeroCostMovements: 1, undatedZeroCostMovements: 2 });
    expect(historicalInventoryValue(costs, true).reported).toBe(0.01);
    expect(historicalInventoryValue({ ...costs, dated: '-0.005', unlinked: '0' }, false).reported).toBe(-0.01);
    expect(() => historicalInventoryValue({ ...costs, dated: 'NaN' }, false)).toThrow();
  });
  it('compensa el valor de traslados internos al mismo costo y conserva el importe de cada almacén', () => {
    const catalog = { ...options, warehouses: [{ code: '01', name: 'MEXICO', branchCode: '01' }, { code: '15', name: 'RESGUARDO', branchCode: '01' }] };
    const original = balance().historicalCosts;
    const rows = [balance({ quantity: -2, historicalCosts: { ...original, incoming: '0', outgoing: '1900.12345', dated: '-1900.12345' } }),
      balance({ warehouse: '15', quantity: 2, historicalCosts: { ...original, incoming: '1900.12345', outgoing: '0', dated: '1900.12345' } })];
    const result = buildInventoryByFamily(catalog, criteria, rows, '');
    expect(result.historical.reported).toBe(0);
    expect(result.groups[0]?.historicalByWarehouse).toEqual([{ warehouse: '01', amount: 0, percentage: null }]);
    expect(result.groups[0]?.products.map(p => p.historical.reported)).toEqual([-1900.12, 1900.12]);
  });
  it('incorpora sólo los importes pendientes solicitados sin sustituir costos cero por ILISTA4', () => {
    const rows = [balance({ averageCost: 999, undatedMovements: 2, undatedQuantity: -1,
      historicalCosts: { incoming: '10', outgoing: '4', dated: '6', unlinked: '-2.25', revaluation: '30', undatedRevaluation: '1', zeroCostMovements: 3, undatedZeroCostMovements: 1 } })];
    expect(buildInventoryByFamily(options, criteria, rows, '').historical.reported).toBe(6);
    const result = buildInventoryByFamily(options, { ...criteria, includeUndated: true }, rows, '');
    expect(result.historical).toMatchObject({ dated: 6, unlinked: -2.25, reported: 3.75, zeroCostMovements: 3, undatedZeroCostMovements: 1 });
    expect(result.notes.join(' ')).toContain('COSTOS HISTÓRICOS POR REVISAR');
    expect(rows[0]?.historicalCosts.dated).toBe('6');
  });
  it('incluye pendientes sólo al elegir el escenario, con entradas y salidas separadas aunque se compensen', () => {
    const rows = [balance({ quantity: 5, incoming: 10, outgoing: 5, undatedMovements: 2, undatedQuantity: 0, undatedIncoming: 7, undatedOutgoing: 7 }),
      balance({ productId: 2, quantity: 3, undatedMovements: 1, undatedQuantity: -2, undatedOutgoing: 2 })];
    const dated = buildInventoryByFamily(options, criteria, rows, '');
    const estimated = buildInventoryByFamily(options, { ...criteria, includeUndated: true }, rows, '');
    expect(dated.valuation.reported).toBe(80);
    expect(estimated.valuation).toMatchObject({ dated: 80, unlinked: -20, reported: 60 });
    expect(estimated.groups[0]?.products[0]).toMatchObject({ incoming: 17, outgoing: 12, quantity: 5, datedQuantity: 5 });
    expect(estimated.groups[0]?.products[1]).toMatchObject({ quantity: 1, datedQuantity: 3 });
    expect(estimated.notes[0]).toContain('ESCENARIO ESTIMADO'); expect(estimated.provisional).toBe(true);
    expect(rows[1]?.quantity).toBe(3);
  });
  it('no inventa costos ausentes y redondea importes positivos/negativos a centavos', () => {
    const result = buildInventoryByFamily(options, criteria, [balance({ quantity: 1, averageCost: 0 }), balance({ productId: 2, quantity: 0.001, averageCost: 5 }), balance({ productId: 3, quantity: -0.001, averageCost: 5 })], '');
    expect(result.valuation.unpricedProducts).toBe(1);
    expect(result.valuation.reported).toBe(0);
    expect(result.groups[0]?.products[1]?.valuation.reported).toBe(0.01);
    expect(result.groups[0]?.products[2]?.valuation.reported).toBe(-0.01);
  });
  it('resguardo individual requiere scope warehouse; parámetros de escenario son booleanos estrictos', async () => {
    const repo = repository();
    vi.mocked(repo.options).mockResolvedValue({ ...options, warehouses: [...options.warehouses, { code: '15', name: 'RESGUARDO', branchCode: '01' }] });
    const app = express().use(createInventoryReportsRouter(new GetInventoryByFamily(repo))).use(errorHandler);
    await request(app).get('/by-family?asOf=2026-08-31&warehouse=15').expect(400);
    await request(app).get('/by-family?asOf=2026-08-31&warehouse=15&scope=warehouse&includeUndated=true').expect(200);
    expect(repo.balances).toHaveBeenLastCalledWith({ asOf: '2026-08-31', warehouse: '15', family: 'all', scope: 'warehouse', includeUndated: true });
    for (const value of ['1', 'yes', 'FALSE', 'false&includeUndated=true']) await request(app).get('/by-family?asOf=2026-08-31&includeUndated=' + value).expect(400);
  });
  it('asigna resguardos por compañía aunque el nombre sugiera otra sucursal, sin adivinar los no asignados', async () => {
    pool.execute.mockResolvedValueOnce([[
      { code: '01', name: 'MEXICO', companyId: 1 }, { code: '02', name: 'MTY', companyId: 2 },
      { code: '12', name: 'RESGUARDO MTY DE MEXICO', companyId: 1 },
      { code: '22', name: 'NO CALIDAD MTY', companyId: 2 }, { code: '99', name: 'TRANSITO', companyId: 0 },
    ], []]).mockResolvedValueOnce([[{ code: 'B007', name: 'TCC' }], []]).mockResolvedValueOnce([[{ name: 'TEST' }], []]);
    const result = await new LegacyMysqlInventoryReportsDataSource(pool as never).options();
    expect(result.warehouses.map(w => w.branchCode)).toEqual(['01', '02', '01', '02', null]);
  });
  it('la consulta de sucursal enlaza todos los códigos de resguardo obtenidos del catálogo', async () => {
    const source = new LegacyMysqlInventoryReportsDataSource(pool as never);
    vi.spyOn(source, 'options').mockResolvedValue({ ...options, warehouses: [{ code: '01', name: 'MEXICO', branchCode: '01' }, { code: '15', name: 'RESGUARDO', branchCode: '01' }, { code: '02', name: 'MTY', branchCode: '02' }] });
    pool.execute.mockResolvedValueOnce([[], []]);
    await source.balances({ ...criteria, scope: 'branch' });
    expect(pool.execute.mock.calls[0]?.[1]).toEqual(['2026-10-01', '01', '15']);
  });
});
