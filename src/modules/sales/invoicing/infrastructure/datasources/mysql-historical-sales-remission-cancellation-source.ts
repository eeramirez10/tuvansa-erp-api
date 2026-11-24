import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { LegacyMysqlMovementsDataSource } from '../../../../inventories/movements/infrastructure/datasources/legacy-mysql-movements-data-source.js';
import type { MovementDocument } from '../../../../inventories/movements/domain/entities/inventory-movement.js';
import type { OrderProps } from '../../../orders/domain/entities/order.js';
import { LegacyMysqlOrdersDataSource } from '../../../orders/infrastructure/datasources/legacy-mysql-orders-data-source.js';
import type {
  HistoricalSalesRemissionCancellationSource, SalesRemissionCancellationSource,
} from '../../domain/datasources/sales-remission-cancellation-data-source.js';
import type { InvoiceProps } from '../../domain/entities/invoice.js';
import { LegacyMysqlInvoicesDataSource } from './legacy-mysql-invoices-data-source.js';

interface RemissionRow extends RowDataPacket {
  number: string;
  type: string;
  issuedAt: string;
  customerId: number;
  orderNumber: string;
  warehouse: string;
  currencyId: number;
  exchangeRate: number;
  total: number;
  balance: number;
  billed: number;
  inventoried: number;
  receivable: number;
  canceled: number;
  fiscalStatus: number;
  fiscalEvidence: number;
  specialAccounting: number;
  multiplePages: number;
  hasPieces: number;
  hasRecadv: number;
  hasLinkedAccounting: number;
  ordinaryMovement: number;
  multiWarehouse: string;
}

interface LedgerRow extends RowDataPacket {
  id: number;
  type: string;
  amount: number;
  date: string;
  reference: string;
  exchangeRate: number;
  customerId: number;
  supplierId: number;
  specialPosting: number;
}

interface InventoryRow extends RowDataPacket {
  id: number;
  type: string;
  productId: number;
  warehouse: string;
  unit: string;
  factor: number;
  quantity: number;
  invoiced: number;
  price: number;
  cost: number;
  lotId: number;
  pieces: string;
  productType: number | null;
  productUnit: string | null;
  piecesControl: number | null;
  noLayers: number | null;
  orderLineId: number;
  orderedProduct: number | null;
  orderedUnit: string | null;
  orderedFactor: number | null;
  orderId: number | null;
  orderNumber: string | null;
  orderCustomerId: number | null;
}

const zeroDate = '1900-12-31';
const cents = (value: number) => Math.round((value + Number.EPSILON) * 100);
const quantity = (value: number) => Number(value.toFixed(3));
const text = (value: string | null) => value?.trim() ?? '';

function orderReason(header: RemissionRow, rows: InventoryRow[], order: OrderProps | null) {
  if (!order || order.number !== header.orderNumber || order.customer.id !== header.customerId || order.documentKind !== 'order') {
    return 'No se encontró el pedido original de la remisión para regenerarlo.';
  }
  if (order.currencyId !== header.currencyId || order.exchangeRate !== header.exchangeRate) {
    return 'El pedido original se emitió en otra moneda o tipo de cambio.';
  }
  if (order.warehouse !== header.warehouse) return 'El pedido original pertenece a otro almacén.';

  const lines = new Map(order.lines.map((line) => [line.id, line]));
  const seen = new Set<number>();
  for (const row of rows) {
    const line = lines.get(row.orderLineId);
    if (!row.orderLineId || seen.has(row.orderLineId) || !line || row.orderId !== order.id || row.orderNumber !== order.number
      || row.orderCustomerId !== order.customer.id || row.orderedProduct !== row.productId || line.productId !== row.productId
      || row.orderedFactor !== 1 || row.orderedUnit !== row.unit || line.unit.trim() !== row.unit
      || quantity(line.fulfilled - row.invoiced) < 0) {
      return 'Las partidas de la remisión ya no se pueden vincular con las cantidades surtidas del pedido.';
    }
    seen.add(row.orderLineId);
  }
  const net = rows.reduce((sum, row) => sum + row.price * row.invoiced, 0);
  if (cents(net) > cents(order.fulfilledAmount)) return 'El importe surtido del pedido ya no cubre el importe de la remisión.';
  return null;
}

