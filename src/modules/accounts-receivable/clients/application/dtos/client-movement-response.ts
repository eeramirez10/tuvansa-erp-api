import type { ClientMovement } from '../../domain/entities/client-movement.js';

export type ClientMovementResponse = ReturnType<ClientMovement['toPrimitives']>;

export const toClientMovementResponse = (
  movement: ClientMovement,
): ClientMovementResponse => movement.toPrimitives();
