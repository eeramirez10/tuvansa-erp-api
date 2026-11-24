import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { LegacyMysqlMovementsDataSource } from '../../../../inventories/movements/infrastructure/datasources/legacy-mysql-movements-data-source.js';
import { readLegacySaleStock } from '../../../../sales/orders/infrastructure/datasources/sales-order-inventory-stock.js';
import type {
  HistoricalReceiptCancellationSource, ReceiptCancellationSource,
} from '../../domain/datasources/purchase-reception-cancellation-data-source.js';
import type { ReceiptCancellationLine } from '../../domain/entities/purchase-reception-cancellation.js';
import type { LegacyMysqlPurchaseReceptionsDataSource } from './legacy-mysql-purchase-receptions-data-source.js';
import { readHistoricalReceptionAccounting } from './mysql-historical-reception-accounting.js';

interface HistoricalHeaderRow extends RowDataPacket {
  currency: number;
  exchangeRate: number;
  payableFlag: number;
  receivedFlag: number;
  importExpense: number;
  boxes: number;
  hasPayments: number;
  hasCancellation: number;
  multiWarehouse: number;
  cancellationPolicy: number;
  accountingActive: number;
  configuredType: number;
}

interface HistoricalLineRow extends RowDataPacket {
  id: number;
  orderLine: number | null;
  orderId: number | null;
  orderNumber: string | null;
  supplierId: number | null;
  orderedProduct: number | null;
  productId: number;
  type: string;
  warehouse: string;
  productType: number | null;
  noLayers: number | null;
  baseUnit: string | null;
  movementUnit: string;
  orderedUnit: string | null;
  factor: number | null;
  quantity: number;
  orderedQuantity: number;
  shipped: number | null;
  assigned: number | null;
  receivedPieces: number | null;
}

function lineEffects(rows: HistoricalLineRow[], movement: ReceiptCancellationSource['movement'], orderNumber: string, supplierId: number) {
  const orderId = rows[0]?.orderId ?? 0;
  if (!orderId || rows.length !== movement.lines.length) return null;
  const effects = new Map<number, ReceiptCancellationLine>();
  for (const row of rows) {
    if (!row.orderLine || row.orderId !== orderId || row.orderNumber !== orderNumber || row.supplierId !== supplierId
      || row.productId !== row.orderedProduct || row.type !== 'RA' || row.warehouse !== movement.header.warehouse
      || row.factor !== 1 || !row.baseUnit || row.orderedUnit !== row.baseUnit || row.movementUnit !== row.baseUnit
      || row.quantity <= 0 || !Number.isFinite(row.quantity) || Number(row.quantity.toFixed(3)) !== row.quantity
      || row.quantity !== row.orderedQuantity) return null;

    const previous = effects.get(row.orderLine)?.baseQuantity ?? 0;
    // MRECEP/25 to MBASE/124 subtracts AICANTF from PLSURT and PEPZASSURT.
    // The historical procedure leaves PESURT and PLASIGNADO alone.
    effects.set(row.orderLine, { orderLineId: row.orderLine, productId: row.productId, factor: 1,
      baseQuantity: Number((previous + row.orderedQuantity).toFixed(3)), netAmount: 0 });
  }
  return { orderId, lines: [...effects.values()] };
}

export class MysqlHistoricalReceptionCancellationSource implements HistoricalReceiptCancellationSource {
  private readonly movements = new LegacyMysqlMovementsDataSource();

  constructor(private readonly receptions: Pick<LegacyMysqlPurchaseReceptionsDataSource, 'findById'>) {}

  inventory(warehouse: string, productIds: number[]): ReturnType<HistoricalReceiptCancellationSource['inventory']> {
    return readLegacySaleStock(warehouse, productIds);
  }

