import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import type { ClientToolbarRepository } from '../../domain/repositories/client-toolbar-repository.js';
import {
  toCreateValues,
  type CreateClientInput,
} from '../dtos/client-mutation-input.js';
import { toClientResponse, type ClientResponse } from '../dtos/client-response.js';

const DEFAULT_ACCOUNTING_ACCOUNT = '1105001';

export class CreateClient {
  constructor(private readonly repository: ClientToolbarRepository) {}

  async execute(input: CreateClientInput): Promise<ClientResponse> {
    if (await this.repository.codeExists(input.code)) {
      throw new ConflictError('Ya existe un cliente con ese codigo', 'CLIENT_CODE_EXISTS');
    }

    const accountingAccount = input.fiscal?.accountingAccount ?? DEFAULT_ACCOUNTING_ACCOUNT;
    if (!(await this.repository.accountingAccountExists(accountingAccount))) {
      throw new ConflictError('La cuenta contable no existe', 'ACCOUNTING_ACCOUNT_NOT_FOUND');
    }

    const client = await this.repository.create({
      ...toCreateValues(input),
      accountingAccount,
    });
    return toClientResponse(client);
  }
}
