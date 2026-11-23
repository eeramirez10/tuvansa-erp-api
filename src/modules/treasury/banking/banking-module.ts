import type { Router } from 'express';
import { CaptureBankReconciliation } from './application/use-cases/capture-bank-reconciliation.js';
import { GetBankAccount } from './application/use-cases/get-bank-account.js';
import { GetBankAccountByCode } from './application/use-cases/get-bank-account-by-code.js';
import { GetBankPanel } from './application/use-cases/get-bank-panel.js';
import { GetFirstBankAccount } from './application/use-cases/get-first-bank-account.js';
import { NavigateBankAccount } from './application/use-cases/navigate-bank-account.js';
import { SearchBankAccounts } from './application/use-cases/search-bank-accounts.js';
import { BankAccountsWithLocalPostingsDataSource, BankPanelsWithLocalPostingsDataSource } from './infrastructure/datasources/banks-with-local-postings-data-source.js';
import { LegacyMysqlBankAccountsDataSource } from './infrastructure/datasources/legacy-mysql-bank-accounts-data-source.js';
import { PostgresBankReconciliations } from './infrastructure/datasources/postgres-bank-reconciliations.js';
import { BankAccountsRepositoryImpl } from './infrastructure/repositories/bank-accounts-repository-impl.js';
import { BankPanelsRepositoryImpl } from './infrastructure/repositories/bank-panels-repository-impl.js';
import { BankAccountsController } from './presentation/http/bank-accounts-controller.js';
import { createBankAccountsRouter } from './presentation/http/bank-accounts-routes.js';

export const createBankingModule = (): Router => {
  const accountsDataSource = new BankAccountsWithLocalPostingsDataSource();
  const accountsRepository = new BankAccountsRepositoryImpl(accountsDataSource);
  const panelsRepository = new BankPanelsRepositoryImpl(new BankPanelsWithLocalPostingsDataSource(accountsDataSource));
  const controller = new BankAccountsController(
    new GetBankAccount(accountsRepository),
    new GetBankAccountByCode(accountsRepository),
    new GetFirstBankAccount(accountsRepository),
    new SearchBankAccounts(accountsRepository),
    new NavigateBankAccount(accountsRepository),
    new GetBankPanel(panelsRepository),
    new CaptureBankReconciliation(new PostgresBankReconciliations(), new LegacyMysqlBankAccountsDataSource()),
  );
  return createBankAccountsRouter(controller);
};
