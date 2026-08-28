import type { RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { InvoicePanelsDataSource } from '../../domain/datasources/invoice-panels-data-source.js';
import type {
  InvoicePanelKey,
  InvoicePanelResult,
  InvoicePanelSection,
} from '../../domain/repositories/invoice-panels-repository.js';

interface IdentityRow extends RowDataPacket {
  id: number;
  number: string;
  customerId: number;
  orderNumber: string;
  movementType: string;
}

const metadata: Record<InvoicePanelKey, { button: string; section: InvoicePanelSection }> = {
  auxiliary: { button: 'Auxiliar', section: 'actions' },
  boxes: { button: 'Cajas', section: 'actions' },
  classifications: { button: 'Clasifica', section: 'actions' },
  comments: { button: 'Comentarios', section: 'actions' },
  ct: { button: 'CT', section: 'actions' },
  print: { button: 'Imprimir', section: 'actions' },
  lots: { button: 'Lotes', section: 'actions' },
  pieces: { button: 'Piezas', section: 'actions' },
  seal: { button: 'Sellar', section: 'actions' },
  'ticket-to-invoice': { button: 'Tiket > Factura', section: 'summaries' },
  transfer: { button: 'Traspaso', section: 'summaries' },
  'edit-pieces': { button: 'Edita pzas', section: 'summaries' },
  'truck-settlement': { button: 'Liquidación camión', section: 'summaries' },
};

const items = (rows: RowDataPacket[]): Array<Record<string, unknown>> =>
  rows.map((row) => ({ ...row }));

export class LegacyMysqlInvoicePanelsDataSource implements InvoicePanelsDataSource {
  async getPanel(invoiceId: number, key: InvoicePanelKey): Promise<InvoicePanelResult | null> {
    const [identityRows] = await legacyMysqlPool.execute<IdentityRow[]>(
      `SELECT DSEQ AS id, DNUM AS number, CLISEQ AS customerId,
              DREFER AS orderNumber, DITIPMV AS movementType
         FROM FDOC WHERE DSEQ = ? LIMIT 1`,
      [invoiceId],
    );
    const identity = identityRows[0];
    if (identity === undefined) return null;

    let source: InvoicePanelResult['source'] = 'mysql';
    let available = true;
    let resultItems: Array<Record<string, unknown>> = [];
    let summary: Record<string, unknown> | undefined;
    let reason: string | undefined;

    if (key === 'auxiliary') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT ASEQ AS id, AFECHA AS date, ATIPMV AS movementType,
                AREFPAG AS reference,
                CASE WHEN ACANT > 0 THEN ACANT ELSE 0 END AS charges,
                CASE WHEN ACANT < 0 THEN ABS(ACANT) ELSE 0 END AS credits,
                ACANT AS amount
           FROM FAX
          WHERE DSEQ = ?
          ORDER BY AFECHA, ASEQ`,
        [invoiceId],
      );
      resultItems = items(rows);
      summary = {
        charges: rows.reduce((total, row) => total + Number(row.charges ?? 0), 0),
        credits: rows.reduce((total, row) => total + Number(row.credits ?? 0), 0),
        balance: rows.reduce((total, row) => total + Number(row.amount ?? 0), 0),
      };
    } else if (key === 'boxes' || key === 'pieces' || key === 'edit-pieces') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT FCAJAS.CAJSEQ AS id, ICOD AS productCode, IDESCR AS description,
                CAJCANT AS quantity, CAJPZAS AS pieces, CAJSERIE AS serialNumber,
                CAJINV AS inventoryDocument, CAJPEDIDO AS orderNumber,
                CAJALM AS warehouse, CAJREFER AS reference, CAJFECHA AS createdAt,
                CAJRECEPCION AS receipt, CAJFACTURA AS invoiceNumber,
                CAJPEDIMENTO AS customsEntry, CAJFECHAIMPORT AS importedAt,
                CAJADUANA AS customsOffice, CAJMTS AS meters
           FROM FCAJAS
           LEFT JOIN FINV ON FCAJAS.ISEQ = FINV.ISEQ
          WHERE CAJFACTURA = ?
          ORDER BY CAJFACTURA, FCAJAS.CAJSEQ`,
        [identity.number],
      );
      resultItems = items(rows);
      summary = {
        packageCount: rows.length,
        pieces: rows.reduce((total, row) => total + Number(row.pieces ?? 0), 0),
        quantity: rows.reduce((total, row) => total + Number(row.quantity ?? 0), 0),
      };
    } else if (key === 'classifications') {
      const [currentRows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT DPAR0 AS classifier0, DPAR1 AS classifier1, DPAR2 AS classifier2,
                DPAR3 AS classifier3, DPAR4 AS classifier4, DPAR5 AS classifier5,
                DPAR6 AS classifier6, DPAR7 AS classifier7, DPAR8 AS classifier8,
                DPAR9 AS classifier9
           FROM FDOC WHERE DSEQ = ? LIMIT 1`,
        [invoiceId],
      );
      const [optionRows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT AGT AS classifier, AGNUM AS code, AGDESCR AS description,
                AGTNUM AS compositeCode
           FROM FAG
          WHERE AGT BETWEEN '0' AND '9' AND AGTIPO IN (0, 1)
          ORDER BY AGT, FAG.AGSEQ`,
      );
      resultItems = [
        ...items(currentRows).map((row) => ({ kind: 'current', ...row })),
        ...items(optionRows).map((row) => ({ kind: 'option', ...row })),
      ];
    } else if (key === 'comments') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT FCOMENT.COMSEQ AS id, COMSEQFACT AS invoiceId,
                COML1 AS comment1, COML2 AS comment2, COML3 AS comment3,
                COML4 AS comment4, COML5 AS comment5, COMLETRA AS amountInWords,
                COMCAJA AS boxes, COMDNUM AS documentNumber,
                COMDES AS description, COMCAJA2 AS box2, COMCAJA3 AS box3,
                COMCAJA4 AS box4, COMCAMBIOS AS changes
           FROM FCOMENT
          WHERE COMSEQFACT = ?
          ORDER BY FCOMENT.COMSEQ
          LIMIT 1`,
        [invoiceId],
      );
      resultItems = items(rows);
      const [headerRows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT DRUTA AS route, DTALON AS deliveryNote, DFOLIO AS folio,
                DFECHATALON AS deliveryNoteAt, DFECHAPAGO AS paidAt,
                DINICIAL AS initial, DMONEDA AS currencyId, DTIPOC AS exchangeRate,
                DALMACEN AS warehouse, DREFER AS orderNumber,
                DREFERELLOS AS customerOrderNumber, CLICOD AS customerCode,
                DCLINOM AS customerName, DDEPTO AS department,
                DPESO AS weight, DVOLUMEN AS volume, DOTROSTXT AS otherText,
                DCTAPAGO AS paymentAccount, DMETPAGO AS paymentMethod
           FROM FDOC LEFT JOIN FCLI ON FDOC.CLISEQ = FCLI.CLISEQ
          WHERE FDOC.DSEQ = ? LIMIT 1`,
        [invoiceId],
      );
      summary = headerRows[0] === undefined ? {} : { ...headerRows[0] };
    } else if (key === 'ct') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT FAXINV.AISEQ AS id, ICOD AS productCode, IDESCR AS product,
                AICANT AS ordered, AICANTF AS fulfilled, AIUNIDAD AS unit,
                AIPRECIO AS price, AISUCURSAL AS branch, AIPZAS AS pieces
           FROM FAXINV LEFT JOIN FINV ON FAXINV.ISEQ = FINV.ISEQ
          WHERE FAXINV.DSEQ = ? ORDER BY FAXINV.AISEQ`,
        [invoiceId],
      );
      resultItems = items(rows);
      summary = {
        ordered: rows.reduce((total, row) => total + Number(row.ordered ?? 0), 0),
        fulfilled: rows.reduce((total, row) => total + Number(row.fulfilled ?? 0), 0),
      };
    } else if (key === 'lots') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT FAXINV.AISEQ AS lineId, ICOD AS productCode, IDESCR AS description,
                AICANTF AS quantity, FLOTES.LOSEQ AS id, LOLOTE AS lot,
                LOFECHA AS date, LOPEDIM AS customsEntry,
                LOADUANA AS customsOffice, LONUM AS number,
                LOCADUCIDAD AS expiresAt, LOALM AS warehouse
           FROM FAXINV
           LEFT JOIN FINV ON FAXINV.ISEQ = FINV.ISEQ
           LEFT JOIN FLOTES ON FAXINV.LOSEQ = FLOTES.LOSEQ
          WHERE FAXINV.DSEQ = ?
          ORDER BY FAXINV.AISEQ, FLOTES.LOSEQ`,
        [invoiceId],
      );
      resultItems = items(rows);
    } else if (key === 'print') {
      source = 'static';
      resultItems = [
        { value: 'invoice', label: 'Factura' },
        { value: 'packing-instructions', label: 'Instrucciones para empaque' },
        { value: 'packing-list', label: 'Lista de empaque' },
        { value: 'simplified-labels', label: 'Etiquetas simplificadas' },
        { value: 'detailed-labels', label: 'Etiquetas detalladas' },
      ];
      summary = { from: identity.number, to: identity.number, copies: 1 };
    } else if (key === 'seal') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT DSTATUS AS status, DSTATUSCFD AS cfdStatus,
                DCANCELADA AS canceled, DAPROBFOLIOS AS approvedFolio,
                DFOLIO AS folio, DFECHAFOLIO AS folioAt
           FROM FDOC WHERE DSEQ = ? LIMIT 1`,
        [invoiceId],
      );
      resultItems = items(rows);
      summary = { mutationEnabled: false };
      reason = 'Solo se expone el estado; el sellado no se ejecuta durante la migración de lectura.';
    } else if (key === 'transfer') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT FAXINV.AISEQ AS lineId, FAXINV.ISEQ AS productId,
                ICOD AS productCode, IDESCR AS description,
                AICANTF AS quantity, AISUCURSAL AS branch
           FROM FAXINV LEFT JOIN FINV ON FAXINV.ISEQ = FINV.ISEQ
          WHERE FAXINV.DSEQ = ? ORDER BY FAXINV.AISEQ`,
        [invoiceId],
      );
      resultItems = items(rows);
      available = false;
      reason = 'El traspaso modifica inventario y permanece deshabilitado en la API de lectura.';
    } else if (key === 'truck-settlement') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT DRUTA AS route, DFECHARUTA AS routeAt, DCLINOM AS customer,
                DCANT AS total, DMONEDA AS currencyId, DTIPOC AS exchangeRate,
                DSTATUS AS status
           FROM FDOC WHERE DSEQ = ? LIMIT 1`,
        [invoiceId],
      );
      resultItems = items(rows);
      available = false;
      reason = 'La liquidación de camión es una operación de escritura y no se ejecuta en esta fase.';
    } else {
      source = 'static';
      available = false;
      summary = {
        invoiceNumber: identity.number,
        orderNumber: identity.orderNumber,
        movementType: identity.movementType,
      };
      reason = 'OMNIS no emitió SQL de lectura al abrir esta acción; su mutación queda fuera de esta fase.';
    }

    const label = metadata[key];
    return {
      invoice: { id: identity.id, number: identity.number },
      key,
      section: label.section,
      button: label.button,
      available,
      source,
      items: resultItems,
      readOnly: true,
      ...(summary === undefined ? {} : { summary }),
      ...(reason === undefined ? {} : { reason }),
    };
  }
}
