import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type {
  NativeReceiptForPieces, NativeReceiptPiece, NativeReceiptPieceLine, PurchaseReceptionPieceNativeSource,
} from '../../domain/datasources/purchase-reception-pieces-data-source.js';

interface ReceiptRow extends RowDataPacket {
  id: number;
  number: string;
  warehouse: string;
  receivedAt: string;
  type: string;
  inventoryFlag: number;
  receptionFlag: number;
  canceled: number;
  expenseLabel: string;
  ambiguous: number;
}

interface LineRow extends RowDataPacket, NativeReceiptPieceLine {}

interface CustomsRow extends RowDataPacket {
  customsEntry: string;
  customsOffice: string;
  customsDate: string;
}

interface PieceRow extends RowDataPacket, NativeReceiptPiece {}

const nativeDate = (date: string | null) => !date || date === '1900-12-31' ? null : date;
const receiptTypes = '(receipt.DESFACT IN (2, 3) OR receipt.DESCXC=2)';
const uniqueReference = `receipt.DNUM<>'' AND NOT EXISTS (
  SELECT 1 FROM FDOC other WHERE other.DNUM=receipt.DNUM AND other.DSEQ<>receipt.DSEQ AND other.DEST=0
)`;

function blockedReason(receipt: ReceiptRow): string | null {
  if (receipt.canceled) return 'La recepción está cancelada.';
  if (receipt.type !== 'RA' || receipt.inventoryFlag !== 1 || receipt.receptionFlag !== 2 || receipt.expenseLabel.trim() === 'IMPORT') {
    return 'Las piezas sólo se pueden cambiar en una recepción ordinaria de mercancía.';
  }
  if (receipt.ambiguous) return 'El folio de la recepción no identifica un único documento en Omnis.';
  return null;
}

export async function readNativePurchaseReceptionPieces(
  identity: { id: number } | { number: string },
): Promise<NativeReceiptPiece[]> {
  const matchById = 'id' in identity;
  const match = matchById ? 'receipt.DSEQ' : 'receipt.DNUM';
  const value = matchById ? identity.id : identity.number;
  const [rows] = await legacyMysqlPool.execute<PieceRow[]>(
    // EINV#28D/240 looks up the receipt number. FCAJAS has no company or DSEQ.
    `SELECT piece.CAJSEQ AS id,piece.ISEQ AS productId,COALESCE(product.ICOD,'') AS productCode,
       piece.CAJSERIE AS serialNumber,piece.CAJPZAS AS pieces,piece.CAJCANT AS quantity,piece.CAJALM AS warehouse,
       piece.CAJPEDIDO AS orderNumber,piece.CAJREFER AS reference,piece.CAJFECHA AS date,piece.CAJRECEPCION AS receiptNumber,
       piece.CAJFACTURA AS invoiceNumber,piece.CAJPEDIMENTO AS customsEntry,piece.CAJFECHAIMPORT AS importDate,
       piece.CAJADUANA AS customsOffice,piece.CAJOBS AS notes
     FROM FDOC receipt JOIN FCAJAS piece ON piece.CAJRECEPCION=receipt.DNUM
     LEFT JOIN FINV product ON product.ISEQ=piece.ISEQ
     WHERE ${match}=? AND receipt.DMULTICIA=1 AND receipt.DEST=0 AND ${receiptTypes} AND ${uniqueReference}
     ORDER BY piece.CAJSEQ`, [value],
  );
  return rows.map((row) => ({
    ...row, pieces: Number(row.pieces ?? 0), quantity: Number(row.quantity ?? 0),
    date: nativeDate(row.date), importDate: nativeDate(row.importDate),
  }));
}

