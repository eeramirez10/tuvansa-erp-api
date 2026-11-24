import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../shared/infrastructure/database/legacy-mysql-pool.js';

interface LabelProductRow extends RowDataPacket {
  id: number;
  extendedDescription: string;
  secondDescription: string;
  ean: string;
  upc: string;
  location: string;
}

export async function readPurchaseLabelProducts(productIds: number[]) {
  const ids = [...new Set(productIds)];
  if (!ids.length) return new Map<number, LabelProductRow>();
  const [rows] = await legacyMysqlPool.execute<LabelProductRow[]>(
    `SELECT FINV.ISEQ AS id,FINV.IEAN AS ean,FINV.IUPC AS upc,FINV.ILOCALIZ AS location,
            FINV2.I2DESCR AS extendedDescription,FINV2.I2DESCR2 AS secondDescription
     FROM FINV LEFT JOIN FINV2 ON FINV2.I2KEY=FINV.ISEQ WHERE FINV.ISEQ IN (${ids.map(() => '?').join(',')})`, ids,
  );
  return new Map(rows.map((row) => [row.id, row]));
}

export function purchaseLabelProductFields(product: LabelProductRow | undefined) {
  const clean = (value: string | null | undefined) => value?.trim() ?? '';
  return {
    extendedDescription: clean(product?.extendedDescription), secondDescription: clean(product?.secondDescription),
    ean: clean(product?.ean), upc: clean(product?.upc), location: clean(product?.location),
  };
}
