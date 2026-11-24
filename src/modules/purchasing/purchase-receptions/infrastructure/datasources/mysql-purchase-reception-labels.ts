import type { RowDataPacket } from 'mysql2/promise';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { purchaseLabelProductFields, readPurchaseLabelProducts } from '../../../shared/mysql-purchase-label-products.js';
import type { PurchaseReceptionsRepository } from '../../domain/repositories/purchase-receptions-repository.js';

type LabelFormat = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';

export class MysqlPurchaseReceptionLabels {
  constructor(private readonly receptions: Pick<PurchaseReceptionsRepository, 'findById'>) {}

  async execute(id: number) {
    const found = await this.receptions.findById(id);
    if (!found) throw new NotFoundError('Recepción de compra');
    const { cancelled, lines: receiptLines } = found.toPrimitives();
    const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & { format: LabelFormat }>>(
      `SELECT DISTINCT RIGHT(YGKEY,1) AS format FROM FYG
       WHERE YGKEY IN ('PCL_Z201_BIA','PCL_Z201_BIB','PCL_Z201_BIC','PCL_Z201_BID','PCL_Z201_BIE','PCL_Z201_BIF')
       AND YGDAT<>''
       AND EXISTS (SELECT 1 FROM FCIA WHERE CIASEQ=1 AND SUBSTRING(CIACOMPORTA,74,1)='1')
       ORDER BY format`,
    );
    if (!rows.length) throw new ApplicationError(
      'No hay formatos de etiquetas configurados para esta recepción.', 'PURCHASE_RECEPTION_LABELS_UNAVAILABLE', 422,
    );
    const lines = cancelled ? [] : receiptLines.filter(({ invoicedQuantity, productId }) => invoicedQuantity > 0 && productId > 0);
    const products = await readPurchaseLabelProducts(lines.map(({ productId }) => productId));
    return {
      formats: rows.map(({ format }) => format),
      lines: lines.map(({ id: lineId, productId, invoicedQuantity: quantity, productCode, description }) => ({
        lineId, quantity, productCode, description, ...purchaseLabelProductFields(products.get(productId)),
      })),
    };
  }
}
