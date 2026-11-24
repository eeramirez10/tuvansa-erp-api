import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { connectPostgres, postgresConfigured, type PostgresClient, type PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import { migratePostgres } from '../../../../../shared/infrastructure/datasources/postgres-schema.js';
import type {
  AddPurchaseReceptionPieceInput, EditPurchaseReceptionPiecesInput, NativeReceiptForPieces, NativeReceiptPiece,
  NativeReceiptPieceLine, PieceLineSnapshot, PurchaseReceptionPieceNativeSource, PurchaseReceptionPiecesDataSource,
  UpdatePurchaseReceptionPieceSerialInput,
} from '../../domain/datasources/purchase-reception-pieces-data-source.js';
import type { PurchaseReceptionProps } from '../../domain/entities/purchase-reception.js';
import type { MovementDocument } from '../../../../inventories/movements/domain/entities/inventory-movement.js';
import { purchaseReceptionCancellationsAvailable } from './purchase-posting-reversal-tables.js';
import {
  lockPurchasePieceSerials, lockPurchaseReceptionPieces, purchaseReceptionPiecesAvailable,
  receiptPieceLineOverrides, receiptUsesPieceSerial, type ReceiptPieceLineOverride,
} from './purchase-reception-piece-reads.js';
import { isLocalPurchaseReceptionId } from './postgres-purchase-reception-writes.js';

const migrations = [{ id: 'purchase_reception_pieces', sql: `
  CREATE SEQUENCE tuvansa.purchase_reception_piece_ids START WITH 7972000000000 MAXVALUE 7972999999999;
  CREATE TABLE tuvansa.purchase_reception_piece_counters (
    company_id integer PRIMARY KEY CHECK(company_id=1), last_number integer NOT NULL
  );
  CREATE TABLE tuvansa.purchase_reception_piece_lines (
    company_id integer NOT NULL CHECK(company_id=1), receipt_id bigint NOT NULL, receipt_number varchar(13) NOT NULL,
    line_id bigint NOT NULL, product_id bigint NOT NULL, base_quantity numeric(18,3) NOT NULL,
    base_pieces text NOT NULL, pieces varchar(24000) NOT NULL, revision integer NOT NULL CHECK(revision>0),
    PRIMARY KEY(company_id,receipt_id,line_id)
  );
  CREATE TABLE tuvansa.purchase_reception_pieces (
    id bigint PRIMARY KEY, company_id integer NOT NULL CHECK(company_id=1), receipt_id bigint NOT NULL,
    receipt_number varchar(13) NOT NULL, line_id bigint, product_id bigint NOT NULL, legacy_piece_id bigint,
    original_serial varchar(30) NOT NULL, serial varchar(30) NOT NULL, quantity numeric(18,3) NOT NULL,
    request_key uuid, fingerprint char(64), piece jsonb NOT NULL, retired boolean NOT NULL DEFAULT false,
    UNIQUE(company_id,request_key), UNIQUE(legacy_piece_id),
    CHECK((legacy_piece_id IS NULL AND line_id IS NOT NULL AND quantity>0 AND request_key IS NOT NULL AND fingerprint IS NOT NULL)
       OR (legacy_piece_id IS NOT NULL AND line_id IS NULL AND request_key IS NULL AND fingerprint IS NULL))
  );
  CREATE UNIQUE INDEX purchase_reception_piece_serial ON tuvansa.purchase_reception_pieces(serial) WHERE NOT retired;
  CREATE INDEX purchase_reception_piece_document ON tuvansa.purchase_reception_pieces(company_id,receipt_id);
  CREATE INDEX purchase_reception_piece_product ON tuvansa.purchase_reception_pieces(product_id);
` }];

const unavailable = 'Configura PostgreSQL para guardar piezas de recepción.';
const cancelled = 'La recepción ya fue cancelada.';
const mexicoDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
const invalid = (message: string) => new ApplicationError(message, 'PURCHASE_RECEPTION_PIECE_INVALID', 422);
const conflict = (message: string) => new ConflictError(message, 'PURCHASE_RECEPTION_PIECE_CONFLICT');
const stale = () => conflict('La recepción o sus piezas cambiaron. Vuelve a abrir la partida.');
const duplicate = () => conflict('El número de serie está duplicado.');
const atThreeDecimals = (value: number) => Math.round(value * 1000) / 1000;
const series = (number: number) => 'A' + String(number).padStart(5, '0');

function quantityInPieces(value: string): number | null {
  if (!value.trim()) return 0;
  return /^\d+(?:\.\d{1,3})?$/.test(value.trim()) && Number.isSafeInteger(Math.round(Number(value) * 1000))
    ? Number(value) : null;
}

function validSerial(value: string, optional: boolean) {
  if ((!optional && !value) || value.length > 30 || value.includes('\0')) throw invalid('Captura una serie válida de hasta 30 caracteres.');
}

interface Context {
  receipt: NativeReceiptForPieces;
  line: NativeReceiptPieceLine;
  snapshot: PieceLineSnapshot;
}

export class PostgresPurchaseReceptionPieces implements PurchaseReceptionPiecesDataSource {
  private migration?: Promise<void>;

  constructor(
    private readonly native: PurchaseReceptionPieceNativeSource,
    private readonly connect: PostgresConnectionFactory = connectPostgres,
    private readonly configured = postgresConfigured,
  ) {}

  private async using<T>(operation: (client: PostgresClient) => Promise<T>) {
    const client = await this.connect();
    try { return await operation(client); }
    finally { client.release(); }
  }

  private async transaction<T>(companyId: number, receiptId: number, operation: (client: PostgresClient) => Promise<T>) {
    if (!this.configured()) throw new ApplicationError(unavailable, 'PURCHASE_RECEPTION_PIECES_NOT_CONFIGURED', 503);
    this.migration ??= this.using((client) => migratePostgres(client, migrations)).catch((error: unknown) => {
      delete this.migration;
      throw error;
    });
    await this.migration;
    return this.using(async (client) => {
      await client.query('BEGIN');
      try {
        await lockPurchaseReceptionPieces(client, companyId, receiptId);
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  private async receipt(client: PostgresClient | undefined, companyId: number, receiptId: number) {
    if (companyId !== 1) return null;
    let receipt: NativeReceiptForPieces | null;
    if (isLocalPurchaseReceptionId(receiptId)) {
      if (!client) return null;
      const { rows: [table] } = await client.query<{ present: boolean }>(
        "SELECT to_regclass('tuvansa.purchase_receptions') IS NOT NULL AS present",
      );
      if (!table?.present) return null;
      const { rows: [stored] } = await client.query<{ receipt: PurchaseReceptionProps; movement: MovementDocument }>(
        `SELECT result->'reception' AS receipt,movement FROM tuvansa.purchase_receptions
         WHERE company_id=$1 AND id=$2 AND number LIKE 'RW%'`, [companyId, receiptId],
      );
      if (!stored) return null;
      const { id, number, warehouse, dates, pedimento, lines } = stored.receipt;
      const warehouses = new Map(stored.movement.lines.map((line) => [line.id, line.warehouse]));
      const canWrite = !stored.receipt.cancelled && stored.movement.header.type === 'RA' && stored.movement.header.inventoryFlag === 1;
      receipt = {
        id, number, warehouse, receivedAt: dates.receivedAt, canWrite,
        reason: canWrite ? null : 'El documento no es una recepción de inventario activa.',
        customsEntry: pedimento?.number ?? '', customsOffice: pedimento?.customsOffice ?? '', customsDate: pedimento?.date ?? null,
        version: '', lines: lines.map((line) => ({ ...line, quantity: line.invoicedQuantity, warehouse: warehouses.get(line.id) ?? '' })),
      };
    } else receipt = await this.native.receipt(companyId, receiptId);
    if (!receipt || !client || !receipt.canWrite || !await purchaseReceptionCancellationsAvailable(client)) return receipt;
    const { rows } = await client.query(
      `SELECT 1 FROM tuvansa.purchase_reception_cancellations c
       WHERE company_id=$1 AND coalesce(c.receipt_id,(to_jsonb(c)->>'legacy_receipt_id')::bigint)=$2`, [companyId, receiptId],
    );
    return rows.length ? { ...receipt, canWrite: false, reason: cancelled } : receipt;
  }

  private async assertUniqueSerial(client: PostgresClient, value: string, ignoredId?: number, excludedNativeId?: number) {
    if (await receiptUsesPieceSerial(client, [value], ignoredId) || await this.native.serialExists(value, excludedNativeId)) throw duplicate();
    const { rows: [state] } = await client.query<{ orders: boolean }>(
      "SELECT to_regclass('tuvansa.purchase_order_pieces') IS NOT NULL AS orders",
    );
    if (state?.orders) {
      const { rows } = await client.query(
        `SELECT 1 FROM tuvansa.purchase_order_pieces o CROSS JOIN LATERAL jsonb_array_elements(o.items) AS p
         WHERE p->>'serial'=$1 LIMIT 1`, [value],
      );
      if (rows.length) throw duplicate();
    }
  }

  private async nextNumber(client: PostgresClient | undefined, companyId: number, available: boolean) {
    const native = await this.native.sequence(companyId);
    if (native === null) return null;
    if (!client || !available) return native + 1;
    const { rows: [counter] } = await client.query<{ last_number: number }>(
      'SELECT last_number FROM tuvansa.purchase_reception_piece_counters WHERE company_id=$1', [companyId],
    );
    return Math.max(native, counter?.last_number ?? 0) + 1;
  }

  private async context(client: PostgresClient | undefined, companyId: number, receiptId: number, lineId: number): Promise<Context | null> {
    const receipt = await this.receipt(client, companyId, receiptId);
    const line = receipt?.lines.find((item) => item.id === lineId);
    if (!receipt || !line) return null;
    const available = client ? await purchaseReceptionPiecesAvailable(client) : false;
    let overridden: ReceiptPieceLineOverride | undefined;
    let recorded = 0;
    if (client && available) {
      overridden = (await receiptPieceLineOverrides(client, companyId, receiptId)).find((item) => item.lineId === lineId);
      const { rows: [result] } = await client.query<{ quantity: number }>(
        `SELECT coalesce(sum(quantity),0)::float8 AS quantity FROM tuvansa.purchase_reception_pieces
         WHERE company_id=$1 AND receipt_id=$2 AND receipt_number=$3 AND line_id=$4 AND NOT retired`,
        [companyId, receiptId, receipt.number, lineId],
      );
      recorded = result?.quantity ?? 0;
    }
    const changed = overridden && (overridden.receiptNumber !== receipt.number || overridden.productId !== line.productId
      || overridden.baseQuantity !== line.quantity || overridden.basePieces !== line.pieces);
    const pieces = changed ? line.pieces : overridden?.pieces ?? line.pieces;
    const quantity = quantityInPieces(pieces);
    const remaining = quantity === null ? 0 : Math.max(0, atThreeDecimals(line.quantity - Math.max(quantity, recorded)));
    const next = receipt.canWrite && client ? await this.nextNumber(client, companyId, available) : null;
    const editReason = !receipt.canWrite ? receipt.reason || 'La recepción no admite cambios.'
      : !client ? unavailable : changed ? stale().message : null;
    const addReason = editReason ?? (!line.productId || !line.productCode || !line.warehouse ? 'La partida no identifica un producto y almacén válidos.'
      : quantity === null ? 'El valor de Pzas en la partida no permite sumar cantidades.'
      : !remaining ? 'El renglón ya tiene pzas asignadas.'
      : next === null ? 'No está configurado el consecutivo de Piezas (PZ).' : null);
    const revision = createHash('sha256').update(JSON.stringify([
      companyId, receipt.id, receipt.number, receipt.version, receipt.canWrite, receipt.receivedAt,
      receipt.customsEntry, receipt.customsOffice, receipt.customsDate,
      line.id, line.productId, line.warehouse, line.quantity, line.pieces, overridden?.revision ?? 0,
    ])).digest('hex');
    return { receipt, line, snapshot: {
      lineId, pieces, remaining, productCode: line.productCode, description: line.description,
      canAdd: !addReason, addReason, canEdit: !editReason, editReason, suggestedSerial: next === null ? '' : series(next),
      revision,
    } };
  }

  async line(companyId: number, receiptId: number, lineId: number) {
    const read = (client?: PostgresClient) => this.context(client, companyId, receiptId, lineId);
    const context = this.configured() ? await this.using(read) : await read();
    return context?.snapshot ?? null;
  }

  private async saveLine(client: PostgresClient, companyId: number, { receipt, line }: Context, pieces: string) {
    await client.query(
      `INSERT INTO tuvansa.purchase_reception_piece_lines
         (company_id,receipt_id,receipt_number,line_id,product_id,base_quantity,base_pieces,pieces,revision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1) ON CONFLICT(company_id,receipt_id,line_id) DO UPDATE SET
         pieces=excluded.pieces,revision=tuvansa.purchase_reception_piece_lines.revision+1`,
      [companyId, receipt.id, receipt.number, line.id, line.productId, line.quantity, line.pieces, pieces],
    );
  }

  async add(companyId: number, receiptId: number, lineId: number, input: AddPurchaseReceptionPieceInput) {
    const serial = input.serial.trim();
    validSerial(serial, true);
    if (input.reference.length > 15 || input.reference.includes('\0') || !Number.isSafeInteger(Math.round(input.quantity * 1000))
      || input.quantity <= 0 || atThreeDecimals(input.quantity) !== input.quantity) {
      throw invalid('Captura una cantidad positiva con hasta tres decimales y una referencia de hasta 15 caracteres.');
    }
    const fingerprint = createHash('sha256').update(JSON.stringify([receiptId, lineId, serial, input.quantity, input.reference])).digest('hex');
    return this.transaction(companyId, receiptId, async (client) => {
      // All web serial allocations and renames serialize with each other.
      await lockPurchasePieceSerials(client);
      const { rows: [previous] } = await client.query<{ fingerprint: string; serialNumber: string }>(
        'SELECT fingerprint,original_serial AS "serialNumber" FROM tuvansa.purchase_reception_pieces WHERE company_id=$1 AND request_key=$2',
        [companyId, input.requestKey],
      );
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw conflict('La solicitud ya se usó con otros datos.');
        return { serialNumber: previous.serialNumber };
      }
      const context = await this.context(client, companyId, receiptId, lineId);
      if (!context) throw new NotFoundError('Partida de recepción');
      const { receipt, line, snapshot } = context;
      if (snapshot.revision !== input.revision) throw stale();
      if (!snapshot.canAdd) throw conflict(snapshot.addReason!);
      if (input.quantity > snapshot.remaining) throw invalid('La cantidad supera el saldo de la partida.');
      const serialNumber = serial || snapshot.suggestedSerial;
      await this.assertUniqueSerial(client, serialNumber);
      if (serialNumber === snapshot.suggestedSerial) {
        await client.query(
          `INSERT INTO tuvansa.purchase_reception_piece_counters(company_id,last_number) VALUES ($1,$2)
           ON CONFLICT(company_id) DO UPDATE SET last_number=excluded.last_number`,
          [companyId, Number(serialNumber.slice(1))],
        );
      }
      const id = await this.allocateId(client);
      const piece: NativeReceiptPiece = {
        id, productId: line.productId, productCode: line.productCode, serialNumber, pieces: 1, quantity: input.quantity,
        warehouse: line.warehouse, orderNumber: '', reference: input.reference, date: mexicoDate.format(),
        receiptNumber: receipt.number, invoiceNumber: '', customsEntry: receipt.customsEntry, importDate: receipt.customsDate,
        customsOffice: receipt.customsOffice, notes: '',
      };
      await client.query(
        `INSERT INTO tuvansa.purchase_reception_pieces
          (id,company_id,receipt_id,receipt_number,line_id,product_id,original_serial,serial,quantity,request_key,fingerprint,piece)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11::jsonb)`,
        [id, companyId, receiptId, receipt.number, lineId, line.productId, serialNumber, input.quantity,
          input.requestKey, fingerprint, JSON.stringify(piece)],
      );
      await this.saveLine(client, companyId, context, String(atThreeDecimals((quantityInPieces(snapshot.pieces) ?? 0) + input.quantity)));
      return { serialNumber };
    });
  }

  async edit(companyId: number, receiptId: number, lineId: number, input: EditPurchaseReceptionPiecesInput) {
    if (input.pieces.length > 24000 || input.pieces.includes('\0')) throw invalid('El valor de Pzas no es válido.');
    return this.transaction(companyId, receiptId, async (client) => {
      const context = await this.context(client, companyId, receiptId, lineId);
      if (!context) throw new NotFoundError('Partida de recepción');
      if (context.snapshot.revision !== input.revision) throw stale();
      if (!context.snapshot.canEdit) throw conflict(context.snapshot.editReason!);
      await this.saveLine(client, companyId, context, input.pieces);
      return { pieces: input.pieces };
    });
  }

  private async allocateId(client: PostgresClient) {
    const { rows: [row] } = await client.query<{ id: string }>("SELECT nextval('tuvansa.purchase_reception_piece_ids') AS id");
    return Number(row!.id);
  }

  async updateSerial(companyId: number, receiptId: number, pieceId: number, input: UpdatePurchaseReceptionPieceSerialInput) {
    const serial = input.serial.trim();
    validSerial(serial, false);
    return this.transaction(companyId, receiptId, async (client) => {
      const receipt = await this.receipt(client, companyId, receiptId);
      if (!receipt) throw new NotFoundError('Recepción de compra');
      if (!receipt.canWrite) throw conflict(receipt.reason || 'La recepción no admite cambios.');
      await lockPurchasePieceSerials(client);
      const { rows: [saved] } = await client.query<{ id: number; legacyId: number | null; original: string; serial: string }>(
        `SELECT id::float8,legacy_piece_id::float8 AS "legacyId",original_serial AS original,serial
         FROM tuvansa.purchase_reception_pieces WHERE company_id=$1 AND receipt_id=$2 AND receipt_number=$3 AND NOT retired
           AND (id=$4 OR legacy_piece_id=$4)`, [companyId, receiptId, receipt.number, pieceId],
      );
      const native = saved?.legacyId === null || isLocalPurchaseReceptionId(receiptId) ? undefined
        : (await this.native.pieces(companyId, receipt.number)).find(({ id }) => id === pieceId);
      if (!saved && !native) throw new NotFoundError('Pieza de recepción');
      if (saved?.legacyId && native?.serialNumber !== saved.original) throw stale();
      const previous = saved?.serial ?? native?.serialNumber;
      if (previous !== input.previousSerial) throw stale();
      if (serial === previous) return { serialNumber: serial };
      await this.assertUniqueSerial(client, serial, saved?.id, native?.id);
      if (saved) {
        await client.query(
          "UPDATE tuvansa.purchase_reception_pieces SET serial=$2::text,piece=jsonb_set(piece,'{serialNumber}',to_jsonb($2::text)) WHERE id=$1",
          [saved.id, serial],
        );
      } else if (native) {
        await client.query(
          `INSERT INTO tuvansa.purchase_reception_pieces
            (id,company_id,receipt_id,receipt_number,product_id,legacy_piece_id,original_serial,serial,quantity,piece)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
          [await this.allocateId(client), companyId, receiptId, receipt.number, native.productId, native.id,
            native.serialNumber, serial, native.quantity, JSON.stringify({ ...native, serialNumber: serial })],
        );
      }
      return { serialNumber: serial };
    });
  }
}
