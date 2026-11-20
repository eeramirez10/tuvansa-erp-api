import type { MovementDocument } from '../entities/inventory-movement.js';

export interface MovementCancellationRepository {
  canCancel(document: MovementDocument): Promise<string | null>;
  cancel(id: number): Promise<void>;
}