function inventoryReason(header: RemissionRow, rows: InventoryRow[], invoice: InvoiceProps, movement: MovementDocument) {
  if (!rows.length || rows.length !== invoice.lines.length || rows.length !== movement.lines.length
    || movement.header.document !== header.number || movement.header.date !== header.issuedAt
    || movement.header.warehouse !== header.warehouse || movement.header.type !== 'FA' || movement.header.inventoryFlag !== 1) {
    return 'No se pudieron verificar todas las partidas y el almacén de la remisión.';
  }
  for (const [index, row] of rows.entries()) {
    if (row.lotId !== 0 || text(row.pieces) || row.piecesControl !== 0 || row.noLayers !== 1) {
      return 'La remisión utiliza lotes, piezas o capas que requieren su propia cancelación.';
    }
    const line = invoice.lines[index]!;
    const stock = movement.lines[index]!;
    // MFACT/112 restaura AICANT con signo contrario. MFACT/29 utiliza AICANTF del pedido.
    if (row.type !== 'FA' || (row.productType !== 0 && row.productType !== 1) || row.factor !== 1
      || !row.unit || row.unit !== row.productUnit || row.warehouse !== header.warehouse
      || !Number.isFinite(row.invoiced) || row.invoiced <= 0 || quantity(row.invoiced) !== row.invoiced
      || row.quantity !== -row.invoiced || !Number.isFinite(row.cost) || row.cost < 0
      || !Number.isFinite(row.price) || row.price < 0
      || line.id !== row.id || stock.id !== row.id || line.productId !== row.productId || stock.productId !== row.productId
      || line.fulfilledQuantity !== row.invoiced || stock.quantity !== row.quantity || stock.cost !== row.cost) {
      return 'La remisión contiene kits, servicios o movimientos en una unidad que requieren otra cancelación.';
    }
  }
  return null;
}

function blockedReason(header: RemissionRow, ledger: LedgerRow[], invoice: InvoiceProps, movement: MovementDocument, rows: InventoryRow[]) {
  if (header.canceled || ledger.some(({ type }) => type === 'K' || type === 'KK')) return 'La remisión ya fue cancelada en Omnis.';
  if (ledger.some(({ type }) => type === 'PA')) return 'La remisión tiene cobros PA registrados en Omnis.';
  if (header.fiscalStatus !== 0 || header.fiscalEvidence || header.type === 'FE' || /^FE/.test(header.number)) {
    return 'El documento tiene datos fiscales o un estado de timbrado que requieren otra cancelación.';
  }
  if (header.type !== 'FA' || !/^FA\d+$/.test(header.number) || !header.ordinaryMovement
    || header.billed !== 1 || header.inventoried !== 1 || header.receivable !== 1
    || header.currencyId !== 1 || header.exchangeRate !== 1 || header.multiWarehouse !== '1'
    || !header.warehouse || !header.issuedAt || header.issuedAt === zeroDate || header.customerId <= 0) {
    return 'El documento no es una remisión ordinaria activa de venta en pesos.';
  }
  if (header.hasRecadv) return 'La remisión tiene una recepción RECADV que requiere reasignar el pedido en Omnis.';
  if (header.hasPieces || header.multiplePages) return 'La remisión usa piezas físicas o varias páginas de facturación.';
  if (header.specialAccounting || header.hasLinkedAccounting) {
    return 'La remisión tiene pagos, retenciones o movimientos contables que requieren otra cancelación.';
  }

  const [charge] = ledger;
  if (ledger.length !== 1 || !charge || charge.type !== 'FA' || charge.customerId !== header.customerId
    || charge.supplierId !== 0 || charge.exchangeRate !== 1 || charge.date !== header.issuedAt
    || text(charge.reference) !== header.orderNumber || charge.specialPosting
    || cents(header.total) <= 0 || cents(charge.amount) !== cents(header.total) || cents(header.balance) !== cents(header.total)) {
    return 'No se pudo verificar un cargo FA original íntegro y pendiente en Cuentas por Cobrar.';
  }
  return inventoryReason(header, rows, invoice, movement);
}

