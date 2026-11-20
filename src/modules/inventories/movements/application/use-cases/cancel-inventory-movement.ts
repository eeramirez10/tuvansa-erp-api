import type { MovementCancellationRepository } from '../../domain/repositories/movement-cancellation-repository.js';

export class CancelInventoryMovement {
  constructor(private readonly repository: MovementCancellationRepository) {}

  async execute(id: number): Promise<void> {
    await this.repository.cancel(id);
  }
}