  async read(receiptId: number): Promise<ReceiptCancellationSource | null> {
    const [legacy, movement, [headers], [lines]] = await Promise.all([
      this.receptions.findById(receiptId),
      this.movements.findById(receiptId),
      // Adaptada de MRECEP/25–26, /111 y /136–138. Comprueba la configuración actual del flujo.
      legacyMysqlPool.execute<HistoricalHeaderRow[]>(
        `SELECT d.DMONEDA AS currency,d.DTIPOC AS exchangeRate,d.DESCXC AS payableFlag,d.DESFACT AS receivedFlag,
           d.DOTROSTXT='IMPORT' AS importExpense,
           EXISTS(SELECT 1 FROM FCAJAS WHERE CAJRECEPCION=d.DNUM) AS boxes,
           EXISTS(SELECT 1 FROM FAX WHERE DSEQ=d.DSEQ AND ATIPMV='PP') AS hasPayments,
           EXISTS(SELECT 1 FROM FAX WHERE DSEQ=d.DSEQ AND ATIPMV='K') AS hasCancellation,
           SUBSTRING(c.CIACOMPORTA,37,1)='1' AS multiWarehouse,SUBSTRING(c.CIACOMPORTA,78,1)='1' AS cancellationPolicy,
           SUBSTRING(c.CIAPLUGS,4,1)='X' AND c.CIAPOLIZACONT='3' AS accountingActive,
           EXISTS(SELECT 1 FROM FTIPMV m WHERE m.TIMULTICIA=1 AND m.TIMODULO=7 AND m.TICLA='RA'
             AND m.TIAFINV=1 AND m.TIAFCXC=1 AND m.TIAFVTS=1) AS configuredType
         FROM FDOC d JOIN FCIA c ON c.CIASEQ=d.DMULTICIA AND c.CIAALIAS='TUVANSA'
         WHERE d.DSEQ=? AND d.DMULTICIA=1 AND d.DEST=0`, [receiptId],
      ),
      // Adaptada del vínculo FDOC.DREFER → FPENC y FAXINV.AIPED → FPLIN.PLSEQ de MRECEP/25.
      legacyMysqlPool.execute<HistoricalLineRow[]>(
        `SELECT a.AISEQ AS id,a.AIPED AS orderLine,o.PESEQ AS orderId,o.PENUM AS orderNumber,o.PRVSEQ AS supplierId,
           p.ISEQ AS orderedProduct,a.ISEQ AS productId,a.AITIPMV AS type,a.AIALMACEN AS warehouse,
           i.ITIPO AS productType,i.INOCAPAS AS noLayers,i.IUM AS baseUnit,a.AIUNIDAD AS movementUnit,
           p.PLUNIDAD AS orderedUnit,p.PLFACTOR AS factor,a.AICANT AS quantity,a.AICANTF AS orderedQuantity,
           p.PLSURT AS shipped,p.PLASIGNADO AS assigned,o.PEPZASSURT AS receivedPieces
         FROM FAXINV a
         JOIN FDOC d ON d.DSEQ=a.DSEQ AND d.DMULTICIA=1 AND d.DEST=0
         LEFT JOIN FPLIN p ON p.PLSEQ=a.AIPED
         LEFT JOIN FPENC o ON o.PESEQ=p.PESEQ AND o.PENUM=d.DREFER AND o.PEMULTICIA=1
         LEFT JOIN FINV i ON i.ISEQ=a.ISEQ
         WHERE a.DSEQ=? ORDER BY a.AISEQ`, [receiptId],
      ),
    ]);
    const header = headers[0];
    if (!legacy || !movement || !header) return null;
    const receipt = legacy.toPrimitives();
    const order = lineEffects(lines, movement, receipt.orderNumber, receipt.supplier.id);
    let reason: string | null = null;
    if (header.importExpense) {
      reason = 'El procedimiento de Recepciones bloquea la cancelación de gastos IMPORT.';
    } else if (header.hasCancellation) {
      reason = 'La recepción ya tiene una cancelación en Omnis.';
    } else if (header.hasPayments) {
      reason = 'La recepción tiene pagos PP registrados en Omnis.';
    } else if (!/^RA\d/.test(receipt.number) || movement.header.type !== 'RA' || movement.header.inventoryFlag !== 1
      || header.receivedFlag !== 2 || header.payableFlag !== 2 || !header.configuredType) {
      reason = 'El documento no es una recepción ordinaria RA activa de TUVANSA.';
    } else if (header.currency !== 1 || header.exchangeRate !== 1 || !header.cancellationPolicy || !header.accountingActive || !header.multiWarehouse) {
      reason = 'La moneda o la configuración contable y de inventario requieren otra cancelación.';
    } else if (header.boxes || lines.some((line) => line.noLayers !== 1 || (line.productType !== 0 && line.productType !== 1))) {
      reason = 'La recepción utiliza cajas, piezas, capas o un tipo de producto con manejo especial.';
    } else if (!order) {
      reason = 'No se pudo comprobar el vínculo con las partidas originales de la orden y su unidad base.';
    }
    const finances = reason ? null : await readHistoricalReceptionAccounting(receipt);
    const version = createHash('sha256').update(JSON.stringify([
      receipt.number, receipt.dates, receipt.totals, receipt.supplier.id, receipt.cancelled,
      header, lines, movement, finances,
    ])).digest('hex');
    return {
      id: receiptId, orderId: order?.orderId ?? 0, orderNumber: receipt.orderNumber, receipt,
      orderLineEffects: order?.lines ?? [], movement, payable: finances?.payable ?? null, accounting: finances?.accounting ?? null,
      orderRetired: false, paymentActive: false, lastReversalDate: null, alreadyRecorded: null,
      historical: { version, blockedReason: reason ?? finances?.reason ?? null },
    };
  }
}
