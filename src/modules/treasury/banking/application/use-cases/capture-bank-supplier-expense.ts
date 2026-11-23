import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { CaptureSupplierPayment } from '../../../../accounts-payable/suppliers/application/use-cases/capture-supplier-payment.js';
import type { BankAccountsDataSource } from '../../domain/datasources/bank-accounts-data-source.js';
import type { BankSupplierExpenseInput, BankSupplierExpenseReceipts } from '../../domain/datasources/bank-supplier-expense-data-source.js';
import { permitsBankPosting } from '../../domain/entities/bank-posting-role.js';

const mexicoDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });

export class CaptureBankSupplierExpense {
  constructor(
    private readonly accounts: Pick<BankAccountsDataSource, 'findById'>,
    private readonly receipts: BankSupplierExpenseReceipts,
    private readonly supplierPayment: Pick<CaptureSupplierPayment, 'save'>,
    private readonly clock = () => new Date(),
  ) {}

  async prepare(companyId: number, bankAccountId: number) {
    const selected = await this.accounts.findById(bankAccountId);
    if (!selected) throw new NotFoundError('Cuenta bancaria');
    const defaults = { date: mexicoDate.format(this.clock()) };
    if (!permitsBankPosting(selected.toPrimitives(), companyId, 'payments')) {
      return { canWrite: false, reason: 'La cuenta bancaria no está habilitada para pagos en pesos.', defaults, receipts: [] };
    }
    if (!this.receipts.writable()) {
      return { canWrite: false, reason: 'El registro de cheques requiere PostgreSQL.', defaults, receipts: [] };
    }
    const receipts = await this.receipts.pending(companyId);
    return {
      canWrite: receipts.length > 0, reason: receipts.length ? null : 'No hay recepciones web con saldo pendiente en pesos.',
      defaults, receipts,
    };
  }

  save(companyId: number, bankAccountId: number, userId: number, input: BankSupplierExpenseInput) {
    const { receiptId, supplierId, ...payment } = input;
    // Usa el mismo pago PP y la misma clave de solicitud de Cuentas por Pagar.
    return this.supplierPayment.save({ companyId, receiptId, supplierId }, userId, {
      ...payment, bankAccountId, mode: 'check',
    });
  }
}
