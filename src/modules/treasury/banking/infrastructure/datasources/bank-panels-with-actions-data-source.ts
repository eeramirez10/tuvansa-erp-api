import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { BankAccountsDataSource } from '../../domain/datasources/bank-accounts-data-source.js';
import type { BankPanelSettingsDataSource } from '../../domain/datasources/bank-panel-settings-data-source.js';
import type { BankPanelKey, BankPanelOptions, BankPanelResponse } from '../../domain/repositories/bank-panels-repository.js';
import { BankPanelsWithLocalPostingsDataSource } from './banks-with-local-postings-data-source.js';
import { bankLedgerWithWebPostings } from './bank-ledger-postings.js';
import { readBankTransit } from './bank-transit-reads.js';

const classifierColumns = Array.from({ length: 9 }, (_, index) => `BPAR${index + 1}`);
type ClassifierGroup = { type: string; items: { code: string; description: string; parent: string }[] };

export class BankPanelsWithActionsDataSource extends BankPanelsWithLocalPostingsDataSource {
  constructor(accounts: BankAccountsDataSource, private readonly settings: BankPanelSettingsDataSource) {
    super(accounts);
  }

  override async getPanel(id: number, key: BankPanelKey, options: BankPanelOptions): Promise<BankPanelResponse> {
    const panel = await super.getPanel(id, key, options);
    if (!panel.available) return panel;
    if (key === 'classifiers') return this.classifiers(id, panel);
    if (key === 'authorization-review') return this.review(id, panel);
    if (key === 'general-ledger' || key === 'cost-center-ledger') {
      const scope = key === 'cost-center-ledger' ? options.costCenter : '';
      return this.budget(id, scope, panel);
    }
    return panel;
  }

  private async classifiers(id: number, panel: BankPanelResponse) {
    const [local, [rows]] = await Promise.all([
      this.settings.read<string[]>({ accountId: id, action: 'classifiers', scope: '' }),
      legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT ${classifierColumns.join(',')} FROM FBENC WHERE BSEQ=? LIMIT 1`, [id],
      ),
    ]);
    const codes = local?.values ?? classifierColumns.map((field) => String(rows[0]?.[field] ?? '').trim());
    return {
      ...panel, readOnly: !this.settings.writable(),
      source: [...panel.source, 'FBENC', ...(local ? ['bank_panel_settings'] : [])],
      items: (panel.items as ClassifierGroup[]).map((group, index) => ({ ...group, value: codes[index] ?? '' })),
      summary: { ...panel.summary, revision: local?.revision ?? 0 },
    };
  }

  private async budget(id: number, scope: string, panel: BankPanelResponse) {
    const base = panel.items as Record<string, unknown>[];
    const [local, ledger] = await Promise.all([
      this.settings.read<number[]>({ accountId: id, action: 'budget', scope }),
      scope && !/^\d+$/.test(scope) ? { items: base, years: [], webPostings: false }
        : bankLedgerWithWebPostings(id, base, scope ? Number(scope) : null),
    ]);
    const centers = Array.isArray(panel.summary?.centers) ? panel.summary.centers as { code: string }[] : [];
    const budgetEditable = this.settings.writable() && (scope === '' || centers.some(({ code }) => String(code).trim() === scope));
    return {
      ...panel, readOnly: !budgetEditable, source: [...panel.source, ...(local ? ['bank_panel_settings'] : []),
        ...(ledger.webPostings ? (scope ? ['manual_accounting_policy_lines']
          : ['supplier_payments', 'customer_collections', 'bank_transfer_movements', 'manual_accounting_policy_lines']) : [])],
      items: ledger.items.map((row, index) =>
        local && index < 12 ? { ...row, budget: local.values[index] ?? 0 } : row),
      summary: { ...panel.summary, budgetEditable, years: ledger.years, revision: local?.revision ?? 0 },
    };
  }

  private async review(id: number, panel: BankPanelResponse) {
    const [stored, transit] = await Promise.all([
      this.settings.read<number[]>({ accountId: id, action: 'review', scope: '' }),
      readBankTransit(1, id),
    ]);
    const reviewed = new Set(stored?.values ?? []);
    const transitMarks = new Map(transit.map((mark) => [mark.movementId, mark.inTransit]));
    const items = (panel.items as Record<string, unknown>[]).map((row) => {
      if (typeof row.movementId !== 'number' || row.policyStatus !== 0 || (row.mode && row.applied !== 1)) return row;
      const marked = reviewed.has(row.movementId);
      const inTransit = transitMarks.get(row.movementId) ?? row.inTransit === '*';
      return { ...row, canReview: !marked && this.settings.writable(), reviewed: marked,
        authorized: marked ? '*' : row.authorized, inTransit: inTransit ? '*' : '' };
    });
    return {
      ...panel, items, readOnly: !items.some((row) => row.canReview === true),
      source: [...panel.source, ...(stored ? ['bank_panel_settings'] : []), ...(transit.length ? ['bank_reconciliation_transit'] : [])],
      summary: { ...panel.summary, revision: stored?.revision ?? 0 },
    };
  }
}
