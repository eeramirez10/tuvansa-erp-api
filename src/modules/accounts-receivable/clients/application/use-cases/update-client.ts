import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { ClientToolbarRepository } from '../../domain/repositories/client-toolbar-repository.js';
import { toWriteValues, type UpdateClientInput } from '../dtos/client-mutation-input.js';
import { toClientResponse, type ClientResponse } from '../dtos/client-response.js';

export class UpdateClient {
  constructor(private readonly repository: ClientToolbarRepository) {}

  async execute(clientId: number, input: UpdateClientInput): Promise<ClientResponse> {
    if (input.code !== undefined && await this.repository.codeExists(input.code, clientId)) {
      throw new ConflictError('Ya existe un cliente con ese codigo', 'CLIENT_CODE_EXISTS');
    }

    const accountingAccount = input.fiscal?.accountingAccount;
    if (
      accountingAccount !== undefined
      && !(await this.repository.accountingAccountExists(accountingAccount))
    ) {
      throw new ConflictError('La cuenta contable no existe', 'ACCOUNTING_ACCOUNT_NOT_FOUND');
    }

    const client = await this.repository.update(clientId, toWriteValues(input));
    if (client === null) throw new NotFoundError('Cliente');
    return toClientResponse(client);
  }
}
