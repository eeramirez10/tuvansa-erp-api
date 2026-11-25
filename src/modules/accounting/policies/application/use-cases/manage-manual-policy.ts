import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  DuplicatePolicyInput, ManualPolicyActionInput, ManualPolicyCommentsInput, ManualPolicyDataSource, ManualPolicyDocument, ManualPolicyInput, ManualPolicyLine,
  ManualPolicyOperation, ManualPolicyReferences, ManualPolicySettings,
} from '../../domain/datasources/manual-policy-data-source.js';
import type { AccountingPolicyCommentLines, AccountingPolicyProps } from '../../domain/entities/accounting-policy.js';
import type { AccountingPoliciesRepository } from '../../domain/repositories/accounting-policies-repository.js';
import type { BankAccountLookup } from '../../../../treasury/banking/domain/entities/bank-account.js';

const mexicoDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
const missing = 'La configuración de pólizas de diario de TUVANSA no está disponible.';
const invalid = (reason: string) => new ApplicationError(reason, 'MANUAL_POLICY_INVALID', 422);
const blocked = (reason: string) => new ConflictError(reason, 'MANUAL_POLICY_BLOCKED');
const fingerprint = (operation: string, id: number | null, fields: object) => createHash('sha256').update(JSON.stringify([operation, id, fields])).digest('hex');

function dateAllowed(date: string, settings: ManualPolicySettings) {
  return date >= settings.fiscalStart && date <= settings.fiscalEnd && [settings.periodYear, settings.periodYear + 1].includes(Number(date.slice(0, 4)));
}

function blockReason(current: Pick<ManualPolicyDocument, 'canceled' | 'reconciled'> & { date: string | null }, settings: ManualPolicySettings | null) {
  if (current.canceled) return 'La póliza ya fue dada de baja.';
  if (current.reconciled) return 'La póliza contiene una partida conciliada en Bancos.';
  if (!settings) return missing;
  if (!current.date || !dateAllowed(current.date, settings)) return 'La fecha de la póliza queda fuera del periodo activo.';
  return null;
}

export function policyCents(amount: number): number | null {
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= 999999999999 && cents / 100 === amount ? cents : null;
}

function duplicateFields(policy: AccountingPolicyProps) {
  const { concept, beneficiary, family, movements } = policy;
  return { concept, beneficiary, family,
    lines: movements.map(({ accountCode, costCenter, debit, credit, reference }) => ({ accountCode, costCenter, debit, credit, reference })),
  };
}

function duplicateRevision(policy: AccountingPolicyProps) {
  return fingerprint('duplicate-source', policy.id, [policy.number, policy.company, policy.date, policy.manual?.revision,
    policy.manual?.canceled, policy.exchangeRate,
    policy.movements.map(({ id, exchangeRate }) => [id, exchangeRate]), duplicateFields(policy)]);
}

type HistoricalPolicySource = { policy: AccountingPolicyProps; ordinary: boolean };

function historicalRevision({ policy, ordinary }: HistoricalPolicySource) {
  const digest = fingerprint('historical-apply', policy.id, [
    duplicateRevision(policy), policy.applied, ordinary, policy.cheque, policy.origin, policy.report, policy.postDate,
    policy.movements.map(({ id, accountId, reconciled }) => [id, accountId, reconciled]),
  ]);
  return Number.parseInt(digest.slice(0, 12), 16) + 1;
}

function duplicateBlocked(policy: AccountingPolicyProps) {
  if (policy.company !== 1 || !policy.number.startsWith('3')) return 'Sólo se pueden duplicar pólizas de diario tipo 3.';
  if (policy.manual?.canceled) return 'La póliza ya fue dada de baja.';
  if (![0, 1].includes(policy.exchangeRate) || policy.movements.some(({ exchangeRate }) => exchangeRate !== 1)) {
    return 'La copia de pólizas de diario requiere partidas en pesos con tipo de cambio 1.';
  }
  if (policy.movements.length < 2 || policy.movements.length > 100) return 'La póliza requiere de dos a cien partidas.';
  if (policy.concept.length > 90 || policy.beneficiary.length > 85 || policy.family.length > 20
    || policy.movements.some(({ accountCode, reference }) => !accountCode || accountCode.length > 16 || reference.length > 45)) {
    return 'La póliza contiene un campo que excede el espacio de captura del diario.';
  }
  return null;
}

export class ManageManualPolicy {
  constructor(private readonly references: ManualPolicyReferences, private readonly dataSource: ManualPolicyDataSource,
    private readonly source?: Pick<AccountingPoliciesRepository, 'findById'>,
    private readonly readHistoricalComments?: (id: number) => Promise<AccountingPolicyCommentLines>,
    private readonly historicalSource?: (id: number) => Promise<HistoricalPolicySource | null>) {}

