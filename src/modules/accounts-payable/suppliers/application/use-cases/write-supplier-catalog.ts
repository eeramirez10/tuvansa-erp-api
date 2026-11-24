import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { SupplierCatalogReadSession, SupplierCatalogReferences, SupplierCatalogSettings, SupplierCatalogStorage, SupplierCatalogWriteSession } from '../../domain/datasources/supplier-catalog-data-source.js';
import {
  blankSupplierCatalog, nativeSupplierParameters, newSupplier, presentSupplierCatalog, supplierCatalogFields,
  type SupplierCatalogFields, type SupplierCatalogRecord,
} from '../../domain/entities/supplier-catalog.js';
import type { Supplier, SupplierProps } from '../../domain/entities/supplier.js';

type Overlay = { base: Supplier | null; local: SupplierCatalogRecord | null };

const formatDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const revisionOf = (supplier: SupplierProps, overlay: Overlay, revision = overlay.local?.revision ?? 0) => hash([
  supplier.id, revision, supplierCatalogFields(supplier), overlay.base ? supplierCatalogFields(overlay.base.toPrimitives()) : null,
  overlay.base?.toPrimitives().deactivatedAt ?? null,
]);
const stale = () => new ConflictError('El proveedor cambió en otra sesión. Vuelve a abrir la ficha.', 'SUPPLIER_CATALOG_STALE');
const invalid = (message: string) => new ApplicationError(message, 'SUPPLIER_CATALOG_INVALID', 422);
const duplicate = () => new ConflictError('El código de proveedor ya existe.', 'SUPPLIER_CODE_EXISTS');
const unavailable = 'La configuración de proveedores de TUVANSA no está disponible.';

export class WriteSupplierCatalog {
  constructor(private readonly storage: SupplierCatalogStorage, private readonly references: SupplierCatalogReferences) {}

  private availability(settings: SupplierCatalogSettings | null) {
    const reason = !settings ? unavailable : this.storage.writable() ? null : 'Las escrituras del catálogo requieren PostgreSQL.';
    return { writable: reason === null, reason, accountingAccountRequired: settings?.accountingAccountRequired ?? false };
  }

  async getCreate() {
    const settings = await this.references.settings();
    return { ...this.availability(settings), fields: blankSupplierCatalog(settings?.defaultAccount ?? '') };
  }

  private async settings(): Promise<SupplierCatalogSettings> {
    const settings = await this.references.settings();
    if (!settings) throw new ApplicationError(unavailable, 'SUPPLIER_CATALOG_CONFIG_UNAVAILABLE', 503);
    return settings;
  }

  private async validateAccount(fields: SupplierCatalogFields, settings: SupplierCatalogSettings) {
    if (!settings.accountingEnabled) return;
    const account = fields.fiscal.accountingAccount;
    if (!account && settings.accountingAccountRequired) throw invalid('Captura la cuenta de contabilidad.');
    if (account && !await this.references.leafAccount(account)) throw invalid('La cuenta de contabilidad no existe o tiene subcuentas.');
  }

  private async overlay(id: number, session?: SupplierCatalogReadSession): Promise<Overlay> {
    const local = session ? await session.findById(id) : await this.storage.read(null, (read) => read.findById(id));
    const base = !local || local.legacy ? await this.references.findById(id) : null;
    return { base, local };
  }

  private visible(overlay: Overlay) {
    const record = presentSupplierCatalog(overlay.base, overlay.local);
    if (!record) throw new NotFoundError('Proveedor');
    return record.toPrimitives();
  }

  private async dependency(id: number, supplier: SupplierProps, overlay: Overlay, session?: SupplierCatalogReadSession) {
    const nativeCode = overlay.base?.toPrimitives().code;
    const native = nativeCode === undefined ? null : await this.references.dependency(id, nativeCode);
    if (native) return native;
    return session ? session.dependency(id, supplier.code) : this.storage.read(null, (read) => read.dependency(id, supplier.code));
  }

