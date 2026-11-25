import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { assertActiveSupplierCatalog, searchSupplierCatalogRecords, supplierCatalogRecordsById } from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-catalog-data-source.js';
import { supplierPaymentsAvailable } from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-payments.js';
import type {
  PurchaseReceptionSupplierChangeDataSource, ReceiptSupplier, ReceiptSupplierChangePreview,
  ReceiptSupplierChangeSource, ReceiptSupplierReplacement, ReceiptSupplierSearch,
} from '../../domain/datasources/purchase-reception-supplier-change-data-source.js';
import type { PurchaseReceptionProps } from '../../domain/entities/purchase-reception.js';
import type { PurchaseReceptionPosting } from '../../domain/datasources/purchase-reception-write-data-source.js';
import { historicalReceptionCancellationsOn } from './historical-purchase-reception-cancellation-reads.js';
import { MysqlPurchaseReceptionSupplierChangeSource } from './mysql-purchase-reception-supplier-change-source.js';
import { paymentDocumentIdSql } from './postgres-purchase-payables.js';
import { isLocalPurchaseExpenseDocumentId } from './postgres-purchase-expenses.js';
import { ensurePurchaseReceptionSchema, isLocalPurchaseReceptionId } from './postgres-purchase-reception-writes.js';
import { purchaseReceptionDocumentationsOn } from './purchase-reception-documentation-reads.js';
import { lockPurchaseReceptionPieces } from './purchase-reception-piece-reads.js';
import { groupedSupplierBalanceReason, hasSupplierBalanceGrouping } from '../../../../../shared/infrastructure/datasources/supplier-balance-grouping-reads.js';
import {
  ensureReceiptSupplierChangesSchema, matchesReceiptSupplierChange, receiptSupplierChangesOn,
} from './purchase-reception-supplier-change-reads.js';
import { purchaseReceptionCancellationsAvailable } from './purchase-posting-reversal-tables.js';

const disabled = 'Cambia Prv no está habilitado para la compañía.';
const unavailable = () => new ApplicationError('No fue posible consultar o cambiar el proveedor en PostgreSQL.', 'PURCHASE_RECEPTION_SUPPLIER_POSTGRES_UNAVAILABLE', 503);
const conflict = (reason: string) => new ConflictError(reason, 'PURCHASE_RECEPTION_SUPPLIER_CHANGE_BLOCKED');
const cents = (value: number) => Math.round(value * 100);
const ordinaryReception = 'El cambio requiere una recepción ordinaria vigente en pesos.';

interface StoredReceipt {
  receipt: Pick<PurchaseReceptionProps, 'id' | 'number' | 'supplier' | 'cancelled' | 'dates' | 'totals'>;
  payable: PurchaseReceptionPosting['payable'];
  accounting: PurchaseReceptionPosting['accounting'];
  type: string;
  cancelled: boolean;
}

async function localReceipt(client: PostgresClient, companyId: number, receiptId: number, lock: boolean): Promise<ReceiptSupplierChangeSource | null> {
  const { rows: [table] } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('tuvansa.purchase_receptions') IS NOT NULL AS present",
  );
  if (!table?.present) return null;
  const cancellation = await purchaseReceptionCancellationsAvailable(client);
  const { rows: [source] } = await client.query<StoredReceipt>(
    `SELECT r.result->'reception' AS receipt,r.payable,r.accounting,r.movement#>>'{header,type}' AS type,
       ${cancellation ? 'EXISTS(SELECT 1 FROM tuvansa.purchase_reception_cancellations c WHERE c.company_id=r.company_id AND c.receipt_id=r.id)' : 'false'} AS cancelled
     FROM tuvansa.purchase_receptions r WHERE r.company_id=$1 AND r.id=$2 ${lock ? 'FOR UPDATE OF r' : ''}`,
    [companyId, receiptId],
  );
  if (!source) return null;
  const { receipt, payable, accounting } = source;
  const amount = payable?.amount ?? 0;
  const liability = accounting?.lines.filter(({ debit, credit }) => debit === 0 && cents(credit) === cents(amount)) ?? [];
  const supplierAccount = liability.length === 1 ? liability[0]!.account.trim() : '';
  let reason: string | null = null;
  if (receipt.cancelled || source.cancelled) reason = 'La recepción está cancelada.';
  else if (!/^RW\d/.test(receipt.number) || source.type !== 'RA' || payable?.currencyId !== 1 || payable.exchangeRate !== 1) {
    reason = ordinaryReception;
  } else if (amount <= 0 || cents(amount) !== cents(receipt.totals.total) || cents(amount) !== cents(receipt.totals.balance)) {
    reason = 'La recepción requiere un saldo original íntegro.';
  } else if (!supplierAccount) {
    reason = 'No se pudo verificar la cuenta del pasivo en la póliza original.';
  }
  return {
    reception: { id: receipt.id, number: receipt.number }, originalSupplier: receipt.supplier, amount, supplierAccount,
    historicalCharge: null, reason, version: JSON.stringify(source),
  };
}

