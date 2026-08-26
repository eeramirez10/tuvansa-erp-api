import { ApplicationError } from './application-error.js';

export class ConflictError extends ApplicationError {
  constructor(message: string, code = 'CONFLICT') {
    super(message, code, 409);
  }
}
