import { describe, expect, it, vi } from 'vitest';
import { UpdatePurchaseOrderClassifications } from '../src/modules/purchasing/purchase-orders/application/use-cases/update-purchase-order-classifications.js';
import type {
  PurchaseOrderClassificationPanel, PurchaseOrdersRepository,
} from '../src/modules/purchasing/purchase-orders/domain/repositories/purchase-orders-repository.js';

const identity = { id: 42, number: 'O000042' };
const current = ['L', '', '', '', '', '', '', 'OLD', ''];
const panel: PurchaseOrderClassificationPanel = {
  purchaseOrder: identity, key: 'classifications', section: 'actions', button: 'Clasificar', source: 'mysql',
  items: [{ classifier: 1, code: 'A', description: 'Agente A', compositeCode: '1A' }],
  summary: { current, revision: 0, labels: [], canWrite: true },
};

function setup() {
  const repository: PurchaseOrdersRepository = {
    findById: vi.fn(), findByNumber: vi.fn(), search: vi.fn(), findAdjacent: vi.fn(), getPanel: vi.fn(),
    getClassifications: vi.fn().mockResolvedValue(panel),
    saveClassifications: vi.fn().mockImplementation(async (order, update) => ({
      ...order, current: update.current, revision: update.revision + 1,
    })),
  };
  return { repository, update: new UpdatePurchaseOrderClassifications(repository) };
}

describe('UpdatePurchaseOrderClassifications', () => {
  it('writes the nine fields together and preserves an unchanged legacy value absent from the catalog', async () => {
    const { repository, update } = setup();
    const requested = { current: ['1A', ...current.slice(1)], revision: 0 };
    const response = await update.execute(identity.id, requested);
    expect(repository.saveClassifications).toHaveBeenCalledExactlyOnceWith(identity, requested);
    expect(response.data.source).toBe('mysql+postgres');
    expect(response.data.summary).toMatchObject({ current: requested.current, revision: 1 });
  });

  it('rejects a code from the wrong classifier', async () => {
    const { repository, update } = setup();
    await expect(update.execute(identity.id, { current: [current[0]!, '1A', ...current.slice(2)], revision: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_PURCHASE_ORDER_CLASSIFIER', statusCode: 422 });
    expect(repository.saveClassifications).not.toHaveBeenCalled();
  });

  it('rejects stale saves and skips writing an unchanged classification', async () => {
    const { repository, update } = setup();
    await expect(update.execute(identity.id, { current, revision: 3 }))
      .rejects.toMatchObject({ code: 'PURCHASE_ORDER_CLASSIFICATIONS_STALE', statusCode: 409 });
    await expect(update.execute(identity.id, { current, revision: 0 })).resolves.toEqual({ data: panel });
    expect(repository.saveClassifications).not.toHaveBeenCalled();
  });
});