export class MysqlHistoricalSalesRemissionCancellationSource implements HistoricalSalesRemissionCancellationSource {
  private readonly invoices = new LegacyMysqlInvoicesDataSource();
  private readonly movements = new LegacyMysqlMovementsDataSource();
  private readonly orders = new LegacyMysqlOrdersDataSource();

  async read(id: number): Promise<SalesRemissionCancellationSource | null> {
    const [[header]] = await legacyMysqlPool.execute<RemissionRow[]>(
      `SELECT D.DNUM AS number,D.DITIPMV AS type,D.DFECHA AS issuedAt,D.CLISEQ AS customerId,
         D.DREFER AS orderNumber,D.DALMACEN AS warehouse,D.DMONEDA AS currencyId,D.DTIPOC AS exchangeRate,
         D.DCANTF AS total,D.DCANT AS balance,D.DESFACT AS billed,D.DESINV AS inventoried,D.DESCXC AS receivable,
         D.DCANCELADA AS canceled,D.DSTATUSCFD AS fiscalStatus,
         (TRIM(D.DFOLIO)<>'' OR TRIM(D.DCFDIUUID)<>'' OR D.DCFDIPACID<>0 OR TRIM(D.DAPROBFOLIOS)<>'') AS fiscalEvidence,
         (D.DNUMPAGO<>0 OR D.DFECHAPAGO<>'1900-12-31' OR D.DCONTROLPOS<>0 OR D.DPROGRAMADO<>0
           OR D.DPUNTOS<>0 OR TRIM(D.DMONEDERO)<>'' OR D.DMONEDEROVALOR<>0
           OR D.DPAGO1<>0 OR D.DPAGO2<>0 OR D.DPAGO3<>0 OR D.DPAGO4<>0 OR D.DPAGO5<>0 OR D.DPAGO6<>0
           OR D.DPAGO7<>0 OR D.DPAGO8<>0 OR D.DPAGO9<>0 OR D.DPAGO10<>0 OR D.DPAGO11<>0
           OR D.DIVARET<>0 OR D.DISRRET<>0) AS specialAccounting,
         D.DPAGINAS>1 AS multiplePages,
         EXISTS(SELECT 1 FROM FCAJAS X WHERE X.CAJFACTURA=D.DNUM) AS hasPieces,
         EXISTS(SELECT 1 FROM FYG Y WHERE Y.YGKEY=CONCAT('AdPpRdM_',D.DNUM)) AS hasRecadv,
         EXISTS(SELECT 1 FROM FBANMOV B LEFT JOIN FPOLIZA P ON P.POSEQ=B.POSEQ
           WHERE B.BADNUM=D.DNUM AND (P.POCIA=1 OR P.POSEQ IS NULL)) AS hasLinkedAccounting,
         EXISTS(SELECT 1 FROM FTIPMV T WHERE T.TICLA=D.DITIPMV AND T.TIMULTICIA=D.DMULTICIA AND T.TIMODULO=4
           AND T.TIFISCAL=0 AND T.TIAFINV=-1 AND T.TIAFCXC=1 AND T.TIAFVTS=1 AND T.TIAFBCS=0) AS ordinaryMovement,
         SUBSTRING(C.CIACOMPORTA,37,1) AS multiWarehouse
       FROM FDOC D JOIN FCIA C ON C.CIASEQ=D.DMULTICIA AND C.CIAALIAS='TUVANSA'
       WHERE D.DSEQ=? AND D.DMULTICIA=1 AND D.DEST=0 AND D.DITIPMV IN ('FA','FE')`, [id],
    );
    if (!header) return null;

    const [document, recordedMovement, [ledger], [rows]] = await Promise.all([
      this.invoices.findById(id), this.movements.findById(id),
      legacyMysqlPool.execute<LedgerRow[]>(
        `SELECT ASEQ AS id,ATIPMV AS type,ACANT AS amount,AFECHA AS date,AREFPAG AS reference,
           ATIPOC AS exchangeRate,CLISEQ AS customerId,PRVSEQ AS supplierId,
           (BASEQ<>0 OR TRIM(ABCOD)<>'' OR TRIM(APOLIZA)<>'' OR ARECIBO<>0 OR ADIFCAMBIAR<>0 OR AIVA<>0
             OR ADESCTONC<>0 OR TRIM(ANETPAY)<>'') AS specialPosting
         FROM FAX WHERE DSEQ=? ORDER BY ASEQ`, [id],
      ),
      legacyMysqlPool.execute<InventoryRow[]>(
        `SELECT A.AISEQ AS id,A.AITIPMV AS type,A.ISEQ AS productId,A.AIALMACEN AS warehouse,A.AIUNIDAD AS unit,
           A.AIFACTOR AS factor,A.AICANT AS quantity,A.AICANTF AS invoiced,A.AIPRECIO AS price,A.AICOSTO AS cost,
           A.LOSEQ AS lotId,A.AIPZAS AS pieces,I.ITIPO AS productType,I.IUM AS productUnit,
           I.ICONTROLPZAS AS piecesControl,I.INOCAPAS AS noLayers,
           A.AIPED AS orderLineId,P.ISEQ AS orderedProduct,P.PLUNIDAD AS orderedUnit,P.PLFACTOR AS orderedFactor,
           O.PESEQ AS orderId,O.PENUM AS orderNumber,O.CLISEQ AS orderCustomerId
         FROM FAXINV A LEFT JOIN FINV I ON I.ISEQ=A.ISEQ
         LEFT JOIN FPLIN P ON P.PLSEQ=A.AIPED
         LEFT JOIN FPENC O ON O.PESEQ=P.PESEQ AND O.PEMULTICIA=1
         WHERE A.DSEQ=? ORDER BY A.AISEQ`, [id],
      ),
    ]);
    if (!document || !recordedMovement) return null;
    const movement: MovementDocument = {
      ...recordedMovement, header: { ...recordedMovement.header, date: String(recordedMovement.header.date) },
    };
    const data = document.toPrimitives();
    const invoice: InvoiceProps = {
      ...data, cfdStatus: String(header.fiscalStatus),
      currency: header.currencyId === 1 ? { ...data.currency, name: 'PESOS' } : data.currency,
      lines: data.lines.map((line) => ({ ...line, pieces: Number(line.pieces) })),
    };
    const orderIds = new Set(rows.filter((row) => row.orderNumber === header.orderNumber
      && row.orderCustomerId === header.customerId).map(({ orderId }) => orderId));
    const orderId = orderIds.size === 1 ? [...orderIds][0] ?? 0 : 0;
    const order = orderId ? (await this.orders.findById(orderId))?.toPrimitives() ?? null : null;
    const reason = blockedReason(header, ledger, invoice, movement, rows);
    const regenerationReason = orderReason(header, rows, order);
    const version = createHash('sha256').update(JSON.stringify([header, ledger, rows, invoice, movement, order])).digest('hex');
    return {
      id, number: header.number, issuedAt: header.issuedAt, customerId: header.customerId,
      orderId, orderNumber: header.orderNumber, warehouse: header.warehouse, charge: header.total, invoice, movement,
      order, lineEffects: rows.map(({ orderLineId, productId, invoiced }) => ({ orderLineId, productId, quantity: invoiced })),
      hasCollection: ledger.some(({ type }) => type === 'PA'), lastCollectionReversalAt: null, alreadyRecorded: null,
      historical: { version, blockedReason: reason, orderReason: regenerationReason, baseOrder: order },
    };
  }
}
