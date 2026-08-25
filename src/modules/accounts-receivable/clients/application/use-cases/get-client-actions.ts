import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  ClientActionResult,
  ClientActionsRepository,
} from '../../domain/repositories/client-actions-repository.js';

export interface GetClientActionInput {
  clientId: number;
  page: number;
  pageSize: number;
}

type ActionOutput<T extends object> = {
  data: ClientActionResult<T>['payload'] & {
    client: ClientActionResult<T>['client'];
  };
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
  };
};

export class GetClientActions {
  constructor(private readonly repository: ClientActionsRepository) {}

  private output<T extends object>(
    result: ClientActionResult<T> | null,
    pagination?: Pick<GetClientActionInput, 'page' | 'pageSize'>,
  ): ActionOutput<T> {
    if (result === null) throw new NotFoundError('Cliente');

    return {
      data: { client: result.client, ...result.payload },
      ...(pagination === undefined ? {} : {
        pagination: {
          page: pagination.page,
          pageSize: pagination.pageSize,
          total: result.total ?? 0,
        },
      }),
    };
  }

  classifications = async (clientId: number) =>
    this.output(await this.repository.findClassifications(clientId));

  destinations = async (clientId: number) =>
    this.output(await this.repository.findDestinations(clientId));

  blockStatus = async (clientId: number) =>
    this.output(await this.repository.findBlockStatus(clientId));

  photo = async (clientId: number) =>
    this.output(await this.repository.findPhoto(clientId));

  discounts = async (input: GetClientActionInput) => this.output(
    await this.repository.findDiscounts({
      clientId: input.clientId,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    }),
    input,
  );

  events = async (input: GetClientActionInput) => this.output(
    await this.repository.findEvents({
      clientId: input.clientId,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    }),
    input,
  );

  branches = async (input: GetClientActionInput) => this.output(
    await this.repository.findBranches({
      clientId: input.clientId,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    }),
    input,
  );

  contacts = async (input: GetClientActionInput) => this.output(
    await this.repository.findContacts({
      clientId: input.clientId,
      limit: input.pageSize,
      offset: (input.page - 1) * input.pageSize,
    }),
    input,
  );
}
