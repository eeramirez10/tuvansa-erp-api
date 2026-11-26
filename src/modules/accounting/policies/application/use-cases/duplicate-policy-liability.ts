import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { ManualPolicyInput } from '../../domain/datasources/manual-policy-data-source.js';
import type {
  PolicyLiabilityDraft, PolicyLiabilityStorage, PolicyLiabilitySupplier,
} from '../../domain/datasources/policy-liability-data-source.js';
import type { AccountingPolicyProps } from '../../domain/entities/accounting-policy.js';
import type { AccountingPoliciesRepository } from '../../domain/repositories/accounting-policies-repository.js';
import { policyCents, type ManageManualPolicy } from './manage-manual-policy.js';

const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message: string) => new ApplicationError(message, 'POLICY_LIABILITY_INVALID', 422);
const stale = () => new ConflictError('Cambió la póliza o el proveedor. Vuelve a revisar la vista previa.', 'POLICY_LIABILITY_REVISION_CHANGED');
const draftFields = ({ date, amount, supplierCode, reference }: PolicyLiabilityDraft) => [date, amount, supplierCode, reference];

function roundRatio(cents: number, amountCents: number, baseCents: number) {
  const denominator = BigInt(baseCents) * 2n;
  return Number((BigInt(cents) * BigInt(amountCents) * 2n + BigInt(baseCents)) / denominator);
}

function sourceReason(source: AccountingPolicyProps) {
  if (source.company !== 1 || !source.family.startsWith('PASIVO') || source.manual?.canceled
    || !/^3.{10}$/.test(source.number) || !source.date || source.movements.length < 2 || source.movements.length > 100
    || source.movements.some(line => line.reconciled || line.exchangeRate !== 1)) {
    return 'Selecciona una póliza de diario PASIVO vigente de México con partidas disponibles.';
  }
  if (source.totals.difference !== 0) return 'La póliza original debe estar cuadrada.';
  return null;
}