  async getEdit(id: number) {
    const [overlay, settings] = await Promise.all([this.overlay(id), this.references.settings()]);
    const supplier = this.visible(overlay);
    const reason = await this.dependency(id, supplier, overlay);
    const fields = supplierCatalogFields(supplier);
    if (fields.terms.priceList < 1 || fields.terms.priceList > 5) fields.terms = { ...fields.terms, priceList: 1 };
    return { ...this.availability(settings), fields, revision: revisionOf(supplier, overlay), codeEditable: reason === null, deletionReason: reason };
  }

  async create(requestKey: string, fields: SupplierCatalogFields): Promise<SupplierProps> {
    const fingerprint = hash(fields);
    return this.storage.write(async (session) => {
      const replay = await session.findByRequest(requestKey, fingerprint);
      if (replay) {
        if (replay.deleted) throw new NotFoundError('Proveedor');
        return replay.supplier;
      }
      await this.validateAccount(fields, await this.settings());
      if (await this.references.codeExists(fields.code) || await session.findByCode(fields.code)) throw duplicate();
      const supplier = newSupplier(await session.newId(), fields, formatDate.format());
      await session.save({ ...nativeSupplierParameters, supplier, legacy: false, deleted: false, revision: 1, originalCode: null },
        { key: requestKey, fingerprint });
      return supplier;
    });
  }

  private async nextRecord(supplier: SupplierProps, overlay: Overlay, fields: SupplierCatalogFields, deleted: boolean) {
    const { local, base } = overlay;
    const parameters = base ? await this.references.parameters(supplier.id) : local;
    if (!parameters) throw new NotFoundError('Proveedor');
    const { tolerancePercent, vatCode, withheldVat, withheldIncomeTax, intercompany } = parameters;
    return {
      tolerancePercent, vatCode, withheldVat, withheldIncomeTax, intercompany,
      supplier: { ...supplier, ...fields }, legacy: local?.legacy ?? Boolean(base), deleted,
      revision: (local?.revision ?? 0) + 1, originalCode: local?.originalCode ?? base?.toPrimitives().code ?? null,
    } satisfies SupplierCatalogRecord;
  }

  private async assertRenumber(
    session: SupplierCatalogWriteSession, supplier: SupplierProps, overlay: Overlay, code: string,
  ) {
    if (supplier.code === code) return;
    const dependency = await this.dependency(supplier.id, supplier, overlay, session);
    if (dependency !== null) throw new ConflictError(dependency, 'SUPPLIER_CODE_LINKED');
    const local = await session.findByCode(code);
    if ((local && local.supplier.id !== supplier.id) || await this.references.codeExists(code, supplier.id)) throw duplicate();
  }

  update(id: number, revision: string, fields: SupplierCatalogFields): Promise<SupplierProps> {
    return this.storage.write(async (session) => {
      await session.lockSupplier(id);
      const overlay = await this.overlay(id, session);
      const supplier = this.visible(overlay);
      if (revision !== revisionOf(supplier, overlay)) throw stale();
      await this.validateAccount(fields, await this.settings());
      await this.assertRenumber(session, supplier, overlay, fields.code);
      const record = await this.nextRecord(supplier, overlay, fields, false);
      await session.save(record);
      return record.supplier;
    });
  }

  remove(id: number, revision: string): Promise<void> {
    return this.storage.write(async (session) => {
      await session.lockSupplier(id);
      const overlay = await this.overlay(id, session);
      if (overlay.local?.deleted) {
        const previous = presentSupplierCatalog(overlay.base, { ...overlay.local, deleted: false });
        if (previous && revision === revisionOf(previous.toPrimitives(), overlay, overlay.local.revision - 1)) return;
        throw new NotFoundError('Proveedor');
      }
      const supplier = this.visible(overlay);
      if (revision !== revisionOf(supplier, overlay)) throw stale();
      const reason = await this.dependency(id, supplier, overlay, session);
      if (reason) throw new ConflictError(reason, 'SUPPLIER_CATALOG_LINKED');
      await session.save(await this.nextRecord(supplier, overlay, supplierCatalogFields(supplier), true));
    });
  }
}
