import type { RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { ClientBalanceDataSource } from '../../domain/datasources/client-balance-data-source.js';
import { ClientBalanceDocument } from '../../domain/entities/client-balance-document.js';
import type {
  ClientBalanceResult,
  ClientBalanceSearchCriteria,
} from '../../domain/repositories/client-balance-repository.js';

interface ClientRow extends RowDataPacket {
  id: number;
  code: string;
  name: string;
  currentBalance: number;
}

interface BalanceSummaryRow extends RowDataPacket {
  totalBalance: number;
  overdueBalance: number;
  notDueBalance: number;
  documentCount: number;
  overdueDocumentCount: number;
  notDueDocumentCount: number;
}

interface CountRow extends RowDataPacket {
  total: number;
}

interface BalanceDocumentRow extends RowDataPacket {
  id: number;
  documentNumber: string;
  documentDate: string;
  dueDate: string;
  daysOverdue: number;
  balance: number;
  amount: number;
  currencyId: number;
  currencyName: string;
  exchangeRate: number;
  reference: string;
  scheduledDate: string | null;
  branchId: number;
  deliveryReceipt: string;
  deliveryReceiptDate: string | null;
  customerOrder: string;
  internalReference: string;
  documentStatus: string;
  canceled: number;
  appliesToClientCode: string;
}

const money = (value: number): number => Math.round(value * 100) / 100;

const dueStatusCondition = (status: ClientBalanceSearchCriteria['dueStatus']): string => {
  if (status === 'overdue') return ' AND d.DVENCE < CURDATE()';
  if (status === 'notDue') return ' AND d.DVENCE >= CURDATE()';
  return '';
};

const toBalanceDocument = (row: BalanceDocumentRow): ClientBalanceDocument =>
  ClientBalanceDocument.create({
  id: row.id,
  number: row.documentNumber,
  date: row.documentDate,
  dueDate: row.dueDate,
  daysOverdue: row.daysOverdue,
  sign: row.balance < 0 ? 'credit' : 'charge',
  amountInBaseCurrency: money(Math.abs(row.balance)),
  amount: money(Math.abs(row.amount)),
  currency: {
    id: row.currencyId,
    name: row.currencyName,
  },
  exchangeRate: row.exchangeRate,
  reference: row.reference,
  scheduledDate: row.scheduledDate,
  appliesToClientCode: row.appliesToClientCode,
  branchId: row.branchId === 0 ? null : row.branchId,
  deliveryReceipt: row.deliveryReceipt,
  deliveryReceiptDate: row.deliveryReceiptDate,
  customerOrder: row.customerOrder,
  internalReference: row.internalReference,
  status: row.documentStatus,
  isCanceled: row.canceled === 1,
});

export class LegacyMysqlClientBalanceDataSource implements ClientBalanceDataSource {
  async searchByClient(
    criteria: ClientBalanceSearchCriteria,
  ): Promise<ClientBalanceResult | null> {
    const [clientRows] = await legacyMysqlPool.execute<ClientRow[]>(`
      SELECT
        CLISEQ AS id,
        CLICOD AS code,
        CLINOM AS name,
        CLISACT AS currentBalance
      FROM fcli
      WHERE CLISEQ = ?
      LIMIT 1
    `, [criteria.clientId]);

    const client = clientRows[0];
    if (client === undefined) return null;

    const [summaryRows] = await legacyMysqlPool.execute<BalanceSummaryRow[]>(`
      SELECT
        COALESCE(SUM(DCANT), 0) AS totalBalance,
        COALESCE(SUM(CASE WHEN DVENCE < CURDATE() THEN DCANT ELSE 0 END), 0) AS overdueBalance,
        COALESCE(SUM(CASE WHEN DVENCE >= CURDATE() THEN DCANT ELSE 0 END), 0) AS notDueBalance,
        COUNT(*) AS documentCount,
        COALESCE(SUM(DVENCE < CURDATE()), 0) AS overdueDocumentCount,
        COALESCE(SUM(DVENCE >= CURDATE()), 0) AS notDueDocumentCount
      FROM fdoc
      WHERE CLISEQ = ?
        AND DEST = 0
        AND DMULTICIA = 1
        AND DESCXC = 1
    `, [criteria.clientId]);

    const searchCondition = criteria.query === undefined
      ? ''
      : ' AND (d.DNUM LIKE ? OR d.DREFER LIKE ? OR d.DREFERELLOS LIKE ? OR d.DTALON LIKE ?)';
    const where = `d.CLISEQ = ?
      AND d.DEST = 0
      AND d.DMULTICIA = 1
      AND d.DESCXC = 1${dueStatusCondition(criteria.dueStatus)}${searchCondition}`;
    const searchParameters = criteria.query === undefined
      ? []
      : Array(4).fill(`%${criteria.query}%`);
    const parameters: Array<number | string> = [criteria.clientId, ...searchParameters];

    const [rows] = await legacyMysqlPool.execute<BalanceDocumentRow[]>(`
      SELECT
        d.DSEQ AS id,
        d.DNUM AS documentNumber,
        d.DFECHA AS documentDate,
        d.DVENCE AS dueDate,
        GREATEST(DATEDIFF(CURDATE(), d.DVENCE), 0) AS daysOverdue,
        d.DCANT AS balance,
        d.DCANTF AS amount,
        d.DMONEDA AS currencyId,
        CASE
          WHEN d.DMONEDA = 0 THEN ''
          WHEN d.DMONEDA = 1 THEN 'PESOS'
          WHEN d.DMONEDA = 2 THEN 'DOLARES'
          ELSE CONCAT('MONEDA ', d.DMONEDA)
        END AS currencyName,
        d.DTIPOC AS exchangeRate,
        d.DREFER AS reference,
        NULLIF(d.DFECHAPROGR, '1900-12-31') AS scheduledDate,
        d.DSUCURSAL AS branchId,
        d.DTALON AS deliveryReceipt,
        NULLIF(DATE(d.DFECHATALON), '1900-12-31') AS deliveryReceiptDate,
        d.DREFERELLOS AS customerOrder,
        d.DOTROSTXT AS internalReference,
        d.DSTATUS AS documentStatus,
        d.DEST AS canceled,
        d.DPAR0 AS appliesToClientCode
      FROM fdoc d
      WHERE ${where}
      ORDER BY d.DSEQ
      LIMIT ? OFFSET ?
    `, [...parameters, criteria.limit, criteria.offset]);

    const [countRows] = await legacyMysqlPool.execute<CountRow[]>(`
      SELECT COUNT(*) AS total
      FROM fdoc d
      WHERE ${where}
    `, parameters);

    const summary = summaryRows[0] ?? {
      totalBalance: 0,
      overdueBalance: 0,
      notDueBalance: 0,
      documentCount: 0,
      overdueDocumentCount: 0,
      notDueDocumentCount: 0,
    };

    return {
      client: {
        id: client.id,
        code: client.code,
        name: client.name,
        currentBalance: money(client.currentBalance),
      },
      summary: {
        totalBalance: money(summary.totalBalance),
        overdueBalance: money(summary.overdueBalance),
        notDueBalance: money(summary.notDueBalance),
        documentCount: summary.documentCount,
        overdueDocumentCount: summary.overdueDocumentCount,
        notDueDocumentCount: summary.notDueDocumentCount,
      },
      items: rows.map(toBalanceDocument),
      total: countRows[0]?.total ?? 0,
    };
  }
}
