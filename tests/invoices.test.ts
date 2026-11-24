import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { GetFirstInvoice } from '../src/modules/sales/invoicing/application/use-cases/get-first-invoice.js';
import { GetInvoiceByNumber } from '../src/modules/sales/invoicing/application/use-cases/get-invoice-by-number.js';
import { GetInvoicePanel } from '../src/modules/sales/invoicing/application/use-cases/get-invoice-panel.js';
import { NavigateInvoice } from '../src/modules/sales/invoicing/application/use-cases/navigate-invoice.js';
import { SearchInvoices } from '../src/modules/sales/invoicing/application/use-cases/search-invoices.js';
import { SimulateSalesStamping } from '../src/modules/sales/invoicing/application/use-cases/simulate-sales-stamping.js';
import { Invoice } from '../src/modules/sales/invoicing/domain/entities/invoice.js';
import type { InvoicePanelsRepository } from '../src/modules/sales/invoicing/domain/repositories/invoice-panels-repository.js';
import type { InvoicesRepository } from '../src/modules/sales/invoicing/domain/repositories/invoices-repository.js';
import { PostgresSalesStampingSimulations } from '../src/modules/sales/invoicing/infrastructure/datasources/postgres-sales-stamping-simulations.js';

const invoice = Invoice.create({
  id: 244045,
  number: '0007069',
  orderNumber: 'P015471',
  customerOrderNumber: 'TELEFONICO',
  customer: {
    id: 22903,
    code: '007569',
    name: 'ALTO DESARROLLO EN MANTENIMIENTO Y CONSTRUCCION',
    billedName: '',
  },
  movementType: 'FA',
  status: '',
  canceled: false,
  dates: {
    issuedAt: '2023-03-21',
    dueAt: '2023-03-16',
    paidAt: '2023-03-21',
    deliveryNoteAt: null,
  },
  delayDays: 5,
  attention: 'LUCIANA PALMA',
  attentionCode: '1223',
  branch: 0,
  department: '01',
  route: 0,
  pieces: 0,
  warehouse: '01',
  currency: { id: 0, name: 'PESOS', exchangeRate: 18.9972 },
  initial: false,
  cfdStatus: '',
  folio: '',
  deliveryNote: '',
  warehouseSeal: '',
  discountPercentages: [0, 0, 0],
  totals: {
    quantity: 0,
    fulfilledQuantity: 0,
    subtotal: 0,
    discount: 0,
    freight: 0,
    insurance: 0,
    other: 0,
    exciseTax: 0,
    tax: 0,
    total: 0,
    paid: 0,
    balance: 0,
  },
  lines: [{
    id: 394106,
    productId: 47087,
    productCode: '01208453',
    description: 'TAPON CAPA LIGERO VICTAULIC',
    quantity: 0,
    fulfilledQuantity: 0,
    unit: 'PZ',
    price: 0,
    grossPrice: 0,
    discount: 0,
    amount: 0,
    branch: 0,
    agent: '',
    pieces: 0,
    page: -6,
    factor: 1,
    cost: 0,
    package: '',
    sku: '',
    family: '',
  }],
});

const repository = (overrides: Partial<InvoicesRepository> = {}): InvoicesRepository => ({
  findById: async () => invoice,
  findByNumber: async () => invoice,
  findFirst: async () => invoice,
  findAdjacent: async () => invoice,
  search: async () => ({ items: [invoice], total: 1 }),
  ...overrides,
});

const localRemission = () => {
  const source = invoice.toPrimitives();
  return { ...source, id: 7100000000000, number: 'FAW00000001', cfdStatus: '0', folio: '', totals: { ...source.totals, total: 116 } };
};

