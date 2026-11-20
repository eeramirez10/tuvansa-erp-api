import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { ProductClassificationCatalogDataSource } from '../../domain/datasources/product-classification-data-source.js';
import {
  productClassificationKeys,
  type ProductClassificationCatalog,
  type ProductClassificationOption,
} from '../../domain/repositories/product-classification-repository.js';

interface ProductRow extends RowDataPacket {
  id: number;
  code: string;
  description: string;
  familyCode: string;
  [field: `IFAM${string}`]: string | null;
}

type OptionRow = RowDataPacket & ProductClassificationOption;
interface LabelRow extends RowDataPacket { labels: string }
interface PolicyRow extends RowDataPacket {
  recalculateFamily: string;
  [field: `CIAFAMPAR${string}`]: string | null;
}

const productClassificationFields = productClassificationKeys.map((key) => `IFAM${key}`).join(', ');
const companyLabelFields = productClassificationKeys.slice(0, 9).map((key) => `CIAFAMPAR${key}`).join(', ');

// Adaptación de los SELECT de lectura de EINV#25C. El guardado usa PostgreSQL.
export class LegacyMysqlProductClassificationDataSource implements ProductClassificationCatalogDataSource {
  async get(productId: number): Promise<ProductClassificationCatalog | null> {
    const [products] = await legacyMysqlPool.execute<ProductRow[]>(
      `SELECT ISEQ AS id, ICOD AS code, IDESCR AS description, IFAM AS familyCode, ${productClassificationFields}
       FROM finv WHERE ISEQ = ? LIMIT 1`, [productId],
    );
    const found = products[0];
    if (!found) return null;
    const [[labels], [options], [policy]] = await Promise.all([
      legacyMysqlPool.execute<LabelRow[]>(
        `SELECT YGDAT AS labels FROM fyg WHERE YGKEY = 'ABITITFAM1' ORDER BY YGSEQ LIMIT 1`,
      ),
      legacyMysqlPool.execute<OptionRow[]>(
        `SELECT FAMSEQ AS id, TRIM(FAMT) AS \`key\`, TRIM(FAMTNUM) AS code, TRIM(FAMNUM) AS number,
                TRIM(FAMDESCR) AS description, TRIM(COALESCE(FAMPADRE, '')) AS parent
         FROM ffam WHERE FAMT IN (${productClassificationKeys.map(() => '?').join(', ')})
         ORDER BY FAMT, FAMTNUM, FAMSEQ LIMIT 32767`, productClassificationKeys,
      ),
      legacyMysqlPool.execute<PolicyRow[]>(
        `SELECT SUBSTRING(CIACOMPORTA,79,1) AS recalculateFamily, ${companyLabelFields}
         FROM fcia WHERE CIASEQ=1 LIMIT 1`,
      ),
    ]);
    const labelsByPosition = labels[0]?.labels?.split(',');
    return {
      product: { id: found.id, code: found.code, description: found.description },
      familyCode: found.familyCode?.trim() ?? '',
      recalculateFamily: policy[0]?.recalculateFamily === '1',
      assignments: Object.fromEntries(productClassificationKeys.map((key) => [key, found[`IFAM${key}`]?.trim() ?? ''])),
      labels: Object.fromEntries(productClassificationKeys.map((key, index) => [
        key,
        (labelsByPosition ? labelsByPosition[index] : policy[0]?.[`CIAFAMPAR${key}`])?.trim() ?? '',
      ])),
      options,
    };
  }
}
