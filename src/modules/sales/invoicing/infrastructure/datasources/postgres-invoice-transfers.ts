import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { connectPostgres, postgresConfigured, postgresUnavailable,
  type PostgresClient, type PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import { requireCustomer } from '../../../../../shared/infrastructure/http/customer-scope.js';
import { ensureInventoryAdjustmentSchema, recordInvoiceTransferInventory } from '../../../../inventories/movements/infrastructure/datasources/postgres-inventory-adjustments.js';
import { lockWarehouseStock } from '../../../orders/infrastructure/datasources/sales-order-inventory-stock.js';
import type { HistoricalSalesRemissionCancellationSource, SalesRemissionCancellationSource } from '../../domain/datasources/sales-remission-cancellation-data-source.js';
import type { InvoiceTransferPreview, InvoiceTransferReceipt } from '../../domain/entities/invoice-transfer.js';
import { historicalSalesRemissionCancellationsOn } from './sales-remission-cancellation-reads.js';
import { invoiceTransfersOn, lockInvoiceTransfer } from './invoice-transfer-reads.js';
import { mexicoInvoiceTransferConfiguration } from './mysql-invoice-transfer-references.js';
import { MysqlHistoricalSalesRemissionCancellationSource } from './mysql-historical-sales-remission-cancellation-source.js';
import { invoiceHasPieceEditsOn } from './postgres-invoice-pieces.js';
import { ensureSalesRemissionSchema } from './postgres-sales-remissions.js';

const migrations = [{ id: 'mexico_invoice_transfer', sql: `
  CREATE TABLE tuvansa.invoice_transfers (
    id bigint PRIMARY KEY REFERENCES tuvansa.inventory_adjustments(id),
    invoice_id bigint UNIQUE NOT NULL,
    customer_id bigint NOT NULL,
    source_number varchar(15) NOT NULL,
    order_number varchar(15) NOT NULL,
    issued_at date NOT NULL,
    due_at date,
    amount numeric(18,2) NOT NULL CHECK (amount > 0),
    user_id integer NOT NULL CHECK (user_id >= 0),
    actor text NOT NULL,
    request_key uuid UNIQUE NOT NULL,
    fingerprint char(64) NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX invoice_transfers_customer ON tuvansa.invoice_transfers(customer_id,id);
` }];

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const mexicoDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
const stale = () => new ConflictError('La remisión, el destino o la configuración cambiaron. Consulta otra vez la vista previa.', 'INVOICE_TRANSFER_STALE');

export interface InvoiceTransferActor {
  id: string;
  legacyId: number;
  captureFrom: string | null;
  captureUntil: string | null;
}

interface Confirmation {
  warehouse: string;
  revision: string;
  requestKey: string;
}

export class PostgresInvoiceTransfers {
  private migration?: Promise<void>;

  constructor(
    private readonly source: HistoricalSalesRemissionCancellationSource = new MysqlHistoricalSalesRemissionCancellationSource(),
    private readonly configuration = mexicoInvoiceTransferConfiguration,
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured = postgresConfigured,
    private readonly today = () => mexicoDate.format(),
  ) {}

  private async withClient<T>(run: (client: PostgresClient) => Promise<T>) {
    let client: PostgresClient | undefined;
    try {
      client = await this.connect();
      return await run(client);
    }
    catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError('No fue posible consultar o registrar el traspaso.', 'INVOICE_TRANSFER_UNAVAILABLE', 503);
    } finally { client?.release(); }
  }

  private async readPreview(client: PostgresClient | null, source: SalesRemissionCancellationSource,
    actor: InvoiceTransferActor, warehouse: string | null): Promise<InvoiceTransferPreview> {
    const { id, invoice, historical, movement, charge, warehouse: from } = source;
    const date = this.today();
    const configuration = await this.configuration();
    const [recorded] = client ? await invoiceTransfersOn(client, { invoiceIds: [id] }) : [];
    const cancellation = client && !recorded ? await historicalSalesRemissionCancellationsOn(client, { invoiceIds: [id] }) : [];
    const editedPieces = client && !recorded && !cancellation.length ? await invoiceHasPieceEditsOn(client, id) : false;
    const warehouses = configuration.warehouses.filter(({ code }) => code !== from);
    const receipt = recorded?.result ?? null;
    const selected = warehouses.find(({ code }) => code === warehouse);
    const lines = movement.lines.map((line, index) => ({
      productCode: line.productCode, description: line.description, quantity: -line.quantity,
      unit: line.unit, price: invoice.lines[index]?.price ?? 0, cost: line.cost,
    }));
    let reason = historical?.blockedReason
      ? 'Se requiere una remisión FA activa en pesos, con su cargo original pendiente y partidas ordinarias de inventario.' : null;
    if (receipt) reason = 'La remisión ya se traspasó.';
    else if (cancellation.length) reason = 'La remisión está cancelada en la web.';
    else if (!historical || !/^FA\d+$/.test(source.number)) reason = 'Selecciona una remisión FA de México registrada en German.';
    else if (editedPieces || movement.lines.some(({ lotId }) => lotId !== 0)) reason = 'La remisión usa piezas o capas de inventario.';
    else if (!configuration.enabled || !configuration.warehouses.some(({ code }) => code === from)) {
      reason ??= 'Activa FA para traspasos y configura el tipo TA de México con su efecto en Cuentas por Cobrar e Inventarios.';
    } else if ((actor.captureFrom && date < actor.captureFrom) || (actor.captureUntil && date > actor.captureUntil)) {
      reason ??= 'La fecha está fuera del periodo de capturas de tu usuario.';
    } else if (warehouses.length === 0 || (warehouse !== null && !selected)) {
      reason ??= 'Selecciona otro almacén físico de México.';
    } else if (!client) reason ??= 'Registra el traspaso en una instancia con PostgreSQL configurado.';
    return {
      warehouses, reason, from: receipt?.from ?? from, to: receipt?.to ?? selected?.code ?? null,
      date: receipt?.date ?? date, amount: receipt?.amount ?? charge, receipt, lines,
      revision: !reason && selected ? hash([historical?.version, date, selected, from]) : null,
    };
  }

  async preview(id: number, actor: InvoiceTransferActor, warehouse: string | null) {
    const source = await this.source.read(id);
    if (!source) throw new NotFoundError('Remisión FA de México');
    requireCustomer(source.customerId);
    return this.configured() ? this.withClient(client => this.readPreview(client, source, actor, warehouse))
      : this.readPreview(null, source, actor, warehouse);
  }

  async confirm(id: number, actor: InvoiceTransferActor, input: Confirmation) {
    if (!this.configured()) throw postgresUnavailable();
    const source = await this.source.read(id);
    if (!source) throw new NotFoundError('Remisión FA de México');
    requireCustomer(source.customerId);
    this.migration ??= this.withClient(async client => {
      await migratePostgres(client);
      await ensureSalesRemissionSchema(client);
      await ensureInventoryAdjustmentSchema(client);
      await migratePostgres(client, migrations);
    }).catch((error: unknown) => { delete this.migration; throw error; });
    await this.migration;
    return this.withClient(async client => {
      await client.query('BEGIN');
      try {
        const receipt = await this.save(client, source, actor, input);
        await client.query('COMMIT');
        return receipt;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  private async save(client: PostgresClient, source: SalesRemissionCancellationSource, actor: InvoiceTransferActor, input: Confirmation) {
    const { id, customerId } = source;
    const fingerprint = hash([id, actor.id, input.warehouse, input.revision]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('invoice-transfer-request:'||$1::text,0))", [input.requestKey]);
    const { rows: [previous] } = await client.query<{ fingerprint: string; result: InvoiceTransferReceipt }>(
      'SELECT fingerprint,result FROM tuvansa.invoice_transfers WHERE request_key=$1', [input.requestKey],
    );
    if (previous) {
      if (previous.fingerprint === fingerprint) return previous.result;
      throw new ConflictError('La clave del envío ya pertenece a otro traspaso.', 'INVOICE_TRANSFER_REQUEST_REUSED');
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('sales-credit:1:'||$1::text,0))", [customerId]);
    await lockInvoiceTransfer(client, id);
    const current = await this.source.read(id);
    if (!current || current.customerId !== customerId) throw stale();
    const preview = await this.readPreview(client, current, actor, input.warehouse);
    if (preview.revision !== input.revision || !preview.to) throw stale();
    await lockWarehouseStock(client, preview.to, current.movement.lines.map(({ productId }) => productId));
    // EFACT#13/197 conserva la salida de origen y crea únicamente la entrada TA de destino.
    const { header, lines } = current.movement;
    const movement = await recordInvoiceTransferInventory(client, {
      ...header, date: preview.date, reference: current.number, reference2: '', warehouse: preview.to,
      company: 1, type: 'TA', status: 0, inventoryFlag: 1, billingFlag: 1, userId: actor.legacyId,
    }, lines.map((line, index) => ({
      ...line, warehouse: input.warehouse, quantity: -line.quantity, type: 'TA', userId: actor.legacyId,
      price: current.invoice.lines[index]!.price, invoicedQuantity: -current.invoice.lines[index]!.fulfilledQuantity,
    })), {
      sourceId: id, subtotal: current.invoice.totals.subtotal, tax: current.invoice.totals.tax, total: current.invoice.totals.total,
    }, input.requestKey, fingerprint);
    const receipt: InvoiceTransferReceipt = {
      id: movement.header.id, number: movement.header.document, date: preview.date,
      from: preview.from, to: preview.to, amount: preview.amount,
    };
    await client.query(
      `INSERT INTO tuvansa.invoice_transfers(id,invoice_id,customer_id,source_number,order_number,issued_at,due_at,
        amount,user_id,actor,request_key,fingerprint,result)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
      [receipt.id, id, customerId, current.number, current.orderNumber, current.issuedAt, current.invoice.dates.dueAt,
        receipt.amount, actor.legacyId, actor.id, input.requestKey, fingerprint, JSON.stringify(receipt)],
    );
    return receipt;
  }
}
