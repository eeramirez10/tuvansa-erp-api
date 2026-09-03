export type ClientRiskLevel = 'healthy' | 'watch' | 'overdue' | 'critical';

export interface ClientAnalyticsItem {
  id: number;
  code: string;
  name: string;
  branch: string;
  isActive: boolean;
  paymentTermDays: number;
  actualPaymentTermDays: number;
  creditLimit: number;
  totalBalance: number;
  overdueBalance: number;
  notDueBalance: number;
  availableCredit: number;
  creditUsedPercentage: number | null;
  pendingDocumentCount: number;
  overdueDocumentCount: number;
  oldestOverdueDate: string | null;
  maximumDaysOverdue: number;
  lastPurchaseAt: string | null;
  lastPaymentAt: string | null;
  lastOrderAt: string | null;
  accumulatedSales: number;
  openOrderCount: number;
  openOrderAmount: number;
  risk: ClientRiskLevel;
}

export interface ClientAnalyticsSummary {
  clientCount: number;
  activeClientCount: number;
  creditLimit: number;
  totalBalance: number;
  overdueBalance: number;
  notDueBalance: number;
  overdueDocumentCount: number;
  openOrderCount: number;
  openOrderAmount: number;
  aging: {
    notDue: number;
    days1To30: number;
    days31To60: number;
    days61To90: number;
    over90: number;
  };
}
