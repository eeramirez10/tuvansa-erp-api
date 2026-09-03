import type { RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { ClientAnalyticsDataSource } from '../../domain/datasources/client-analytics-data-source.js';
import type {
  ClientAnalyticsItem,
  ClientAnalyticsSummary,
  ClientRiskLevel,
} from '../../domain/entities/client-analytics.js';
import type {
  ClientAnalyticsCriteria,
  ClientAnalyticsResult,
} from '../../domain/repositories/client-analytics-repository.js';

interface AnalyticsRow extends RowDataPacket, ClientAnalyticsItem {}

interface SummaryRow extends RowDataPacket {
  asOf: string;
  clientCount: number;
  activeClientCount: number;
  creditLimit: number;
  totalBalance: number;
  overdueBalance: number;
  notDueBalance: number;
  overdueDocumentCount: number;
  openOrderCount: number;
  openOrderAmount: number;
  agingNotDue: number;
  agingDays1To30: number;
  agingDays31To60: number;
  agingDays61To90: number;
  agingOver90: number;
}

const money = (value: number): number => Math.round(value * 100) / 100;

const analyticsBaseSql = `
  SELECT
    c.CLISEQ AS id,
    TRIM(c.CLICOD) AS code,
    TRIM(c.CLINOM) AS name,
    TRIM(c.CLISUCURSAL) AS branch,
    c.CLIBAJA = '1900-12-31' AS isActive,
    c.CLIPLAZO0 AS paymentTermDays,
    c.CLIPLAZOR AS actualPaymentTermDays,
    c.CLICREDIT AS creditLimit,
    COALESCE(d.totalBalance, 0) AS totalBalance,
    COALESCE(d.overdueBalance, 0) AS overdueBalance,
    COALESCE(d.notDueBalance, 0) AS notDueBalance,
    c.CLICREDIT - COALESCE(d.totalBalance, 0) AS availableCredit,
    CASE
      WHEN c.CLICREDIT > 0 THEN (COALESCE(d.totalBalance, 0) / c.CLICREDIT) * 100
      ELSE NULL
    END AS creditUsedPercentage,
    COALESCE(d.pendingDocumentCount, 0) AS pendingDocumentCount,
    COALESCE(d.overdueDocumentCount, 0) AS overdueDocumentCount,
    d.oldestOverdueDate,
    COALESCE(d.maximumDaysOverdue, 0) AS maximumDaysOverdue,
    NULLIF(DATE(c.CLIULTCOM), '1900-12-31') AS lastPurchaseAt,
    NULLIF(DATE(c.CLIULTPAG), '1900-12-31') AS lastPaymentAt,
    NULLIF(DATE(c.CLIULTPED), '1900-12-31') AS lastOrderAt,
    c.CLIACUMULADO AS accumulatedSales,
    COALESCE(o.openOrderCount, 0) AS openOrderCount,
    COALESCE(o.openOrderAmount, 0) AS openOrderAmount,
    COALESCE(d.agingNotDue, 0) AS agingNotDue,
    COALESCE(d.agingDays1To30, 0) AS agingDays1To30,
    COALESCE(d.agingDays31To60, 0) AS agingDays31To60,
    COALESCE(d.agingDays61To90, 0) AS agingDays61To90,
    COALESCE(d.agingOver90, 0) AS agingOver90,
    CASE
      WHEN COALESCE(d.maximumDaysOverdue, 0) > 90
        OR (c.CLICREDIT > 0 AND COALESCE(d.totalBalance, 0) > c.CLICREDIT) THEN 'critical'
      WHEN COALESCE(d.maximumDaysOverdue, 0) > 30 THEN 'overdue'
      WHEN COALESCE(d.overdueBalance, 0) > 0 THEN 'watch'
      ELSE 'healthy'
    END AS risk
  FROM fcli c
  LEFT JOIN (
    SELECT
      documentClient.CLISEQ,
      SUM(documentClient.DCANT) AS totalBalance,
      SUM(CASE WHEN documentClient.DVENCE < CURDATE() THEN documentClient.DCANT ELSE 0 END) AS overdueBalance,
      SUM(CASE WHEN documentClient.DVENCE >= CURDATE() THEN documentClient.DCANT ELSE 0 END) AS notDueBalance,
      COUNT(*) AS pendingDocumentCount,
      SUM(documentClient.DVENCE < CURDATE() AND documentClient.DCANT > 0) AS overdueDocumentCount,
      MIN(CASE WHEN documentClient.DVENCE < CURDATE() AND documentClient.DCANT > 0 THEN DATE(documentClient.DVENCE) END) AS oldestOverdueDate,
      MAX(CASE WHEN documentClient.DVENCE < CURDATE() AND documentClient.DCANT > 0 THEN DATEDIFF(CURDATE(), documentClient.DVENCE) ELSE 0 END) AS maximumDaysOverdue,
      SUM(CASE WHEN documentClient.DVENCE >= CURDATE() THEN documentClient.DCANT ELSE 0 END) AS agingNotDue,
      SUM(CASE WHEN DATEDIFF(CURDATE(), documentClient.DVENCE) BETWEEN 1 AND 30 THEN documentClient.DCANT ELSE 0 END) AS agingDays1To30,
      SUM(CASE WHEN DATEDIFF(CURDATE(), documentClient.DVENCE) BETWEEN 31 AND 60 THEN documentClient.DCANT ELSE 0 END) AS agingDays31To60,
      SUM(CASE WHEN DATEDIFF(CURDATE(), documentClient.DVENCE) BETWEEN 61 AND 90 THEN documentClient.DCANT ELSE 0 END) AS agingDays61To90,
      SUM(CASE WHEN DATEDIFF(CURDATE(), documentClient.DVENCE) > 90 THEN documentClient.DCANT ELSE 0 END) AS agingOver90
    FROM fdoc documentClient
    INNER JOIN fcli branchClient
      ON branchClient.CLISEQ = documentClient.CLISEQ
      AND UPPER(TRIM(branchClient.CLISUCURSAL)) = 'MEXICO'
    WHERE documentClient.DEST = 0
      AND documentClient.DMULTICIA = 1
      AND documentClient.DESCXC = 1
    GROUP BY documentClient.CLISEQ
  ) d ON d.CLISEQ = c.CLISEQ
  LEFT JOIN (
    SELECT
      orderClient.CLISEQ,
      COUNT(*) AS openOrderCount,
      SUM(orderClient.PECANT) AS openOrderAmount
    FROM fpenc orderClient
    INNER JOIN fcli orderBranchClient
      ON orderBranchClient.CLISEQ = orderClient.CLISEQ
      AND UPPER(TRIM(orderBranchClient.CLISUCURSAL)) = 'MEXICO'
    WHERE orderClient.PEMULTICIA = 1
      AND orderClient.PENUM LIKE 'P%'
      AND orderClient.PESTATUS = ''
      AND orderClient.PEDATECANCELED = '1900-12-31'
    GROUP BY orderClient.CLISEQ
  ) o ON o.CLISEQ = c.CLISEQ
  WHERE UPPER(TRIM(c.CLISUCURSAL)) = 'MEXICO'
`;

const reportFilter = (criteria: ClientAnalyticsCriteria) => {
  const conditions: string[] = [];
  const parameters: Array<string | number> = [];

  if (criteria.status === 'active') conditions.push('analytics.isActive = 1');
  if (criteria.status === 'inactive') conditions.push('analytics.isActive = 0');
  if (criteria.risk !== 'all') {
    conditions.push('analytics.risk = ?');
    parameters.push(criteria.risk);
  }
  if (criteria.query !== undefined) {
    conditions.push('(analytics.code LIKE ? OR analytics.name LIKE ?)');
    const query = `%${criteria.query}%`;
    parameters.push(query, query);
  }

  return {
    sql: conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`,
    parameters,
  };
};

const normalizeItem = (row: AnalyticsRow): ClientAnalyticsItem => ({
  id: row.id,
  code: row.code,
  name: row.name,
  branch: row.branch,
  isActive: Boolean(row.isActive),
  paymentTermDays: row.paymentTermDays,
  actualPaymentTermDays: row.actualPaymentTermDays,
  creditLimit: money(row.creditLimit),
  totalBalance: money(row.totalBalance),
  overdueBalance: money(row.overdueBalance),
  notDueBalance: money(row.notDueBalance),
  availableCredit: money(row.availableCredit),
  creditUsedPercentage: row.creditUsedPercentage === null
    ? null
    : money(row.creditUsedPercentage),
  pendingDocumentCount: row.pendingDocumentCount,
  overdueDocumentCount: row.overdueDocumentCount,
  oldestOverdueDate: row.oldestOverdueDate,
  maximumDaysOverdue: row.maximumDaysOverdue,
  lastPurchaseAt: row.lastPurchaseAt,
  lastPaymentAt: row.lastPaymentAt,
  lastOrderAt: row.lastOrderAt,
  accumulatedSales: money(row.accumulatedSales),
  openOrderCount: row.openOrderCount,
  openOrderAmount: money(row.openOrderAmount),
  risk: row.risk as ClientRiskLevel,
});

export class LegacyMysqlClientAnalyticsDataSource implements ClientAnalyticsDataSource {
  async getReport(criteria: ClientAnalyticsCriteria): Promise<ClientAnalyticsResult> {
    const filter = reportFilter(criteria);
    const derivedSql = `(${analyticsBaseSql}) analytics`;
    const [summaryRows] = await legacyMysqlPool.execute<SummaryRow[]>(`
      SELECT
        DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS asOf,
        COUNT(*) AS clientCount,
        COALESCE(SUM(analytics.isActive), 0) AS activeClientCount,
        COALESCE(SUM(analytics.creditLimit), 0) AS creditLimit,
        COALESCE(SUM(analytics.totalBalance), 0) AS totalBalance,
        COALESCE(SUM(analytics.overdueBalance), 0) AS overdueBalance,
        COALESCE(SUM(analytics.notDueBalance), 0) AS notDueBalance,
        COALESCE(SUM(analytics.overdueDocumentCount), 0) AS overdueDocumentCount,
        COALESCE(SUM(analytics.openOrderCount), 0) AS openOrderCount,
        COALESCE(SUM(analytics.openOrderAmount), 0) AS openOrderAmount,
        COALESCE(SUM(analytics.agingNotDue), 0) AS agingNotDue,
        COALESCE(SUM(analytics.agingDays1To30), 0) AS agingDays1To30,
        COALESCE(SUM(analytics.agingDays31To60), 0) AS agingDays31To60,
        COALESCE(SUM(analytics.agingDays61To90), 0) AS agingDays61To90,
        COALESCE(SUM(analytics.agingOver90), 0) AS agingOver90
      FROM ${derivedSql}
      ${filter.sql}
    `, filter.parameters);

    const [rows] = await legacyMysqlPool.execute<AnalyticsRow[]>(`
      SELECT analytics.*
      FROM ${derivedSql}
      ${filter.sql}
      ORDER BY
        FIELD(risk, 'critical', 'overdue', 'watch', 'healthy'),
        overdueBalance DESC,
        name
      LIMIT ? OFFSET ?
    `, [...filter.parameters, criteria.limit, criteria.offset]);

    const summary = summaryRows[0];
    const emptySummary: ClientAnalyticsSummary = {
      clientCount: 0,
      activeClientCount: 0,
      creditLimit: 0,
      totalBalance: 0,
      overdueBalance: 0,
      notDueBalance: 0,
      overdueDocumentCount: 0,
      openOrderCount: 0,
      openOrderAmount: 0,
      aging: { notDue: 0, days1To30: 0, days31To60: 0, days61To90: 0, over90: 0 },
    };

    return {
      asOf: summary?.asOf ?? '',
      summary: summary === undefined ? emptySummary : {
        clientCount: summary.clientCount,
        activeClientCount: summary.activeClientCount,
        creditLimit: money(summary.creditLimit),
        totalBalance: money(summary.totalBalance),
        overdueBalance: money(summary.overdueBalance),
        notDueBalance: money(summary.notDueBalance),
        overdueDocumentCount: summary.overdueDocumentCount,
        openOrderCount: summary.openOrderCount,
        openOrderAmount: money(summary.openOrderAmount),
        aging: {
          notDue: money(summary.agingNotDue),
          days1To30: money(summary.agingDays1To30),
          days31To60: money(summary.agingDays31To60),
          days61To90: money(summary.agingDays61To90),
          over90: money(summary.agingOver90),
        },
      },
      items: rows.map(normalizeItem),
      total: summary?.clientCount ?? 0,
    };
  }
}
