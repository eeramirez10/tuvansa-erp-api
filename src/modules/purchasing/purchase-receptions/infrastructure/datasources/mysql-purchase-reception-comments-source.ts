import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type {
  PurchaseReceptionCommentLines, PurchaseReceptionCommentsBase, PurchaseReceptionCommentsSource,
} from '../../domain/datasources/purchase-reception-comments-data-source.js';

interface CommentLabels {
  line1: string | null;
  line2: string | null;
  line3: string | null;
  line4: string | null;
  line5: string | null;
}

interface CommentsRow extends RowDataPacket, CommentLabels {
  id: number;
  number: string;
  supplierId: number;
  supplierCode: string | null;
  dueAt: string;
  supplierReference: string;
  department: string;
  orderNumber: string;
  transportCode: string;
  processDate: string;
  otherLabel: string;
  boxes: number | null;
  volume: number;
  folio: string;
  folioAt: string;
  amountInWords: string | null;
  warehouse: string;
}

const nativeDate = (date: string | null | undefined) =>
  !date || date.startsWith('1900-12-31') || date.startsWith('0000-00-00') ? null : date.slice(0, 10);

function lines(row?: CommentLabels): PurchaseReceptionCommentLines {
  return [row?.line1 ?? '', row?.line2 ?? '', row?.line3 ?? '', row?.line4 ?? '', (row?.line5 ?? '').replace(/\r\n?/g, '\n')];
}

export class MysqlPurchaseReceptionCommentsSource implements PurchaseReceptionCommentsSource {
  async read(companyId: number, receptionId: number): Promise<PurchaseReceptionCommentsBase | null> {
    if (companyId !== 1) return null;
    const [rows] = await legacyMysqlPool.execute<CommentsRow[]>(
      `SELECT d.DSEQ AS id,d.DNUM AS number,d.PRVSEQ AS supplierId,p.PRVCOD AS supplierCode,
         d.DVENCE AS dueAt,d.DREFERELLOS AS supplierReference,d.DDEPTO AS department,d.DREFER AS orderNumber,
         d.DPAR7 AS transportCode,d.DFECHAPROGR AS processDate,d.DOTROSTXT AS otherLabel,d.DVOLUMEN AS volume,
         d.DFOLIO AS folio,d.DFECHAFOLIO AS folioAt,d.DALMACEN AS warehouse,c.COMCAJA AS boxes,
         c.COML1 AS line1,c.COML2 AS line2,c.COML3 AS line3,c.COML4 AS line4,c.COML5 AS line5,c.COMLETRA AS amountInWords
       FROM FDOC d LEFT JOIN FPRV p ON p.PRVSEQ=d.PRVSEQ
       LEFT JOIN FCOMENT c ON c.COMSEQFACT=d.DSEQ
       WHERE d.DSEQ=? AND d.DMULTICIA=? AND d.DEST=0 AND (d.DESFACT IN (2,3) OR d.DESCXC=2)
       ORDER BY c.COMSEQ LIMIT 2`, [receptionId, companyId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      reception: { id: row.id, number: row.number, supplierCode: row.supplierCode ?? '' },
      supplierId: row.supplierId,
      fields: {
        dueAt: nativeDate(row.dueAt), supplierReference: row.supplierReference, department: row.department,
        orderNumber: row.orderNumber, transportCode: row.transportCode, processDate: nativeDate(row.processDate), otherLabel: row.otherLabel,
        boxes: Number(row.boxes ?? 0), volume: Number(row.volume), folio: row.folio,
        folioAt: nativeDate(row.folioAt) ? row.folioAt.replace(' ', 'T') : null,
        lines: lines(row), amountInWords: row.amountInWords ?? '', warehouse: row.warehouse,
      },
      reason: rows.length > 1 ? 'La recepción tiene más de un registro de comentarios en Proscai.' : null,
    };
  }

  async labels(movementLetter: string): Promise<PurchaseReceptionCommentLines> {
    if (!movementLetter) return lines();
    // ERECEPC#6/0 lee el tipo con la primera letra del folio.
    const [[row]] = await legacyMysqlPool.execute<(RowDataPacket & CommentLabels)[]>(
      `SELECT TICOML1 AS line1,TICOML2 AS line2,TICOML3 AS line3,TICOML4 AS line4,TICOML5 AS line5
       FROM FTIPMV WHERE TICLA=? ORDER BY TISEQ LIMIT 1`, [movementLetter],
    );
    return lines(row);
  }

  async transportName(code: string): Promise<string> {
    if (!code) return '';
    const [[row]] = await legacyMysqlPool.execute<(RowDataPacket & { name: string })[]>(
      "SELECT AGDESCR AS name FROM FAG WHERE AGT='7' AND AGTNUM=? ORDER BY AGSEQ LIMIT 1", [code],
    );
    return row?.name ?? '';
  }
}
