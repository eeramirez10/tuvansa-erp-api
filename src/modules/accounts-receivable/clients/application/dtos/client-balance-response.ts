import type { ClientBalanceDocument } from '../../domain/entities/client-balance-document.js';

export type ClientBalanceDocumentResponse = ReturnType<ClientBalanceDocument['toPrimitives']>;

export const toClientBalanceDocumentResponse = (
  document: ClientBalanceDocument,
): ClientBalanceDocumentResponse => document.toPrimitives();
