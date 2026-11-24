import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  ManualPolicyActionInput, ManualPolicyDataSource, ManualPolicyDocument, ManualPolicyInput, ManualPolicyLine,
  ManualPolicyOperation, ManualPolicyReferences, ManualPolicySettings,
} from '../../domain/datasources/manual-policy-data-source.js';

const mexicoDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
const missing = 'La configuración de pólizas de diario de TUVANSA no está disponible.';
const invalid = (reason: string) => new ApplicationError(reason, 'MANUAL_POLICY_INVALID', 422);
const blocked = (reason: string) => new ConflictError(reason, 'MANUAL_POLICY_BLOCKED');
const fingerprint = (operation: string, id: number | null, fields: object) => createHash('sha256').update(JSON.stringify([operation, id, fields])).digest('hex');

function dateAllowed(date: string, settings: ManualPolicySettings) {
  return date >= settings.fiscalStart && date <= settings.fiscalEnd && [settings.periodYear, settings.periodYear + 1].includes(Number(date.slice(0, 4)));
}

function blockReason(current: ManualPolicyDocument, settings: ManualPolicySettings | null) {
  if (current.canceled) return 'La póliza ya fue dada de baja.';
  if (current.reconciled) return 'La póliza contiene una partida conciliada en Bancos.';
  if (!settings) return missing;
  if (!dateAllowed(current.date, settings)) return 'La fecha de la póliza queda fuera del periodo activo.';
  return null;
}

export function policyCents(amount: number): number | null {
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= 999999999999 && cents / 100 === amount ? cents : null;
}

export class ManageManualPolicy {
  constructor(private readonly references: ManualPolicyReferences, private readonly dataSource: ManualPolicyDataSource) {}

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
    if (!current) throw new NotFoundError('Póliza de diario capturada en la web');
    const reason = blockReason(current, settings);
    const { revision, canceled, reconciled, applied } = current;
    return { revision, canceled, reconciled, fiscalStart: settings?.fiscalStart ?? null, fiscalEnd: settings?.fiscalEnd ?? null,
      canEdit: !reason && !applied, canApply: !reason && !applied, canUnapply: !reason && applied, canDelete: !reason, reason };
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

  private async verifyReferences(lines: ManualPolicyLine[], settings: ManualPolicySettings) {
    const accounts = await this.references.accounts([...new Set(lines.map(({ account }) => account.code))], settings.levels);
    const centers = new Set(settings.costCenters.map(({ code }) => code));
    for (const line of lines) {
      const current = accounts.get(line.account.code);
      if (!centers.has(line.costCenter) || !current || current.account.id !== line.account.id || current.account.type !== line.account.type
        || current.parents.map(({ id }) => id).join() !== line.parents.map(({ id }) => id).join()) {
        throw blocked(`Cambió la configuración de la cuenta ${line.account.code} o del centro de costo.`);
      }
    }
  }

  async create(raw: ManualPolicyInput) {
    const input = { ...raw, requestKey: raw.requestKey.toLowerCase() };
    const hash = fingerprint('create', null, input);
    const previous = await this.dataSource.findRequest(input.requestKey, hash);
    if (previous) return previous;
    const settings = await this.settings();
    const lines = await this.prepareLines(input, settings);
    return this.dataSource.create(input, lines, hash, () => this.verifyReferences(lines, settings));
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
    return this.dataSource.perform(id, operation, input, hash, async (current) => {
      const reason = blockReason(current, settings);
      if (reason) throw blocked(reason);
      if (operation === 'apply' && current.applied) throw blocked('La póliza ya está aplicada.');
      if (operation === 'unapply' && !current.applied) throw blocked('La póliza ya está desaplicada.');
      if (operation === 'apply') await this.verifyReferences(current.lines, settings);
    });
  }
}
