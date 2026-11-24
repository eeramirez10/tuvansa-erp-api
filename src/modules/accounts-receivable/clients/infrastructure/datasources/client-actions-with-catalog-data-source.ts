import type { ClientBlockStatus, ClientEvent } from '../../domain/entities/client-action.js';
import type { ClientActionCriteria } from '../../domain/repositories/client-actions-repository.js';
import { LegacyMysqlClientActionsDataSource } from './legacy-mysql-client-actions-data-source.js';
import { clientCatalogBlockEvent, clientCatalogRecord } from './postgres-client-catalog.js';

const localEvent = (event: Pick<ClientEvent, 'id' | 'date' | 'title' | 'description' | 'key'>): ClientEvent => ({
  ...event, followUpAt: null, dueAt: null, type: '', responsible: '', requestedBy: '', release: 0,
  importance: 0, complexity: 0, done: false, project: '', number: '', invoice: '', cost: 0, morning: false,
  executedBy: '', secondaryDone: false, initialFollowUpAt: null, initialDueAt: null, branch: '', extra: false, department: 0,
});

const mergeBlockEvent = (local: ClientBlockStatus['event'], native: ClientBlockStatus['event']) => local && native ? {
  ...local, id: native.id, description: [native.description, local.description].filter(Boolean).join('\r'),
} : local ?? native;

export class ClientActionsWithCatalogDataSource extends LegacyMysqlClientActionsDataSource {
  override async findBlockStatus(clientId: number) {
    const record = await clientCatalogRecord(clientId);
    if (!record) return super.findBlockStatus(clientId);
    if (record.deleted) return null;
    const base = record.legacy ? await super.findBlockStatus(clientId) : null;
    if (record.legacy && !base) return null;
    const { id, code, name, indicators } = record.document;
    const event = await clientCatalogBlockEvent(clientId);
    const blockedAt = record.blocked === null ? base?.payload.blockStatus.blockedAt ?? null : record.blockedAt;
    return {
      client: { id, code, name, currentBalance: base?.client.currentBalance ?? record.document.totals.currentBalance },
      payload: { blockStatus: {
        blocked: blockedAt !== null, blockedAt, event: mergeBlockEvent(event, base?.payload.blockStatus.event ?? null),
        hasEvents: event !== null || Boolean(base?.payload.blockStatus.hasEvents ?? indicators.hasEvents),
      } },
    };
  }

  override async findEvents(criteria: ClientActionCriteria) {
    const record = await clientCatalogRecord(criteria.clientId);
    if (!record) return super.findEvents(criteria);
    if (record.deleted) return null;
    const event = await clientCatalogBlockEvent(criteria.clientId);
    const base = record.legacy ? await super.findEvents(criteria, event?.key) : null;
    if (record.legacy && !base) return null;
    const { id, code, name } = record.document;
    const events = base?.payload.events ?? [];
    const total = Number(base?.total ?? 0);
    if (event && total >= criteria.offset && total < criteria.offset + criteria.limit) {
      const native = record.legacy ? (await super.findBlockStatus(criteria.clientId))?.payload.blockStatus.event : null;
      events.push(localEvent(mergeBlockEvent(event, native ?? null) ?? event));
    }
    return { client: { id, code, name, currentBalance: base?.client.currentBalance ?? record.document.totals.currentBalance },
      payload: { events }, total: total + Number(event !== null) };
  }
}