function calculate(source: AccountingPolicyProps, draft: PolicyLiabilityDraft, supplier: PolicyLiabilitySupplier) {
  const amount = policyCents(draft.amount);
  const last = source.movements.at(-1);
  const denominator = last ? policyCents(last.credit) : null;
  if (!amount || !denominator || last?.accountCode !== supplier.accountCode) {
    throw invalid('El último abono de la póliza debe corresponder a la cuenta del proveedor.');
  }
  const lines = source.movements.map(line => {
    const debit = policyCents(line.debit);
    const credit = policyCents(line.credit);
    if (debit === null || credit === null || (debit > 0) === (credit > 0)) {
      throw invalid('La póliza original contiene una partida de cargo o abono inválida.');
    }
    const scaledDebit = roundRatio(debit, amount, denominator);
    const scaledCredit = roundRatio(credit, amount, denominator);
    if (!Number.isSafeInteger(scaledDebit) || !Number.isSafeInteger(scaledCredit)) {
      throw invalid('Una partida redondeada supera el importe admitido.');
    }
    return {
      accountCode: line.accountCode, name: line.accountName, costCenter: line.costCenter, reference: line.reference,
      debit, credit, scaledDebit, scaledCredit,
    };
  });
  const totalDebit = lines.reduce((sum, line) => sum + line.debit, 0);
  if (!totalDebit) throw invalid('La póliza original debe tener cargos.');
  const originalTax = lines.reduce((sum, line) => sum + (line.name.toUpperCase().includes('IVA') ? line.debit : 0), 0);
  const tax = roundRatio(originalTax, amount, totalDebit);
  const debit = lines.reduce((sum, line) => sum + line.scaledDebit, 0);
  const credit = lines.reduce((sum, line) => sum + line.scaledCredit, 0);
  const due = new Date(`${draft.date}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + supplier.terms);
  return {
    lines: lines.filter(line => line.scaledDebit || line.scaledCredit)
      .map(line => ({ accountCode: line.accountCode, name: line.name, costCenter: line.costCenter, reference: line.reference,
        debit: line.scaledDebit / 100, credit: line.scaledCredit / 100 })),
    totals: { debit: debit / 100, credit: credit / 100 },
    payable: { supplier, amount: amount / 100, tax: tax / 100, subtotal: (amount - tax) / 100, dueDate: due.toISOString().slice(0, 10) },
    reason: debit === credit && credit === amount ? null : 'Los cargos y abonos redondeados deben cuadrar con el importe del pasivo.',
  };
}

function sourceRevision(policy: AccountingPolicyProps) {
  const { id, number, company, date, concept, beneficiary, family, totals, movements } = policy;
  return { id, number, company, date, concept, beneficiary, family, totals, movements, revision: policy.manual?.revision };
}

export class DuplicatePolicyLiability {
  constructor(
    private readonly sources: Pick<AccountingPoliciesRepository, 'findById'>,
    private readonly lookupSupplier: (code: string) => Promise<PolicyLiabilitySupplier | null>,
    private readonly journal: Pick<ManageManualPolicy, 'prepare' | 'preparePosting'>,
    private readonly storage: PolicyLiabilityStorage,
    private readonly readHistorical = (id: number) => this.sources.findById(id),
  ) {}

  private async source(id: number) {
    const policy = await this.sources.findById(id);
    if (!policy) throw new NotFoundError('Póliza contable');
    return policy.toPrimitives();
  }

  async prepare(id: number) {
    const [policy, journal] = await Promise.all([this.source(id), this.journal.prepare()]);
    const reason = sourceReason(policy) ?? journal.reason;
    return { date: journal.defaults.date, fiscalStart: journal.fiscalStart, fiscalEnd: journal.fiscalEnd, reason };
  }

  private async review(id: number, draft: PolicyLiabilityDraft) {
    const [policy, supplier] = await Promise.all([this.source(id), this.lookupSupplier(draft.supplierCode)]);
    const blocked = sourceReason(policy);
    if (blocked) throw invalid(blocked);
    if (!supplier) throw invalid('El proveedor requiere una cuenta vigente, moneda y tipo de cambio configurados.');
    const calculation = calculate(policy, draft, supplier);
    const input = {
      date: draft.date, concept: policy.concept, beneficiary: policy.beneficiary, family: policy.family,
      lines: calculation.lines.map(({ accountCode, reference, costCenter, debit, credit }) =>
        ({ accountCode, reference, costCenter, debit, credit })),
    } satisfies Omit<ManualPolicyInput, 'requestKey'>;
    const posting = !calculation.reason && this.storage.writable()
      ? await this.journal.preparePosting({ ...input, requestKey: '' }) : null;
    const snapshot = sourceRevision(policy);
    const revision = fingerprint([snapshot, draftFields(draft), supplier, calculation, posting?.lines ?? []]);
    return { calculation, input, posting, revision, snapshot, source: policy.manual ? { id, revision: policy.manual.revision } : undefined };
  }

  async preview(id: number, draft: PolicyLiabilityDraft) {
    const { calculation, posting, revision } = await this.review(id, draft);
    return { ...calculation, revision, canConfirm: Boolean(posting),
      reason: calculation.reason ?? (posting ? null : 'La captura del pasivo requiere PostgreSQL.') };
  }

  async confirm(id: number, draft: PolicyLiabilityDraft, revision: string, requestKey: string, actor: { id: string; legacyId: number }) {
    const hash = fingerprint(['duplicate-liability', id, draftFields(draft), revision, actor.id]);
    const previous = await this.storage.findRequest(requestKey, hash);
    if (previous) return previous;
    const current = await this.review(id, draft);
    if (current.revision !== revision) throw stale();
    if (!current.posting) throw invalid(current.calculation.reason ?? 'La captura del pasivo requiere PostgreSQL.');
    const { lines, verify } = current.posting;
    const { payable } = current.calculation;
    return this.storage.createLiability({ ...current.input, requestKey }, lines, hash, async lookup => {
      const supplier = await this.lookupSupplier(draft.supplierCode);
      if (fingerprint(supplier) !== fingerprint(payable.supplier)) throw stale();
      if (!current.source) {
        const historical = (await this.readHistorical(id))?.toPrimitives();
        if (!historical || fingerprint(sourceRevision(historical)) !== fingerprint(current.snapshot)) throw stale();
      }
      await verify(lookup);
    }, current.source, { ...payable, sourceId: id, userId: actor.legacyId, reference: draft.reference });
  }
}
