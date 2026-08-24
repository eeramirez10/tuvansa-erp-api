import { ApplicationError } from './application-error.js';

export class NotFoundError extends ApplicationError {
  constructor(resource: string) {
    super(`${resource} no encontrado`, 'NOT_FOUND', 404);
  }
}
