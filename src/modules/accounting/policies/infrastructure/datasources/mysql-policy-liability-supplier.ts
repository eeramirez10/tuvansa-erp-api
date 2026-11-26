import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { PolicyLiabilitySupplier } from '../../domain/datasources/policy-liability-data-source.js';

interface SupplierRow extends RowDataPacket {
  id: number;
  code: string;
  name: string;
  accountCode: string;
  terms: number;
  currency: number;
  exchangeRate: number;
}

export async function mysqlPolicyLiabilitySupplier(code: string): Promise<PolicyLiabilitySupplier | null> {
  // Derivada de EPASIV#13/4. El cargo toma moneda y plazo de FPRV y paridad de FCIA.
  const [rows] = await legacyMysqlPool.execute<SupplierRow[]>(
    `SELECT p.PRVSEQ AS id,TRIM(p.PRVCOD) AS code,TRIM(p.PRVNOM) AS name,
          TRIM(p.PRVCTA) AS accountCode,p.PRVPLAZO AS terms,p.PRVMONEDA AS currency,
          CASE p.PRVMONEDA WHEN 1 THEN c.CIATIP1 WHEN 2 THEN c.CIATIP2 END AS exchangeRate
     FROM FPRV p JOIN FCIA c ON c.CIASEQ=1 AND c.CIAALIAS='TUVANSA'
     WHERE p.PRVCOD=? AND p.PRVBAJA='1900-12-31' LIMIT 2`, [code],
  );
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row || (row.currency !== 1 && row.currency !== 2) || !row.accountCode
    || !Number.isInteger(row.terms) || row.terms < 0 || row.terms > 999
    || !Number.isFinite(row.exchangeRate) || row.exchangeRate <= 0) return null;
  return { id: row.id, code: row.code, name: row.name, accountCode: row.accountCode,
    terms: row.terms, currency: row.currency, exchangeRate: row.exchangeRate };
}