describe('Simulación de timbrado', () => {
  it('consulta sin migrar y conserva una única referencia en PostgreSQL al reintentar', async () => {
    const db = new PGlite();
    const remission = localRemission();
    try {
      await db.exec(`
        CREATE SCHEMA tuvansa;
        CREATE TABLE tuvansa.sales_remissions (id bigint PRIMARY KEY,result jsonb NOT NULL);
      `);
      await db.query('INSERT INTO tuvansa.sales_remissions VALUES($1,$2::jsonb)', [remission.id, JSON.stringify({ invoice: remission })]);
      const store = new PostgresSalesStampingSimulations(async () => ({
        query: async <T extends object>(sql: string, values?: unknown[]) => {
          if (values) return db.query<T>(sql, values);
          const result = await db.exec(sql);
          return { rows: (result.at(-1)?.rows ?? []) as T[] };
        },
        release() {},
      }));
      const stamping = new SimulateSalesStamping(store, async () => remission, () => true);
      expect(await stamping.inspect(remission)).toEqual({ result: null });
      const initial = await db.query("SELECT to_regclass('tuvansa.sales_stamping_simulations') AS table_name");
      expect(initial.rows).toEqual([{ table_name: null }]);
      const stamp = await stamping.run(remission.id);
      expect(stamp).toMatchObject({ mode: 'simulation', reference: 'SIM-FE-FAW00000001' });
      expect(await stamping.run(remission.id)).toEqual(stamp);
      expect(await stamping.inspect(remission)).toEqual({ result: stamp });
      expect((await db.query('SELECT count(*)::int AS count FROM tuvansa.sales_stamping_simulations')).rows).toEqual([{ count: 1 }]);
    } finally {
      await db.close();
    }
  }, 15000);

  it('bloquea el flujo deshabilitado, documentos ajenos y remisiones canceladas o sin valor', async () => {
    const store = { find: vi.fn(), record: vi.fn() };
    const remission = localRemission();
    const findRemission = vi.fn();
    const disabled = new SimulateSalesStamping(store, findRemission, () => false);
    expect(await disabled.inspect(remission)).toBeUndefined();
    await expect(disabled.run(remission.id)).rejects.toMatchObject({ code: 'STAMPING_SIMULATION_DISABLED' });
    expect(findRemission).not.toHaveBeenCalled();

    const stamping = new SimulateSalesStamping(store, findRemission, () => true);
    findRemission.mockResolvedValueOnce(null);
    await expect(stamping.run(invoice.toPrimitives().id)).rejects.toMatchObject({ statusCode: 404 });
    for (const invalid of [{ ...remission, canceled: true }, { ...remission, totals: { ...remission.totals, total: 0 } }]) {
      expect(await stamping.inspect(invalid)).toBeUndefined();
      findRemission.mockResolvedValueOnce(invalid);
      await expect(stamping.run(remission.id)).rejects.toMatchObject({ code: 'STAMPING_SIMULATION_INELIGIBLE' });
    }
    expect(store.find).not.toHaveBeenCalled();
    expect(store.record).not.toHaveBeenCalled();
  });
});

describe('Ventas - Facturación', () => {
  it('conserva la ficha y las partidas capturadas de 0007069', () => {
    const result = invoice.toPrimitives();
    expect(result.number).toBe('0007069');
    expect(result.orderNumber).toBe('P015471');
    expect(result.lines[0]?.productCode).toBe('01208453');
    expect(result.delayDays).toBe(5);
  });

  it('carga el documento directamente por número', async () => {
    let received = '';
    const useCase = new GetInvoiceByNumber(repository({
      findByNumber: async (number) => { received = number; return invoice; },
      search: async () => { throw new Error('No debe ejecutar search'); },
    }));
    const result = await useCase.execute('0007069');
    expect(received).toBe('0007069');
    expect(result.lines).toHaveLength(1);
  });

  it('devuelve el primer documento y null en el extremo de navegación', async () => {
    await expect(new GetFirstInvoice(repository()).execute()).resolves.toMatchObject({ number: '0007069' });
    await expect(new NavigateInvoice(repository({ findAdjacent: async () => null })).execute(244045, 'previous'))
      .resolves.toBeNull();
  });

  it('conserva los filtros visibles de Búsqueda y pagina', async () => {
    let received: Parameters<InvoicesRepository['search']>[0] | undefined;
    const useCase = new SearchInvoices(repository({
      search: async (criteria) => { received = criteria; return { items: [invoice], total: 101 }; },
    }));
    const result = await useCase.execute({
      invoiceNumber: '0007069',
      orderNumber: 'P015471',
      customerOrderNumber: 'TELEFONICO',
      customerCode: '007569',
      issuedAt: '2023-03-21',
      page: 2,
      pageSize: 100,
    });
    expect(received).toMatchObject({ invoiceNumber: '0007069', offset: 100, limit: 100 });
    expect(result.pagination).toEqual({ page: 2, pageSize: 100, total: 101, pages: 2 });
  });

  it('mantiene el nombre visible Auxiliar y el contrato de solo lectura', async () => {
    const panels: InvoicePanelsRepository = {
      getPanel: async () => ({
        invoice: { id: 244045, number: '0007069' },
        key: 'auxiliary',
        section: 'actions',
        button: 'Auxiliar',
        available: true,
        source: 'mysql',
        readOnly: true,
        items: [{ movementType: 'FA', charges: 197.66, credits: 0 }],
      }),
    };
    const result = await new GetInvoicePanel(panels).execute(244045, 'auxiliary');
    expect(result.data).toMatchObject({ button: 'Auxiliar', readOnly: true });
    expect(result.data.items[0]).toMatchObject({ movementType: 'FA', charges: 197.66 });
  });
});
