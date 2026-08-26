import type { ClientToolbarRepository } from '../repositories/client-toolbar-repository.js';
import type { ClientsRepository } from '../repositories/clients-repository.js';

export type ClientsDataSource = ClientsRepository & ClientToolbarRepository;
