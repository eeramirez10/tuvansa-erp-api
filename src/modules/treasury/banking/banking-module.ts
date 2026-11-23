import type { Router } from 'express';
import { CaptureSupplierPayment } from '../../accounts-payable/suppliers/application/use-cases/capture-supplier-payment.js';
import { MysqlSupplierPaymentReferences } from '../../accounts-payable/suppliers/infrastructure/datasources/mysql-supplier-payment-references.js';
import { PostgresSupplierPayments } from '../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import { CaptureBankReconciliation } from './application/use-cases/capture-bank-reconciliation.js';
import { CaptureBankSupplierExpense } from './application/use-cases/capture-bank-supplier-expense.js';
import { CaptureBankTransfer } from './application/use-cases/capture-bank-transfer.js';
import { ConfigureBankPanels } from './application/use-cases/configure-bank-panels.js';
import { WriteBankCatalog } from './application/use-cases/write-bank-catalog.js';
import { GetBankAccount } from './application/use-cases/get-bank-account.js';
import { GetBankAccountByCode } from './application/use-cases/get-bank-account-by-code.js';
import { GetBankPanel } from './application/use-cases/get-bank-panel.js';
import { GetFirstBankAccount } from './application/use-cases/get-first-bank-account.js';
import { NavigateBankAccount } from './application/use-cases/navigate-bank-account.js';
import { SearchBankAccounts } from './application/use-cases/search-bank-accounts.js';
import { BankAccountsWithLocalPostingsDataSource } from './infrastructure/datasources/banks-with-local-postings-data-source.js';
import { BankAccountsWithCatalogDataSource } from './infrastructure/datasources/bank-accounts-with-catalog-data-source.js';
import { BankPanelsWithActionsDataSource } from './infrastructure/datasources/bank-panels-with-actions-data-source.js';
import { MysqlBankCatalogReferences } from './infrastructure/datasources/mysql-bank-catalog-references.js';
import { MysqlBankTransferReferences } from './infrastructure/datasources/mysql-bank-transfer-references.js';
import { PostgresBankCatalogDataSource } from './infrastructure/datasources/postgres-bank-catalog-data-source.js';
import { PostgresBankReconciliations } from './infrastructure/datasources/postgres-bank-reconciliations.js';
import { PostgresBankPanelSettings } from './infrastructure/datasources/postgres-bank-panel-settings.js';
import { PostgresBankSupplierExpenseReceipts } from './infrastructure/datasources/postgres-bank-supplier-expense-receipts.js';
import { PostgresBankTransfers } from './infrastructure/datasources/postgres-bank-transfers.js';
import { BankAccountsRepositoryImpl } from './infrastructure/repositories/bank-accounts-repository-impl.js';
import { BankPanelsRepositoryImpl } from './infrastructure/repositories/bank-panels-repository-impl.js';
import { BankAccountsController } from './presentation/http/bank-accounts-controller.js';
import { BankCatalogWritesController } from './presentation/http/bank-catalog-writes-controller.js';
import { BankSupplierExpensesController } from './presentation/http/bank-supplier-expenses-controller.js';
import { createBankAccountsRouter } from './presentation/http/bank-accounts-routes.js';

export const createBankingModule = (): Router => {
  const accountsDataSource = new BankAccountsWithLocalPostingsDataSource();
  const accountCatalog = new BankAccountsWithCatalogDataSource();
  const accountsRepository = new BankAccountsRepositoryImpl(accountsDataSource);
  const settings = new PostgresBankPanelSettings();
  const panels = new BankPanelsWithActionsDataSource(accountsDataSource, settings);
  const panelsRepository = new BankPanelsRepositoryImpl(panels);
  const controller = new BankAccountsController(
    new GetBankAccount(accountsRepository),
    new GetBankAccountByCode(accountsRepository),
    new GetFirstBankAccount(accountsRepository),
    new SearchBankAccounts(accountsRepository),
    new NavigateBankAccount(accountsRepository),
    new GetBankPanel(panelsRepository),
    new CaptureBankReconciliation(new PostgresBankReconciliations(undefined, undefined, accountCatalog), accountCatalog),
    new ConfigureBankPanels(panels, settings),
    new CaptureBankTransfer(
      new PostgresBankTransfers(undefined, undefined, accountCatalog), new MysqlBankTransferReferences(accountCatalog),
    ),
  );
  const catalog = new BankCatalogWritesController(
    new WriteBankCatalog(new MysqlBankCatalogReferences(), new PostgresBankCatalogDataSource()), accountsDataSource,
  );
  const expenses = new BankSupplierExpensesController(new CaptureBankSupplierExpense(
    accountCatalog, new PostgresBankSupplierExpenseReceipts(),
    new CaptureSupplierPayment(
      new PostgresSupplierPayments(undefined, undefined, accountCatalog), new MysqlSupplierPaymentReferences(accountCatalog),
    ),
  ));
  return createBankAccountsRouter(controller, catalog, expenses);
};
