import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  BankCatalogReadSession, BankCatalogReferences, BankCatalogRules, BankCatalogStorage,
} from '../../domain/datasources/bank-catalog-data-source.js';
import type { BankAccount } from '../../domain/entities/bank-account.js';
import {
  bankCatalogCurrencies, bankCatalogDefaults, bankCatalogEditableFields, bankCatalogFields, bankCatalogNatures,
  bankCatalogSystemTypes, projectBankCatalog, type BankCatalogFields, type BankCatalogInput,
} from '../../domain/entities/bank-catalog.js';

const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', dateStyle: 'short' });
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = (message: string) => new ApplicationError(message, 'INVALID_BANK_CATALOG', 422);
const readOnlyControls = ['subAccounts', 'movements'] as const;
const occupied = 'La cuenta tiene subcuentas, movimientos o saldos y no puede darse de baja.';

function normalize<T extends BankCatalogInput>(fields: T): T {
  return { ...fields, control: { ...fields.control, customerNumber: fields.control.customerNumber.replace(/^0+(?=\d)/, '') || '0' } };
}

function checkFields(fields: BankCatalogFields) {
  if (!bankCatalogCurrencies.some(({ id }) => id === fields.currencyId)
    || !bankCatalogNatures.some(({ id }) => id === fields.nature)
    || !bankCatalogSystemTypes.some(({ id }) => id === fields.systemType)) {
    throw invalid('Selecciona una moneda, naturaleza y tipo disponibles.');
  }
  if (fields.control.manager.toUpperCase() === 'T') throw invalid('La clave de gerente T está reservada para el catálogo heredado.');
}

export class WriteBankCatalog {
  constructor(
    private readonly references: BankCatalogReferences,
    private readonly storage: BankCatalogStorage,
    private readonly clock = () => new Date(),
  ) {}

  private disabled(rules: BankCatalogRules): string | null {
    if (!this.storage.writable()) return 'El catálogo de bancos requiere PostgreSQL para guardar.';
    if (!rules.accounting || rules.codeLengths.length === 0) return 'El plan contable de esta empresa no está disponible para captura.';
    return null;
  }

  private options(rules: BankCatalogRules) {
    return {
      codeLengths: rules.codeLengths, currencies: bankCatalogCurrencies,
      natures: bankCatalogNatures, systemTypes: bankCatalogSystemTypes,
    };
  }

  private async effective(id: number, catalog?: BankCatalogReadSession) {
    const snapshot = catalog ? await catalog.findById(id) : null;
    const legacy = snapshot && !snapshot.legacy ? null : await this.references.findById(id);
    const code = snapshot?.fields.code ?? legacy?.toPrimitives().code;
    if (!code) throw new NotFoundError('Cuenta bancaria');
    const children = catalog ? await catalog.hasChildren(code) : false;
    const account = projectBankCatalog(legacy, snapshot, children);
    if (!account) throw new NotFoundError('Cuenta bancaria');
    const fields = bankCatalogFields(account);
    fields.control.movements ||= Boolean(catalog && await catalog.hasPostings(id, code));
    return {
      account, fields, legacy, snapshotRevision: snapshot?.revision ?? 0,
      createdOn: snapshot?.createdOn ?? account.toPrimitives().createdAt ?? localDate.format(this.clock()),
    };
  }

  private assertWritable(rules: BankCatalogRules) {
    const reason = this.disabled(rules);
    if (reason) throw new ApplicationError(reason, 'BANK_CATALOG_WRITE_UNAVAILABLE', 409);
  }

  private async disabledRemoval(account: BankAccount, legacy: boolean, hasPostings: boolean): Promise<string | null> {
    const { id, code, balances, currencyBalances, control } = account.toPrimitives();
    if (control.subAccounts || control.movements || hasPostings
      || [...Object.values(balances), ...Object.values(currencyBalances)].some((balance) => balance !== 0)) return occupied;
    if (!legacy) return null;
    const protections = await Promise.all([
      this.references.hasChildren(code), this.references.hasBalances(id), this.references.hasMovements(id),
    ]);
    return protections.some(Boolean) ? occupied : null;
  }

  async getCreate() {
    const rules = await this.references.rules();
    const reason = this.disabled(rules);
    return {
      fields: bankCatalogDefaults(), options: this.options(rules), canWrite: !reason, reason,
      revision: null, editableFields: ['code', ...bankCatalogEditableFields],
    };
  }

  async getEdit(id: number) {
    const [rules, state] = await Promise.all([
      this.references.rules(), this.storage.read(null, (catalog) => this.effective(id, catalog)),
    ]);
    const current = state ?? await this.effective(id);
    const reason = this.disabled(rules);
    const deleteReason = reason ?? await this.disabledRemoval(current.account, current.legacy !== null, current.fields.control.movements);
    return {
      fields: current.fields, options: this.options(rules), canWrite: !reason, reason,
      revision: digest({ revision: current.snapshotRevision, fields: current.fields, rules }),
      editableFields: bankCatalogEditableFields,
      canDelete: !deleteReason, deleteReason,
    };
  }