  async prepare() {
    const settings = await this.references.settings();
    const reason = !settings ? missing : this.dataSource.writable() ? null : 'La captura de pólizas requiere PostgreSQL.';
    let date = mexicoDate.format();
    if (settings) date = date < settings.fiscalStart ? settings.fiscalStart : date > settings.fiscalEnd ? settings.fiscalEnd : date;
    return { canWrite: reason === null, reason, fiscalStart: settings?.fiscalStart ?? null, fiscalEnd: settings?.fiscalEnd ?? null,
      defaults: { date, type: '3' as const }, costCenters: settings?.costCenters ?? [] };
  }

  async accounts(query: string) { return { accounts: await this.references.search(query) }; }

  async preview(id: number) {
    const [current, settings] = await Promise.all([this.dataSource.find(id), this.references.settings()]);
    if (!current) {
      const { policy, revision, applied, reason } = await this.prepareHistorical(id, settings);
      return { revision, canceled: false, reconciled: policy.movements.some(({ reconciled }) => reconciled),
        fiscalStart: settings?.fiscalStart ?? null, fiscalEnd: settings?.fiscalEnd ?? null,
        canEdit: false, canApply: !reason && !applied, canUnapply: false, canDelete: false, reason };
    }
    const reason = blockReason(current, settings);
    const { revision, canceled, reconciled, applied } = current;
    return { revision, canceled, reconciled, fiscalStart: settings?.fiscalStart ?? null, fiscalEnd: settings?.fiscalEnd ?? null,
      canEdit: !reason && !applied, canApply: !reason && !applied, canUnapply: !reason && applied, canDelete: !reason, reason };
  }

  private async prepareHistorical(id: number, settings: ManualPolicySettings | null) {
    const source = await this.historicalSource?.(id);
    if (!source) throw new NotFoundError('Póliza de diario');
    const { policy, ordinary } = source;
    const applied = policy.applied || await this.dataSource.historicalApplied(id);
    const revision = historicalRevision(source);
    let reason: string | null = null;
    if (applied) reason = 'La póliza ya está aplicada.';
    else if (!this.dataSource.writable()) reason = 'La aplicación de pólizas requiere PostgreSQL.';
    else if (!settings || !policy.date || !dateAllowed(policy.date, settings)) reason = 'La fecha de la póliza queda fuera del periodo activo.';
    else if (!ordinary || policy.company !== 1 || !/^3.{10}$/.test(policy.number) || policy.movements.some(({ reconciled }) => reconciled)) {
      reason = 'La aplicación histórica requiere un diario de México sin documentos vinculados y con partidas pendientes.';
    } else if (policy.movements.some(({ exchangeRate }) => exchangeRate !== 1)
      || !policy.movements.some(({ accountType }) => accountType === 0)) {
      reason = 'La aplicación histórica requiere un diario en pesos con una partida bancaria.';
    } else if (policy.movements.length < 2 || policy.movements.length > 100 || policy.concept.length > 90 || policy.beneficiary.length > 85
      || policy.family.length > 20 || policy.movements.some(({ reference }) => reference.length > 45)) {
      reason = 'La póliza requiere de dos a cien partidas y campos válidos para el diario.';
    }
    if (reason || !policy.date || !settings) return { policy, applied, revision, reason, lines: null };
    try {
      const prepared = await this.prepareLines({ ...duplicateFields(policy), date: policy.date, requestKey: '' }, settings);
      if (prepared.some(({ account }, index) => account.id !== policy.movements[index]?.accountId || account.type !== policy.movements[index]?.accountType)) {
        throw blocked('Cambió una cuenta de la póliza histórica.');
      }
      const lines = prepared.map((line, index) => ({ ...line, historicalMovementId: policy.movements[index]!.id }));
      return { policy, applied, revision, reason: null, lines };
    } catch (error) {
      if (!(error instanceof ApplicationError) || error.statusCode >= 500) throw error;
      return { policy, applied, revision, reason: error.message, lines: null };
    }
  }

  private async settings() {
    const settings = await this.references.settings();
    if (!settings) throw invalid(missing);
    return settings;
  }

