import type { RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { OrderPanelsDataSource } from '../../domain/datasources/order-panels-data-source.js';
import type {
  OrderPanelKey, OrderPanelResult, OrderPanelSection,
} from '../../domain/repositories/order-panels-repository.js';

interface IdentityRow extends RowDataPacket { id: number; number: string; customerId: number }

const labels: Record<OrderPanelKey, { button: string; section: OrderPanelSection }> = {
  'assign-all': { button: 'Asignar todo', section: 'actions' },
  authorize: { button: 'Autorizar', section: 'actions' },
  invoices: { button: 'Auxiliar', section: 'actions' },
  boxes: { button: 'Cajas', section: 'actions' },
  classifications: { button: 'Clasificar', section: 'actions' },
  comments: { button: 'Comentarios', section: 'actions' },
  'quote-conversion': { button: 'Cotiz', section: 'actions' },
  duplicate: { button: 'Duplicar', section: 'actions' },
  labels: { button: 'Etiquetas', section: 'actions' },
  print: { button: 'Imprimir', section: 'actions' },
  monarch: { button: 'Monarch', section: 'actions' },
  pieces: { button: 'Piezas', section: 'actions' },
  transfer: { button: 'Traspaso', section: 'actions' },
  'assign-ct': { button: 'Asignar CT', section: 'secondary-actions' },
  consolidate: { button: 'Consolidar', section: 'secondary-actions' },
  ct: { button: 'CT', section: 'secondary-actions' },
  'split-ct': { button: 'Divide ct', section: 'secondary-actions' },
  export: { button: 'EXP', section: 'secondary-actions' },
  'purchase-order': { button: 'Genera O.C.', section: 'secondary-actions' },
  split: { button: 'Split', section: 'secondary-actions' },
  branch: { button: 'Sucursal', section: 'secondary-actions' },
  wip: { button: 'WIP', section: 'secondary-actions' },
};

const queries: Partial<Record<OrderPanelKey, string>> = {
  'assign-all': `SELECT FPLIN.PLSEQ AS lineId, ICOD AS productCode, PLCANT AS ordered,
    PLSURT AS fulfilled, PLASIGNADO AS assigned, (PLCANT - PLSURT - PLASIGNADO) AS assignable
    FROM FPLIN LEFT JOIN FINV ON FPLIN.ISEQ = FINV.ISEQ
    WHERE FPLIN.PESEQ = ? ORDER BY FPLIN.PLSEQ`,
  authorize: `SELECT PEUSRALTA AS createdBy, PEUSRAUT AS authorizedBy,
    CASE WHEN PEUSRAUT > 0 THEN 1 ELSE 0 END AS authorized, PESTATUS AS status
    FROM FPENC WHERE PESEQ = ?`,
  classifications: `SELECT PEPAR1 AS agent, PEPAR2 AS sector, PEPAR3 AS branchOffice,
    PEPAR4 AS statusClassifier, PEPAR5 AS driver, PEPAR6 AS reason, PEPAR7 AS freight
    FROM FPENC WHERE PESEQ = ?`,
  comments: `SELECT FCOMENT.COMSEQ AS id, COML1 AS comment1, COML2 AS comment2,
    COML3 AS comment3, COML4 AS comment4, COML5 AS comment5, COMLETRA AS amountInWords,
    COMCAJA AS boxes, COMDNUM AS documentNumber, COMDES AS description,
    COMCAJA2 AS box2, COMCAJA3 AS box3, COMCAJA4 AS box4, COMCAMBIOS AS changes
    FROM FCOMENT WHERE COMSEQFACT = 10000000 + ? ORDER BY FCOMENT.COMSEQ LIMIT 1`,
  labels: `SELECT FPLIN.PLSEQ AS lineId, ICOD AS productCode, IDESCR AS description,
    PLCANT AS ordered, PLSURT AS fulfilled, PLETIQ AS label, PLTIQX1 AS labelX1,
    PLTIQX2 AS labelX2, PLCOLOR AS color, PLTALLA AS size
    FROM FPLIN LEFT JOIN FINV ON FPLIN.ISEQ = FINV.ISEQ
    WHERE FPLIN.PESEQ = ? ORDER BY FPLIN.PLSEQ`,
  monarch: `SELECT ICOD AS productCode, FPLIN.PLSEQ AS lineId, PLSUC AS branch,
    PLETIQ AS label, PLPROF AS depth, PLCOLOR AS color, PLTALLA AS size,
    PLASIGNADO AS assigned, PLCANT AS ordered, PLSURT AS fulfilled
    FROM FPLIN LEFT JOIN FINV ON FPLIN.ISEQ = FINV.ISEQ
    WHERE FPLIN.PESEQ = ? AND PLASIGNADO > 0 ORDER BY FPLIN.PLSEQ`,
  consolidate: `SELECT FPLIN.PLSEQ AS lineId, ICOD AS productCode, PLCANT AS ordered,
    PLSURT AS fulfilled, PLASIGNADO AS assigned, PLOTROS AS ctReference
    FROM FPLIN LEFT JOIN FINV ON FPLIN.ISEQ = FINV.ISEQ WHERE FPLIN.PESEQ = ? ORDER BY FPLIN.PLSEQ`,
  ct: `SELECT FPLIN.PLSEQ AS lineId, ICOD AS productCode, PLOTROS AS ctReference,
    PLCANT AS ordered, PLSURT AS fulfilled, PLASIGNADO AS assigned
    FROM FPLIN LEFT JOIN FINV ON FPLIN.ISEQ = FINV.ISEQ WHERE FPLIN.PESEQ = ? ORDER BY FPLIN.PLSEQ`,
  'split-ct': `SELECT FPLIN.PLSEQ AS lineId, ICOD AS productCode, PLOTROS AS ctReference,
    PLCANT AS ordered, (PLCANT - PLSURT) AS pending
    FROM FPLIN LEFT JOIN FINV ON FPLIN.ISEQ = FINV.ISEQ WHERE FPLIN.PESEQ = ? ORDER BY FPLIN.PLSEQ`,
  export: `SELECT PEFECHAEXPORT AS exportedAt, PEFECHAEMPAQUE AS packedAt,
    PESTATUS AS status, PEOBS AS observations FROM FPENC WHERE PESEQ = ?`,
  split: `SELECT FPLIN.PLSEQ AS lineId, ICOD AS productCode, IDESCR AS description,
    PLCANT AS ordered, PLSURT AS fulfilled, (PLCANT - PLSURT) AS remaining
    FROM FPLIN LEFT JOIN FINV ON FPLIN.ISEQ = FINV.ISEQ WHERE FPLIN.PESEQ = ? ORDER BY FPLIN.PLSEQ`,
  wip: `SELECT FPLIN.PLSEQ AS lineId, ICOD AS productCode, IDESCR AS description,
    PLCANT AS ordered, PLSURT AS fulfilled, PLASIGNADO AS assigned,
    FINV.ISTKACT AS stock, FINV.IASIGNADO AS inventoryAssigned
    FROM FPLIN LEFT JOIN FINV ON FPLIN.ISEQ = FINV.ISEQ WHERE FPLIN.PESEQ = ? ORDER BY FPLIN.PLSEQ`,
};

const rowsToItems = (rows: RowDataPacket[]): Array<Record<string, unknown>> =>
  rows.map((row) => ({ ...row }));

export class LegacyMysqlOrderPanelsDataSource implements OrderPanelsDataSource {
  async getPanel(orderId: number, key: OrderPanelKey): Promise<OrderPanelResult | null> {
    const [identityRows] = await legacyMysqlPool.execute<IdentityRow[]>(
      'SELECT PESEQ AS id, PENUM AS number, CLISEQ AS customerId FROM FPENC WHERE PESEQ = ? LIMIT 1',
      [orderId],
    );
    const identity = identityRows[0];
    if (identity === undefined) return null;
    const metadata = labels[key];
    let source: OrderPanelResult['source'] = 'mysql';
    let items: Array<Record<string, unknown>> = [];
    let summary: Record<string, unknown> | undefined;

    if (key === 'invoices') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT DNUM AS documentNumber, DFECHA AS date
         FROM FDOC WHERE DREFER = ? AND DEST = 0 AND DMULTICIA = 1
         ORDER BY DREFER, FDOC.DSEQ`, [identity.number],
      );
      items = rowsToItems(rows);
    } else if (key === 'boxes') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        "SELECT YGKEY AS configKey, YGDAT AS configValue FROM FYG WHERE YGKEY = ? LIMIT 1",
        [`EMP_LTD_P_${identity.number}`],
      );
      items = rowsToItems(rows);
      summary = { document: identity.number };
    } else if (key === 'pieces') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT ICOD AS productCode, IDESCR AS description, CAJCANT AS quantity,
          CAJPZAS AS pieces, CAJSERIE AS serialNumber, FCAJAS.CAJSEQ AS id,
          CAJINV AS inventory, CAJPEDIDO AS orderNumber, CAJALM AS warehouse,
          CAJREFER AS reference, CAJFECHA AS createdAt, CAJRECEPCION AS receipt,
          CAJFACTURA AS invoice, CAJMTS AS meters
         FROM FCAJAS LEFT JOIN FINV ON FCAJAS.ISEQ = FINV.ISEQ
         WHERE CAJPEDIDO = ? ORDER BY CAJPEDIDO, FCAJAS.CAJSEQ`, [identity.number],
      );
      items = rowsToItems(rows);
      summary = { total: rows.reduce((total, row) => total + Number(row.CAJPZAS ?? row.pieces ?? 0), 0) };
    } else if (key === 'classifications') {
      const [current] = await legacyMysqlPool.execute<RowDataPacket[]>(queries[key]!, [orderId]);
      const [options] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT AGT AS classifier, AGNUM AS code, AGDESCR AS description, AGTNUM AS compositeCode
         FROM FAG WHERE AGT BETWEEN '1' AND '7' AND AGTIPO IN (0, 1)
         ORDER BY AGT, FAG.AGSEQ`,
      );
      items = [
        ...rowsToItems(current).map((item) => ({ kind: 'current', ...item })),
        ...rowsToItems(options).map((item) => ({ kind: 'option', ...item })),
      ];
    } else if (key === 'duplicate') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT SUCCOD AS branchCode, SUCNOM AS branchName
         FROM FSUCURSALES WHERE CLISEQ = ? ORDER BY SUCSEQ`, [identity.customerId],
      );
      items = rowsToItems(rows);
      summary = { sourceOrder: identity.number, percentage: 100 };
    } else if (key === 'assign-ct' || key === 'purchase-order') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT PRVSEQ AS supplierId, PRVCOD AS supplierCode, PRVNOM AS supplierName
         FROM FPRV ORDER BY PRVCOD, FPRV.PRVSEQ LIMIT 250`,
      );
      items = rowsToItems(rows);
    } else if (key === 'branch') {
      const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT SUCCOD AS code, SUCNOM AS name, SUCDIR1 AS address1, SUCDIR2 AS address2,
          SUCEDO AS state, SUCCD AS city, SUCPAR6 AS classifier
         FROM FSUCURSALES WHERE CLISEQ = ? ORDER BY SUCSEQ`, [identity.customerId],
      );
      items = rowsToItems(rows);
    } else if (key === 'print') {
      source = 'static';
      items = [
        { value: 'order', label: 'Pedido' }, { value: 'packing-list', label: 'Lista de empaque' },
        { value: 'summary', label: 'Resumen' }, { value: 'order-fulfilled', label: 'Pedido-surtido' },
        { value: 'assigned', label: 'Asignado' },
      ];
      summary = { from: identity.number, to: identity.number, copies: 1, destination: 'printer' };
    } else if (key === 'quote-conversion' || key === 'transfer') {
      source = 'static';
      summary = key === 'quote-conversion'
        ? { confirmation: 'Convertir pedido/cotización', orderNumber: identity.number }
        : { confirmation: 'Traspasar los productos a otro almacén', orderNumber: identity.number };
    } else {
      const query = queries[key];
      if (query !== undefined) {
        const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(query, [orderId]);
        items = rowsToItems(rows);
      } else {
        source = 'not-available';
      }
    }

    return {
      order: { id: identity.id, number: identity.number }, key,
      section: metadata.section, button: metadata.button,
      available: source !== 'not-available', source, items,
      ...(summary === undefined ? {} : { summary }),
      ...(source === 'not-available' ? { reason: 'La versión de OMNIS no emitió una consulta MySQL al abrir esta acción.' } : {}),
    };
  }
}