  async create(requestKey: string, input: BankCatalogInput) {
    const defaults = bankCatalogDefaults();
    const normalized = normalize({ ...input, currencyId: input.currencyId || 1 });
    const fields = { ...normalized, fiscalReports: normalized.fiscalReports ?? defaults.fiscalReports };
    const fingerprint = digest(normalized);
    return this.storage.write(async (catalog) => {
      const saved = await catalog.findByRequest(requestKey, fingerprint);
      if (saved?.archived) throw new ConflictError('La cuenta de esta solicitud ya se dio de baja.', 'BANK_CATALOG_ARCHIVED');
      if (saved) return projectBankCatalog(null, saved, await catalog.hasChildren(saved.fields.code))!;

      const rules = await this.references.rules();
      this.assertWritable(rules);
      checkFields(fields);
      if (readOnlyControls.some((key) => fields.control[key] !== defaults.control[key])) {
        throw invalid('Las marcas de movimientos y subcuentas se determinan en el sistema.');
      }
      const level = rules.codeLengths.indexOf(fields.code.length);
      if (level < 0 || !/^\d+$/.test(fields.code)) {
        throw invalid(`La cuenta debe ser de ${rules.codeLengths.join(', ')} dígitos.`);
      }
      if (await catalog.findByCode(fields.code) || await this.references.codeExists(fields.code)) {
        throw new ConflictError('La cuenta ya existe.', 'BANK_CATALOG_CODE_EXISTS');
      }
      const parentLength = rules.codeLengths[level - 1];
      const parentCode = parentLength === undefined ? null : fields.code.slice(0, parentLength);
      if (parentCode) {
        const localParent = await catalog.findByCode(parentCode);
        if (localParent?.archived) throw invalid('No existe el nivel anterior.');
        const parent = localParent && !localParent.legacy
          ? { id: localParent.id, movements: localParent.fields.control.movements }
          : await this.references.parent(parentCode);
        if (!parent) throw invalid('No existe el nivel anterior.');
        await catalog.lockAccount(parent.id);
        if (parent.movements || await catalog.hasPostings(parent.id, parentCode)) throw invalid('El nivel anterior tiene movimientos.');
      }
      const snapshot = await catalog.create({ fields, parentCode, requestKey, fingerprint, createdOn: localDate.format(this.clock()) });
      return projectBankCatalog(null, snapshot, false)!;
    });
  }

  async update(id: number, revision: string, input: BankCatalogInput) {
    return this.storage.write(async (catalog) => {
      await catalog.lockAccount(id);
      const [rules, current] = await Promise.all([this.references.rules(), this.effective(id, catalog)]);
      this.assertWritable(rules);
      if (revision !== digest({ revision: current.snapshotRevision, fields: current.fields, rules })) {
        throw new ConflictError('La cuenta cambió. Vuelve a abrir Cambio.', 'BANK_CATALOG_CHANGED');
      }
      const fields = normalize({ ...input, fiscalReports: input.fiscalReports ?? current.fields.fiscalReports });
      checkFields(fields);
      if (fields.code !== current.fields.code) throw invalid('El código contable queda fijo en Cambio.');
      if (readOnlyControls.some((key) => fields.control[key] !== current.fields.control[key])) {
        throw invalid('Las marcas de movimientos y subcuentas se determinan en el sistema.');
      }
      const snapshot = await catalog.update({
        id, legacy: current.legacy !== null, fields, revision: current.snapshotRevision, createdOn: current.createdOn,
      });
      return projectBankCatalog(current.legacy, snapshot, await catalog.hasChildren(fields.code))!;
    });
  }

  async remove(id: number, revision: string): Promise<void> {
    await this.storage.write(async (catalog) => {
      await catalog.lockAccount(id);
      if ((await catalog.findById(id))?.archived) return;
      const [rules, current] = await Promise.all([this.references.rules(), this.effective(id, catalog)]);
      this.assertWritable(rules);
      if (revision !== digest({ revision: current.snapshotRevision, fields: current.fields, rules })) {
        throw new ConflictError('La cuenta cambió. Vuelve a abrirla para darla de baja.', 'BANK_CATALOG_CHANGED');
      }
      const blocked = await this.disabledRemoval(current.account, current.legacy !== null, current.fields.control.movements);
      if (blocked) throw new ConflictError(blocked, 'BANK_CATALOG_ACCOUNT_IN_USE');
      await catalog.archive({
        id, legacy: current.legacy !== null, fields: current.fields, revision: current.snapshotRevision, createdOn: current.createdOn,
      });
    });
  }
}