  private async prepareLines(input: ManualPolicyInput, settings: ManualPolicySettings): Promise<ManualPolicyLine[]> {
    if (!dateAllowed(input.date, settings)) throw invalid('La fecha de la póliza debe pertenecer al periodo contable activo.');
    const centers = new Set(settings.costCenters.map(({ code }) => code));
    const chart = await this.references.accounts([...new Set(input.lines.map(({ accountCode }) => accountCode))], settings.levels);
    let totalDebit = 0;
    let totalCredit = 0;
    const lines = input.lines.map(({ accountCode, costCenter, debit, credit, reference }) => {
      if (!centers.has(costCenter)) throw invalid(`El centro de costo ${costCenter} no está disponible.`);
      const detail = chart.get(accountCode);
      if (!detail) throw invalid(`La cuenta ${accountCode} requiere una cuenta autorizada de detalle en pesos y sus cuentas agrupadoras.`);
      const debitCents = policyCents(debit);
      const creditCents = policyCents(credit);
      if (debitCents === null || creditCents === null || (debitCents > 0) === (creditCents > 0)) {
        throw invalid('Cada partida requiere un cargo o un abono positivo con hasta dos decimales.');
      }
      totalDebit += debitCents;
      totalCredit += creditCents;
      return { ...detail, costCenter, debit, credit, reference };
    });
    if (totalDebit === 0 || totalDebit !== totalCredit) throw invalid('Los cargos y abonos de la póliza deben cuadrar.');
    return lines;
  }

  private async verifyReferences(lines: ManualPolicyLine[], settings: ManualPolicySettings, lookup?: BankAccountLookup) {
    const ids = new Map(lines.flatMap(({ account, parents }) => [account, ...parents].map(({ code, id }) => [code, id] as const)));
    const accounts = await this.references.accounts([...new Set(lines.map(({ account }) => account.code))], settings.levels, lookup && (async (code) => {
      const id = ids.get(code);
      const account = id === undefined ? null : await lookup(id);
      return account?.code === code ? account : null;
    }));
    const centers = new Set(settings.costCenters.map(({ code }) => code));
    for (const line of lines) {
      const current = accounts.get(line.account.code);
      if (!centers.has(line.costCenter) || !current || current.account.id !== line.account.id || current.account.type !== line.account.type
        || current.parents.map(({ id }) => id).join() !== line.parents.map(({ id }) => id).join()) {
        throw blocked(`Cambió la configuración de la cuenta ${line.account.code} o del centro de costo.`);
      }
    }
  }

  async preparePosting(input: ManualPolicyInput) {
    const settings = await this.settings();
    const lines = await this.prepareLines(input, settings);
    return { lines, verify: () => this.verifyReferences(lines, settings) };
  }

  async create(raw: ManualPolicyInput) {
    const input = { ...raw, requestKey: raw.requestKey.toLowerCase() };
    const hash = fingerprint('create', null, input);
    const previous = await this.dataSource.findRequest(input.requestKey, hash);
    if (previous) return previous;
    const { lines, verify } = await this.preparePosting(input);
    return this.dataSource.create(input, lines, hash, verify);
  }

  private async sourcePolicy(id: number) {
    const policy = await this.source?.findById(id);
    if (!policy) throw new NotFoundError('Póliza contable');
    return policy.toPrimitives();
  }

  async prepareDuplicate(id: number) {
    const [policy, settings] = await Promise.all([this.sourcePolicy(id), this.references.settings()]);
    let date = mexicoDate.format();
    if (settings) date = date < settings.fiscalStart ? settings.fiscalStart : date > settings.fiscalEnd ? settings.fiscalEnd : date;
    let reason = duplicateBlocked(policy) ?? (!settings ? missing : this.dataSource.writable() ? null : 'La captura de pólizas requiere PostgreSQL.');
    if (!reason && settings) {
      try { await this.prepareLines({ ...duplicateFields(policy), date, requestKey: '' }, settings); }
      catch (error) { if (!(error instanceof ApplicationError)) throw error; reason = error.message; }
    }
    return { policy: { id, number: policy.number }, date, revision: duplicateRevision(policy), canWrite: !reason, reason,
      fiscalStart: settings?.fiscalStart ?? null, fiscalEnd: settings?.fiscalEnd ?? null };
  }

  async duplicate(id: number, raw: DuplicatePolicyInput) {
    const requestKey = raw.requestKey.toLowerCase();
    const hash = fingerprint('duplicate', id, { ...raw, requestKey });
    const previous = await this.dataSource.findRequest(requestKey, hash);
    if (previous) return previous;
    const policy = await this.sourcePolicy(id);
    const reason = duplicateBlocked(policy);
    if (reason) throw blocked(reason);
    if (duplicateRevision(policy) !== raw.revision) throw blocked('La póliza original cambió. Vuelve a abrir Duplicar.');
    const settings = await this.settings();
    const input = { ...duplicateFields(policy), date: raw.date, requestKey };
    const lines = await this.prepareLines(input, settings);
    const source = policy.manual ? { id, revision: policy.manual.revision } : undefined;
    return this.dataSource.create(input, lines, hash, async () => {
      if (!source && duplicateRevision(await this.sourcePolicy(id)) !== raw.revision) {
        throw blocked('La póliza original cambió. Vuelve a abrir Duplicar.');
      }
      await this.verifyReferences(lines, settings);
    }, source);
  }