async function localExpense(client: PostgresClient, companyId: number, receiptId: number): Promise<ReceiptSupplierChangeSource | null> {
  const { rows: [table] } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('tuvansa.purchase_expense_documents') IS NOT NULL AS present",
  );
  if (!table?.present) return null;
  const { rows: [row] } = await client.query<{ number: string; originalSupplier: ReceiptSupplier; amount: number }>(
    `SELECT number,jsonb_build_object('id',supplier_id,'code',supplier_code,'name',supplier_name) AS "originalSupplier",
       amount::float8 FROM tuvansa.purchase_expense_documents WHERE id=$1 AND company_id=$2`, [receiptId, companyId],
  );
  return row ? {
    reception: { id: receiptId, number: row.number }, originalSupplier: row.originalSupplier,
    supplierAccount: '', amount: row.amount, historicalCharge: null, reason: ordinaryReception, version: JSON.stringify(row),
  } : null;
}

async function hasPayments(client: PostgresClient, companyId: number, receiptId: number) {
  if (!await supplierPaymentsAvailable(client)) return false;
  const { rows } = await client.query(
    `SELECT 1 FROM tuvansa.supplier_payments p WHERE p.company_id=$1 AND ${paymentDocumentIdSql('p')}=$2 LIMIT 1`,
    [companyId, receiptId],
  );
  return rows.length > 0;
}

export class PostgresPurchaseReceptionSupplierChanges implements PurchaseReceptionSupplierChangeDataSource {
  private migration?: Promise<void>;

  constructor(
    private readonly native: Pick<MysqlPurchaseReceptionSupplierChangeSource, 'enabled' | 'receipt' | 'suppliers'> =
      new MysqlPurchaseReceptionSupplierChangeSource(),
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured = postgresConfigured,
  ) {}

  private async using<T>(work: (client: PostgresClient) => Promise<T>) {
    let client: PostgresClient | undefined;
    try {
      client = await this.connect();
      return await work(client);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw unavailable();
    } finally { client?.release(); }
  }

  private async context(companyId: number, receiptId: number, client?: PostgresClient, lock = false) {
    if (companyId !== 1) return null;
    const expense = isLocalPurchaseExpenseDocumentId(receiptId);
    const historical = !expense && !isLocalPurchaseReceptionId(receiptId);
    const source = historical ? await this.native.receipt(receiptId) : !client ? null : expense
      ? await localExpense(client, companyId, receiptId) : await localReceipt(client, companyId, receiptId, lock);
    if (!source) return null;
    const enabled = await this.native.enabled();
    const saved = client ? await receiptSupplierChangesOn(client, { receiptIds: [receiptId] }) : [];
    const documentations = client ? await purchaseReceptionDocumentationsOn(client, { sourceIds: [receiptId] }) : [];
    const cancellations = client && historical ? await historicalReceptionCancellationsOn(client, { receiptIds: [receiptId] }) : [];
    const payments = client ? await hasPayments(client, companyId, receiptId) : false;
    const grouped = client && historical ? await hasSupplierBalanceGrouping(client, receiptId) : false;
    const identity = { ...source.reception, supplier: source.originalSupplier };
    const current = matchesReceiptSupplierChange(saved[0], identity) ? saved[0] : undefined;
    const changedSource = saved[0] && (!current || current.amount !== source.amount || current.supplierAccount !== source.supplierAccount
      || current.charge?.id !== source.historicalCharge?.id);
    const reason = !enabled ? disabled : !client ? unavailable().message : cancellations.length ? 'La recepción está cancelada.'
      : documentations.length ? 'La recepción ya está documentada.'
      : payments ? 'La recepción tiene pagos registrados.'
      : grouped ? groupedSupplierBalanceReason
      : source.reason ?? (changedSource ? 'El registro original de Omnis cambió después del cambio de proveedor.' : null);
    const supplier = current?.supplier ?? source.originalSupplier;
    const preview: ReceiptSupplierChangePreview = {
      reception: source.reception, supplier, canWrite: !reason, reason,
      revision: createHash('sha256').update(JSON.stringify([source.version, source.reason, reason, current?.revision ?? 0])).digest('hex'),
    };
    return { source, historical, current, preview };
  }

  async preview(companyId: number, receiptId: number) {
    const context = this.configured()
      ? await this.using((client) => this.context(companyId, receiptId, client)) : await this.context(companyId, receiptId);
    return context?.preview ?? null;
  }

