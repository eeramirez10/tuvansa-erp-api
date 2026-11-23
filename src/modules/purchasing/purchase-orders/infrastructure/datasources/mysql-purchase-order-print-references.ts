import type { RowDataPacket } from 'mysql2/promise';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { isLocalPurchaseOrderId } from '../../domain/datasources/purchase-order-create-data-source.js';
import type { PurchaseOrdersRepository } from '../../domain/repositories/purchase-orders-repository.js';

interface AddressRow extends RowDataPacket {
  name?: string; taxId?: string; street?: string; number?: string; neighborhood?: string;
  city?: string; state?: string; postal?: string;
}
interface MovementRow extends RowDataPacket { format: string; adHoc: number; }
interface ProductRow extends RowDataPacket { id: number; weight: number; vatCode: number; currencyId: number; }
interface OperatorRow extends RowDataPacket { requested?: string; approved?: string; }
interface LabelProductRow extends RowDataPacket {
  id: number; extendedDescription: string; secondDescription: string; ean: string; upc: string; location: string;
}

const clean = (display: unknown) => typeof display === 'string' ? display.trim() : '';
const money = (value: number) => Number(value.toFixed(2));
const address = (row?: AddressRow) => row ? {
  name: clean(row.name), taxId: clean(row.taxId),
  address: [
    [row.street, row.number].map(clean).filter(Boolean).join(' '), clean(row.neighborhood),
    [row.city, row.state].map(clean).filter(Boolean).join(', '), row.postal ? `C.P. ${clean(row.postal)}` : '',
  ].filter(Boolean),
} : undefined;

export class MysqlPurchaseOrderPrintReferences {
  constructor(private readonly orders: Pick<PurchaseOrdersRepository, 'findById' | 'getPanel'>) {}

  async labels(id: number) {
    const found = await this.orders.findById(id);
    if (!found) throw new NotFoundError('Orden de compra');
    const order = found.toPrimitives();
    const lines = order.lines.filter(({ assigned, productId }) => assigned > 0 && productId > 0);
    if (!lines.length) return { lines: [] };
    const ids = [...new Set(lines.map(({ productId }) => productId))];
    const [rows] = await legacyMysqlPool.execute<LabelProductRow[]>(
      `SELECT FINV.ISEQ AS id, FINV.IEAN AS ean, FINV.IUPC AS upc, FINV.ILOCALIZ AS location,
        FINV2.I2DESCR AS extendedDescription, FINV2.I2DESCR2 AS secondDescription
       FROM FINV LEFT JOIN FINV2 ON FINV2.I2KEY=FINV.ISEQ
       WHERE FINV.ISEQ IN (${ids.map(() => '?').join(',')})`, ids,
    );
    const details = new Map(rows.map((row) => [row.id, row]));
    return { lines: lines.map(({ id: lineId, productId, assigned, productCode, description }) => {
      const row = details.get(productId);
      return {
        lineId, assigned, productCode, description,
        extendedDescription: clean(row?.extendedDescription), secondDescription: clean(row?.secondDescription),
        ean: clean(row?.ean), upc: clean(row?.upc), location: clean(row?.location),
      };
    }) };
  }