  async prepareComments(id: number) {
    const policy = await this.sourcePolicy(id);
    const { number, date, cheque, report, postDate, origin, beneficiary, family, concept, amountInWords,
      userId, auditAt, exchangeRate, manual } = policy;
    let reason: string | null;
    if (policy.applied) reason = 'Desaplica la póliza para cambiar sus comentarios.';
    else if (!manual) reason = 'Los comentarios de esta póliza histórica están disponibles en consulta.';
    else reason = blockReason({ ...manual, date }, await this.references.settings());
    const historical = !policy.applied && !manual ? await this.readHistoricalComments?.(id) : undefined;
    const comments: AccountingPolicyCommentLines = policy.comments ?? historical ?? ['', '', '', '', '', ''];
    return {
      policy: { id, number }, revision: manual?.revision ?? null, canWrite: !reason, reason, applied: policy.applied,
      fields: { date, cheque, report, postDate, origin, beneficiary, family, concept, amountInWords, comments },
      userId, auditAt, exchangeRate,
    };
  }

  async changeComments(id: number, raw: ManualPolicyCommentsInput) {
    const input = { ...raw, requestKey: raw.requestKey.toLowerCase() };
    const hash = fingerprint('comments', id, input);
    const previous = await this.dataSource.findRequest(input.requestKey, hash);
    if (previous) return previous;
    const settings = await this.settings();
    return this.dataSource.changeComments(id, input, hash, (current) => {
      const reason = blockReason(current, settings);
      if (reason) throw blocked(reason);
      if (current.applied) throw blocked('Desaplica la póliza para cambiar sus comentarios.');
      if (input.fields.date.slice(5, 7) !== current.date.slice(5, 7)) throw invalid('El mes de la póliza no puede ser modificado.');
      if (!dateAllowed(input.fields.date, settings)) throw invalid('La fecha de la póliza queda fuera del periodo activo.');
    });
  }

  async change(id: number, raw: ManualPolicyInput & { revision: number }) {
    const input = { ...raw, requestKey: raw.requestKey.toLowerCase() };
    const hash = fingerprint('change', id, input);
    const previous = await this.dataSource.findRequest(input.requestKey, hash);
    if (previous) return previous;
    const settings = await this.settings();
    const lines = await this.prepareLines(input, settings);
    return this.dataSource.change(id, input, lines, hash, async (current) => {
      const reason = blockReason(current, settings);
      if (reason) throw blocked(reason);
      if (current.applied) throw blocked('Desaplica la póliza antes de cambiarla.');
      await this.verifyReferences(lines, settings);
    });
  }

  async perform(id: number, operation: ManualPolicyOperation, raw: ManualPolicyActionInput) {
    const input = { ...raw, requestKey: raw.requestKey.toLowerCase() };
    const hash = fingerprint(operation, id, input);
    const previous = await this.dataSource.findRequest(input.requestKey, hash);
    if (previous) return previous;
    const settings = await this.settings();
    if (operation === 'apply' && this.historicalSource && id <= 4_294_967_295) {
      const { policy, reason, revision, lines } = await this.prepareHistorical(id, settings);
      if (reason || !lines || !policy.date) throw blocked(reason ?? 'La póliza histórica no está disponible.');
      if (input.revision !== revision) throw blocked('La póliza cambió. Vuelve a abrirla.');
      const date = policy.date;
      return this.dataSource.applyHistorical({ ...policy, date }, input.requestKey, lines, hash, async (lookup) => {
        const latest = await this.historicalSource?.(id);
        if (!latest || historicalRevision(latest) !== revision) throw blocked('La póliza cambió. Vuelve a abrirla.');
        const currentSettings = await this.settings();
        if (!dateAllowed(date, currentSettings)) throw blocked('La fecha de la póliza queda fuera del periodo activo.');
        await this.verifyReferences(lines, currentSettings, lookup);
      });
    }
    return this.dataSource.perform(id, operation, input, hash, async (current) => {
      const reason = blockReason(current, settings);
      if (reason) throw blocked(reason);
      if (operation === 'apply' && current.applied) throw blocked('La póliza ya está aplicada.');
      if (operation === 'unapply' && !current.applied) throw blocked('La póliza ya está desaplicada.');
      if (operation === 'apply') await this.verifyReferences(current.lines, settings);
    });
  }
}