export class MysqlPurchaseReceptionPieceNativeSource implements PurchaseReceptionPieceNativeSource {
  async receipt(companyId: number, receiptId: number): Promise<NativeReceiptForPieces | null> {
    if (companyId !== 1) return null;
    const [[header]] = await legacyMysqlPool.execute<ReceiptRow[]>(
      `SELECT receipt.DSEQ AS id,receipt.DNUM AS number,receipt.DALMACEN AS warehouse,receipt.DFECHA AS receivedAt,
         receipt.DITIPMV AS type,receipt.DESINV AS inventoryFlag,receipt.DESFACT AS receptionFlag,
         receipt.DCANCELADA AS canceled,receipt.DOTROSTXT AS expenseLabel,NOT (${uniqueReference}) AS ambiguous
       FROM FDOC receipt
       JOIN FCIA company ON company.CIASEQ=receipt.DMULTICIA AND company.CIAALIAS='TUVANSA'
       WHERE receipt.DSEQ=? AND receipt.DMULTICIA=? AND receipt.DEST=0 AND ${receiptTypes}`, [receiptId, companyId],
    );
    if (!header) return null;
    const [[lines], [[customs]]] = await Promise.all([
      legacyMysqlPool.execute<LineRow[]>(
        `SELECT detail.AISEQ AS id,detail.ISEQ AS productId,COALESCE(product.ICOD,'') AS productCode,
           COALESCE(product.IDESCR,'') AS description,detail.AICANTF AS quantity,
           detail.AIPZAS AS pieces,detail.AIALMACEN AS warehouse
         FROM FAXINV detail LEFT JOIN FINV product ON product.ISEQ=detail.ISEQ
         WHERE detail.DSEQ=? ORDER BY detail.AISEQ`, [receiptId],
      ),
      header.ambiguous ? Promise.resolve<[CustomsRow[]]>([[]]) : legacyMysqlPool.execute<CustomsRow[]>(
        // EINV#22A/401 loads the pedimento by the reception folio.
        `SELECT PMTNUM AS customsEntry,PMTADUANA AS customsOffice,PMTFECHA AS customsDate
         FROM FPEDIMENTO WHERE PMTODOC=? ORDER BY PMTOSEQ DESC LIMIT 1`, [header.number],
      ),
    ]);
    const reason = blockedReason(header);
    return {
      id: header.id, number: header.number, warehouse: header.warehouse.trim(), receivedAt: nativeDate(header.receivedAt),
      canWrite: reason === null, reason, customsEntry: customs?.customsEntry.trim() ?? '',
      customsOffice: customs?.customsOffice.trim() ?? '', customsDate: nativeDate(customs?.customsDate ?? null),
      lines: lines.map((line) => ({ ...line, warehouse: line.warehouse.trim(), pieces: line.pieces ?? '' })),
      version: createHash('sha256').update(JSON.stringify([header, lines, customs])).digest('hex'),
    };
  }

  async pieces(companyId: number, receiptNumber: string): Promise<NativeReceiptPiece[]> {
    return companyId === 1 && receiptNumber ? readNativePurchaseReceptionPieces({ number: receiptNumber }) : [];
  }

  async serialExists(serial: string, excludeId?: number): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
      // CAJSERIE uses macroman_bin, the same case-sensitive lookup as EINV#22A and EINV#28D.
      'SELECT CAJSEQ FROM FCAJAS WHERE CAJSERIE=? AND (? IS NULL OR CAJSEQ<>?) LIMIT 1',
      [serial, excludeId ?? null, excludeId ?? null],
    );
    return rows.length > 0;
  }

  async sequence(companyId: number): Promise<number | null> {
    if (companyId !== 1) return null;
    const [[row]] = await legacyMysqlPool.execute<(RowDataPacket & { value: number })[]>(
      `SELECT TINUM AS value FROM FTIPMV WHERE TICLA='PZ' AND TIMODULO=0 AND TIMULTICIA IN (0,?)
       ORDER BY TIMULTICIA DESC,TISEQ LIMIT 1`, [companyId],
    );
    return row?.value ?? null;
  }
}