  async execute(id: number, confirmed: boolean) {
    const found = await this.orders.findById(id);
    if (!found) throw new NotFoundError('Orden de compra');
    const order = found.toPrimitives();
    const local = isLocalPurchaseOrderId(id);
    const movementCode = !local && /^[A-Z]{2}/.test(order.number) ? order.number.slice(0, 2) : order.number.slice(0, 1);
    const [comments, [movementRows], [companyRows], [deliveryRows], [supplierRows], [operatorRows]] = await Promise.all([
      this.orders.getPanel(id, 'comments'),
      legacyMysqlPool.execute<MovementRow[]>(
        "SELECT TIREPNAME AS format,TIADHOC AS adHoc FROM FTIPMV WHERE TICLA=? AND TIMULTICIA=1 AND TIMODULO=6 ORDER BY TISEQ LIMIT 1", [movementCode],
      ),
      legacyMysqlPool.execute<AddressRow[]>(
        `SELECT CIANAME AS name,CIARFC AS taxId,CIADIR AS street,CIANUMEXT AS number,CIACOLONIA AS neighborhood,
           CIACD AS city,CIAEDO AS state,CIACP AS postal FROM FCIA WHERE CIASEQ=1`,
      ),
      legacyMysqlPool.execute<AddressRow[]>(
        `SELECT CATDESCR AS name,CATDIR AS street,CATNUMEXT AS number,CATCOLONIA AS neighborhood,CATCD AS city,CATEDO AS state,CATCP AS postal
         FROM FALMCAT WHERE CATALM=? AND CATTIPO='' AND CATMULTICIA IN (0,1) ORDER BY CATMULTICIA DESC,CATSEQ LIMIT 1`,
        [order.warehouse],
      ),
      legacyMysqlPool.execute<AddressRow[]>(
        'SELECT PRVNOM AS name,PRVDIR AS street,PRVCOLONIA AS neighborhood,PRVCD AS city,PRVEDO AS state,PRVCP AS postal FROM FPRV WHERE PRVSEQ=?',
        [order.supplier.id],
      ),
      local ? Promise.resolve([[] as OperatorRow[]]) : legacyMysqlPool.execute<OperatorRow[]>(
        `SELECT U.USRNAME AS requested,A.USRNAME AS approved FROM FPENC P LEFT JOIN FUSERS U ON U.USRSEQ=P.PEUSRALTA
         LEFT JOIN FUSERS A ON A.USRSEQ=P.PEUSRAUT WHERE P.PESEQ=?`, [id],
      ),
    ]);
    const movement = movementRows[0];
    const reportName = movement?.format ? clean(movement.format) + (confirmed ? 'A' : '') : '';
    if (movement?.adHoc || !['QTUVANSA004', 'QTUVANSA004A'].includes(reportName)) {
      throw new ApplicationError(
        reportName ? `El formato de impresión ${reportName} no está disponible.` : 'No se ha configurado un formato para esta orden.',
        'PURCHASE_ORDER_PRINT_FORMAT_UNAVAILABLE', 422,
      );
    }
    const lines = confirmed ? order.lines.filter((line) => line.assigned > 0) : order.lines;
    const productIds = [...new Set(lines.map(({ productId }) => productId).filter((productId) => productId > 0))];
    const [productRows] = productIds.length ? await legacyMysqlPool.execute<ProductRow[]>(
      `SELECT ISEQ AS id,IPESO AS weight,IPORCIVA AS vatCode,IMONEDA AS currencyId
       FROM FINV WHERE ISEQ IN (${productIds.map(() => '?').join(',')})`, productIds,
    ) : [[]];
    const products = new Map(productRows.map((product) => [product.id, product]));
    const generalDiscount = order.discountPercentages.reduce((factor, discount) => factor * (1 - discount / 100), 1);
    const summary = comments?.summary;
    const orderCurrency = Number(summary?.currencyId ?? order.lines[0]?.currencyId ?? 0);
    const rate = Number(summary?.exchangeRate ?? 1);
    let net = 0;
    let taxable = 0;
    const lineDetails = Object.fromEntries(lines.map((line) => {
      const units = confirmed ? line.assigned : Math.abs(line.ordered);
      const product = products.get(line.productId);
      const productCurrency = product?.currencyId ?? orderCurrency;
      const listPrice = productCurrency === orderCurrency || rate <= 0
        ? line.price : orderCurrency === 1 && productCurrency === 2 ? line.price / rate : line.price * rate;
      const unitPrice = listPrice * (1 - line.discount / 100) * (confirmed ? generalDiscount : 1);
      const total = units * unitPrice;
      net += total;
      if (product?.vatCode === 0) taxable += total;
      return [line.id, { listPrice, unitPrice, total: money(total),
        ...(product ? { weight: units * product.weight } : {}) }];
    }));
    const tax = money(taxable * order.taxPercentage / 100);
    const entry = comments?.items[0];
    const terms = summary?.terms;
    const details = {
      reportName, company: address(companyRows[0]), delivery: address(deliveryRows[0]), supplier: address(supplierRows[0]),
      orderedBy: clean(operatorRows[0]?.requested), approvedBy: clean(operatorRows[0]?.approved),
      branchName: reportName === 'QTUVANSA004' ? 'SUC. MEXICO' : clean(deliveryRows[0]?.name),
      termDays: typeof terms === 'number' || (typeof terms === 'string' && terms.trim()) ? Number(terms) : undefined,
      requisition: order.supplierOrderNumber,
      currency: clean(summary?.currencyName) || order.lines[0]?.currencyName,
      comments: ['comments', 'line2', 'line3', 'line5'].map((key) => clean(entry?.[key])).filter(Boolean),
      lineDetails,
      ...(confirmed ? { totals: { subtotal: money(net), tax, total: money(net + tax) } } : {}),
    };
    return { order, details };
  }
}
