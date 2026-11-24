import type { InventoryAdjustmentInput, InventoryAdjustmentsRepository } from '../../domain/repositories/inventory-adjustments-repository.js';

export class CaptureInventoryMovements {
  constructor(private readonly repository: InventoryAdjustmentsRepository) {}

  async options() {
    return { data: await this.repository.capture() };
  }

  async save(input: InventoryAdjustmentInput) {
    return { data: await this.repository.create(input) };
  }
}
