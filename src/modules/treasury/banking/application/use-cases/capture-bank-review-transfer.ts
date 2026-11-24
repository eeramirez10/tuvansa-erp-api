import { createHash } from 'node:crypto';
import type { ManualPolicyInput } from '../../../../accounting/policies/domain/datasources/manual-policy-data-source.js';
import type { ManageManualPolicy } from '../../../../accounting/policies/application/use-cases/manage-manual-policy.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { BankAccountsDataSource } from '../../domain/datasources/bank-accounts-data-source.js';
import type { BankPanelsDataSource } from '../../domain/datasources/bank-panels-data-source.js';
import type { BankPanelSettingsDataSource } from '../../domain/datasources/bank-panel-settings-data-source.js';
import type { BankReviewTransferDataSource, BankReviewTransferInput } from '../../domain/datasources/bank-review-transfer-data-source.js';
import type { BankPanelOptions } from '../../domain/repositories/bank-panels-repository.js';
import { bankCanReconcile } from '../../domain/entities/bank-reconciliation.js';
import { bankReviewMarks, type BankReviewDocument, type BankReviewRow } from '../../domain/entities/bank-review.js';

const changed = () => new ConflictError('Cambiaron las partidas marcadas con +. Actualiza Revisar.',
  'BANK_REVIEW_TRANSFER_SELECTION_CHANGED');
const invalid = (message: string) => new ApplicationError(message, 'BANK_REVIEW_TRANSFER_INVALID', 422);

export class CaptureBankReviewTransfer {
  constructor(
    private readonly accounts: Pick<BankAccountsDataSource, 'findById'>,
    private readonly panels: BankPanelsDataSource,
    private readonly settings: BankPanelSettingsDataSource,
    private readonly policy: Pick<ManageManualPolicy, 'preparePosting'>,
    private readonly storage: BankReviewTransferDataSource,
  ) {}

  async save(accountId: number, raw: BankReviewTransferInput, options: BankPanelOptions) {
    const requestKey = raw.requestKey.toLowerCase();
    const movementIds = [...raw.movementIds].sort((left, right) => left - right);
    const { date, destinationBankAccountId, revision } = raw;
    const fingerprint = createHash('sha256')
      .update(JSON.stringify(['bank-review-transfer', accountId, destinationBankAccountId, date, revision, movementIds])).digest('hex');
    const replay = await this.storage.findRequest(requestKey, fingerprint);
    if (replay) return replay;
    if (accountId === destinationBankAccountId) throw invalid('Selecciona una cuenta destino distinta.');

    const key = { accountId, action: 'review' as const, scope: '' };
    const [origin, destination, panel, previous] = await Promise.all([
      this.accounts.findById(accountId), this.accounts.findById(destinationBankAccountId),
      this.panels.getPanel(accountId, 'authorization-review', options),
      this.settings.read<BankReviewDocument | number[]>(key),
    ]);
    if (!origin || !destination || !panel.available) throw new NotFoundError('Cuenta bancaria');
    const sourceAccount = origin.toPrimitives();
    const targetAccount = destination.toPrimitives();
    if (![sourceAccount, targetAccount].every((account) => bankCanReconcile(account, 1))) {
      throw invalid('El traspaso requiere dos cuentas bancarias de México en pesos.');
    }

    const selected = (panel.items as BankReviewRow[]).filter((row) => row.authorized === '+' && row.canSetReviewMark === true)
      .sort((left, right) => left.movementId - right.movementId);
    if (revision !== (previous?.revision ?? 0) || revision !== panel.summary?.revision
        || selected.length !== movementIds.length
        || selected.some((row, index) => row.movementId !== movementIds[index])) throw changed();
    const marks = { ...bankReviewMarks(previous?.values) };
    const references = selected.map((row, index) => {
      const charge = Number(row.charge);
      const credit = Number(row.credit);
      const movementType = String(row.movementType ?? '').trim();
      const costCenter = Number(row.costCenter || 0);
      if (!/^[a-z0-9]{1,6}$/i.test(movementType) || (charge > 0) === (credit > 0)) {
        throw invalid('Una partida marcada requiere un tipo y un cargo o abono válido.');
      }
      const movementId = movementIds[index]!;
      marks[movementId] = '*';
      return { movementId, movementType, costCenter, charge, credit };
    });
    const journal: ManualPolicyInput = {
      requestKey, date, concept: 'TRASPASO CUENTAS', beneficiary: '', family: '',
      lines: references.flatMap(({ charge, credit, costCenter }) => [
        { accountCode: sourceAccount.code, debit: credit, credit: charge, costCenter, reference: '' },
        { accountCode: targetAccount.code, debit: charge, credit, costCenter, reference: '' },
      ]),
    };
    const { lines, verify } = await this.policy.preparePosting(journal);
    if (lines.some((line, index) => line.account.id !== (index % 2 === 0 ? sourceAccount.id : targetAccount.id))) throw changed();
    return this.storage.post({ accountId, revision, journal, fingerprint, verify, marks,
      lines: lines.map((line, index) => {
        const source = references[Math.floor(index / 2)]!;
        return { ...line, bankMovementType: source.movementType, bankSourceMovementId: source.movementId };
      }),
    });
  }
}