  private async choices(filters: ReceiptSupplierSearch, exact = false, client?: PostgresClient) {
    const text = filters.code || filters.name?.replace(/^\*/, '') || '';
    if (!text) return [];
    const base = await this.native.suppliers(filters, exact);
    const updated = await supplierCatalogRecordsById(base.map(({ id }) => id), client);
    const additional = await searchSupplierCatalogRecords(text, exact, client);
    const byId = new Map(base.map((supplier) => [supplier.id, supplier]));
    const code = filters.code?.toUpperCase();
    const name = filters.name?.toUpperCase();
    for (const { supplier, deleted, intercompany, withheldVat, withheldIncomeTax } of [...updated.values(), ...additional]) {
      byId.delete(supplier.id);
      if (deleted || (code && (exact ? supplier.code.toUpperCase() !== code : !supplier.code.toUpperCase().startsWith(code)))
        || (name && (name.startsWith('*') ? !supplier.name.toUpperCase().includes(name.slice(1)) : !supplier.name.toUpperCase().startsWith(name)))) continue;
      byId.set(supplier.id, {
        id: supplier.id, code: supplier.code, name: supplier.name,
        account: supplier.fiscal.accountingAccount.trim(),
        eligible: supplier.isActive && supplier.terms.currencyId === 1 && intercompany === 0 && withheldVat === 0 && withheldIncomeTax === 0,
      });
    }
    return [...byId.values()].sort((left, right) => left.code.localeCompare(right.code) || left.id - right.id);
  }

  async search(companyId: number, receiptId: number, filters: ReceiptSupplierSearch): Promise<ReceiptSupplier[]> {
    const context = await this.using((client) => this.context(companyId, receiptId, client));
    if (!context) throw new NotFoundError('Recepción de compra');
    if (!context.preview.canWrite) return [];
    return (await this.choices(filters)).filter(({ id, account, eligible }) =>
      eligible && account === context.source.supplierAccount && id !== context.preview.supplier.id)
      .slice(0, 35).map(({ id, code, name }) => ({ id, code, name }));
  }

  private async target(client: PostgresClient, code: string): Promise<ReceiptSupplierReplacement> {
    const candidates = await this.choices({ code }, true, client);
    if (!candidates.length) throw new NotFoundError('Proveedor');
    if (candidates.length !== 1) throw conflict('El código del proveedor no identifica un único registro.');
    return candidates[0]!;
  }

  async save(companyId: number, receiptId: number, { revision, supplierCode }: { revision: string; supplierCode: string }) {
    if (!this.configured()) throw unavailable();
    this.migration ??= this.using(async (client) => {
      await ensurePurchaseReceptionSchema(client);
      await ensureReceiptSupplierChangesSchema(client);
    }).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    return this.using(async (client) => {
      await client.query('BEGIN');
      try {
        await lockPurchaseReceptionPieces(client, companyId, receiptId);
        const target = await this.target(client, supplierCode);
        await assertActiveSupplierCatalog(client, target.id);
        const confirmed = await this.target(client, supplierCode);
        if (confirmed.id !== target.id || !confirmed.eligible) {
          throw conflict('El proveedor debe estar activo y configurado en pesos, sin retenciones ni intercompañía.');
        }
        const context = await this.context(companyId, receiptId, client, true);
        if (!context) throw new NotFoundError('Recepción de compra');
        const { preview, source, historical } = context;
        if (preview.reason) throw conflict(preview.reason);
        if (preview.revision !== revision) throw conflict('La recepción cambió. Vuelve a consultar el proveedor.');
        if (source.supplierAccount !== confirmed.account) {
          throw conflict('El proveedor debe usar la misma cuenta contable del pasivo original.');
        }
        if (preview.supplier.id !== confirmed.id) {
          await client.query(
            `INSERT INTO tuvansa.purchase_reception_supplier_changes
              (company_id,receipt_id,receipt_number,original_supplier_id,supplier_id,supplier_code,supplier_name,
               supplier_account,amount,historical,charge,revision)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,1)
             ON CONFLICT(company_id,receipt_id) DO UPDATE SET supplier_id=excluded.supplier_id,supplier_code=excluded.supplier_code,
               supplier_name=excluded.supplier_name,revision=tuvansa.purchase_reception_supplier_changes.revision+1,updated_at=now()`,
            [companyId, receiptId, source.reception.number, source.originalSupplier.id, confirmed.id, confirmed.code, confirmed.name,
              source.supplierAccount, source.amount, historical, source.historicalCharge ? JSON.stringify(source.historicalCharge) : null],
          );
        }
        const verified = await this.context(companyId, receiptId, client);
        if (!verified) throw conflict('La recepción dejó de estar disponible antes de guardar.');
        await client.query('COMMIT');
        return verified.preview;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }
}
