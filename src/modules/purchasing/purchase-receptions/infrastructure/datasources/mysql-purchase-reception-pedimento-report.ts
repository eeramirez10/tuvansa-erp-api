import type { RowDataPacket } from 'mysql2/promise';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { PurchaseReceptionsRepository } from '../../domain/repositories/purchase-receptions-repository.js';
import { pedimentoExpenses, readPurchaseReceptionPedimento } from './mysql-purchase-reception-pedimento.js';
import { isLocalPurchaseReceptionId } from './postgres-purchase-reception-writes.js';

interface ReportHeaderRow extends RowDataPacket {
  exchangeRate: number | null;
  volume: number | null;
  useVolume: number;
}

interface ProductRow extends RowDataPacket {
  id: number;
  piecesPerBox: number;
  unitVolume: number;
  tariffPercent: number;
}

const money = (value: number) => Number(value.toFixed(2));
const divide = (dividend: number, divisor: number) => divisor === 0 ? 0 : dividend / divisor;

export class MysqlPurchaseReceptionPedimentoReport {
  constructor(private readonly receptions: Pick<PurchaseReceptionsRepository, 'findById'>) {}

  async execute(id: number) {
    const found = await this.receptions.findById(id);
    if (!found) throw new NotFoundError('Recepción de compra');
    const receipt = found.toPrimitives();
    const productIds = [...new Set(receipt.lines.map(({ productId }) => productId).filter((productId) => productId > 0))];
    const local = isLocalPurchaseReceptionId(id);
    const [stored, [[header]], [products]] = await Promise.all([
      local ? { pedimento: receipt.pedimento ?? null, expenses: pedimentoExpenses() } : readPurchaseReceptionPedimento(id),
      legacyMysqlPool.execute<ReportHeaderRow[]>(
        `SELECT IFNULL(r.DTIPOC,1) AS exchangeRate, r.DVOLUMEN AS volume, SUBSTRING(c.CIACOMPORTA,50,1) = '1' AS useVolume
         FROM FCIA c LEFT JOIN FDOC r ON r.DSEQ = ? AND r.DMULTICIA = c.CIASEQ
         WHERE c.CIASEQ = 1`, [local ? null : id],
      ),
      productIds.length ? legacyMysqlPool.execute<ProductRow[]>(
        `SELECT ISEQ AS id, ICANTCAJA2 AS piecesPerBox, IVOLUMEN2 AS unitVolume, IPORCARANC AS tariffPercent
         FROM FINV WHERE ISEQ IN (${productIds.map(() => '?').join(',')})`, productIds,
      ) : [[]],
    ]);
    const metadata = new Map(products.map((row) => [row.id, row]));
    const exchangeRate = Number(header?.exchangeRate ?? 1);
    const netGoods = receipt.totals.subtotal - receipt.totals.discount;
    const useVolume = Boolean(header?.useVolume);
    const expenses = money(stored.expenses.reduce((sum, row) => sum + row.amount, 0));
    const vat = money(stored.expenses.reduce((sum, row) => sum + (row.vat ?? 0), 0));
    return {
      number: receipt.number,
      pedimento: stored.pedimento,
      exchangeRate,
      expenses: stored.expenses,
      totals: { expenses, vat, expensePercentage: divide(expenses, netGoods) * 100 },
      lines: receipt.lines.map(({ productId, productCode: code, price, grossPrice, invoicedQuantity: quantity }) => {
        const product = metadata.get(productId);
        const piecesPerBox = Number(product?.piecesPerBox ?? 0);
        const unitVolume = Number(product?.unitVolume ?? 0);
        const goods = price * quantity;
        // RREPEDIM calcula el volumen recibido o el importe de la partida según el comportamiento 50.
        const receivedVolume = money(useVolume ? divide(unitVolume, piecesPerBox) * quantity : goods);
        return {
          code, tariffPercent: Number(product?.tariffPercent ?? 0), convertedPrice: divide(grossPrice, exchangeRate),
          grossPrice, quantity, piecesPerBox, unitVolume, receivedVolume,
          proration: divide(receivedVolume, useVolume ? Number(header?.volume ?? 0) : netGoods) * 100,
          amount: money(divide(goods, exchangeRate)),
        };
      }),
    };
  }
}
