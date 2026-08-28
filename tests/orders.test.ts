import { describe, expect, it } from 'vitest';
import { CreateOrder } from '../src/modules/sales/orders/application/use-cases/create-order.js';
import { DeleteOrder } from '../src/modules/sales/orders/application/use-cases/delete-order.js';
import { GetOrderPanel } from '../src/modules/sales/orders/application/use-cases/get-order-panel.js';
import { GetOrderByNumber } from '../src/modules/sales/orders/application/use-cases/get-order-by-number.js';
import { NavigateOrder } from '../src/modules/sales/orders/application/use-cases/navigate-order.js';
import { SearchOrders } from '../src/modules/sales/orders/application/use-cases/search-orders.js';
import { Order } from '../src/modules/sales/orders/domain/entities/order.js';
import type { OrderPanelsRepository } from '../src/modules/sales/orders/domain/repositories/order-panels-repository.js';
import type { OrdersRepository } from '../src/modules/sales/orders/domain/repositories/orders-repository.js';

const order = Order.create({
  id: 72391, number: 'P010773', customerOrderNumber: '9063',
  customer: { id: 15363, code: '000033', name: 'COMERCIAL DE VALVULAS' },
  documentKind: 'order', status: 'SURT', fulfilledAmount: 365.05,
  branch: 0, department: '', dates: { orderedAt: '2021-05-05', from: '2021-05-05', dueAt: '2021-05-05' },
  attention: 'MARIO MOSQUEDA', termsDays: 30, authorization: 'O.K.', initial: false,
  warehouse: '01', currencyId: 2, exchangeRate: 0, minimumFulfillmentPercentage: 0,
  observations: '', classifications: ['1212', '202', '302', '', '', '', ''],
  totals: { quantity: 7, ordered: 7, fulfilled: 7, remaining: 0, subtotal: 365.05, discount: 0, freight: 0, insurance: 0, other: 0, tax: 58.41, total: 423.46 },
  lines: [{ id: 280666, productId: 10590, productCode: '01209642', description: 'TEE REDUCIDA', ordered: 3, fulfilled: 3, remaining: 0, unit: 'PZ', assigned: 0, branch: 0, price: 52.15, classCode: '', currencyId: 0, piecesAssignment: '', discount: 0, publicPrice: 0, sku: '', color: '', size: '' }],
});

const repository = (overrides: Partial<OrdersRepository> = {}): OrdersRepository => ({
  findById: async () => order, findByNumber: async () => order,
  search: async () => ({ items: [order], total: 1 }),
  findAdjacent: async () => order, numberExists: async () => false,
  customerExists: async () => true, create: async () => order, update: async () => order,
  delete: async () => ({ status: 'deleted' }), ...overrides,
});

describe('Ventas - Pedidos', () => {
  it('conserva encabezado, partidas e importes capturados de P010773', () => {
    const response = order.toPrimitives();
    expect(response.number).toBe('P010773');
    expect(response.lines[0]?.productCode).toBe('01209642');
    expect(response.totals.total).toBe(423.46);
  });
  it('obtiene directamente el detalle por número sin ejecutar una búsqueda paginada', async () => {
    let receivedNumber = '';
    const useCase = new GetOrderByNumber(repository({
      findByNumber: async (orderNumber) => { receivedNumber = orderNumber; return order; },
      search: async () => { throw new Error('No debe ejecutar search'); },
    }));

    const response = await useCase.execute('P010773');

    expect(receivedNumber).toBe('P010773');
    expect(response.number).toBe('P010773');
    expect(response.lines).toHaveLength(1);
  });
  it('rechaza números duplicados al crear', async () => {
    const useCase = new CreateOrder(repository({ numberExists: async () => true }));
    await expect(useCase.execute({ number: 'P010773', customerId: 15363, orderedAt: '2026-08-26', lines: [{ productId: 10590, quantity: 1, price: 1 }] }))
      .rejects.toMatchObject({ code: 'ORDER_NUMBER_EXISTS', statusCode: 409 });
  });
  it('devuelve null al llegar al extremo de navegación', async () => {
    await expect(new NavigateOrder(repository({ findAdjacent: async () => null })).execute(72391, 'next')).resolves.toBeNull();
  });
  it('impide borrar un pedido facturado o surtido', async () => {
    await expect(new DeleteOrder(repository({ delete: async () => ({ status: 'in-use', relation: 'fdoc' }) })).execute(72391))
      .rejects.toMatchObject({ code: 'ORDER_IN_USE', statusCode: 409 });
  });
  it('conserva los filtros de la ventana Búsqueda y calcula la paginación', async () => {
    let received: Parameters<OrdersRepository['search']>[0] | undefined;
    const useCase = new SearchOrders(repository({
      search: async (criteria) => { received = criteria; return { items: [order], total: 201 }; },
    }));
    const response = await useCase.execute({
      orderNumber: 'P010773', customerOrderNumber: '9063', customerCode: '000033',
      orderedAt: '2021-05-05', dueAt: '2021-05-05', agent: '010', status: 'SURT',
      branch: 0, warehouse: '01', authorization: 'O.K.',
      minimumFulfillmentPercentage: 0, page: 2, pageSize: 100,
    });
    expect(received).toMatchObject({ orderNumber: 'P010773', offset: 100, limit: 100 });
    expect(response.pagination).toEqual({ page: 2, pageSize: 100, total: 201, pages: 3 });
  });
  it('mantiene el nombre visual Auxiliar aunque la función consulte facturas', async () => {
    const panels: OrderPanelsRepository = { getPanel: async () => ({ order: { id: 72391, number: 'P010773' }, key: 'invoices', section: 'actions', button: 'Auxiliar', available: true, source: 'mysql', items: [{ documentNumber: 'FE0050992', date: '2021-05-06' }] }) };
    const response = await new GetOrderPanel(panels).execute(72391, 'invoices');
    expect(response.data.button).toBe('Auxiliar');
    expect(response.data.items[0]).toMatchObject({ documentNumber: 'FE0050992' });
  });
});
