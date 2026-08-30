import { MAX_AUDIT_EVENTS, type CatalogAudit } from './catalog.js';
import { timestamp, validId } from './content.js';

/** Technical retention ceiling, not a promise to retain every event for seven days. */
export const RADAR_AUDIT_RETENTION_MS = 7 * 86400000;
const actions = ['configure', 'revoke', 'collect', 'reserve', 'collect_failed', 'maintain'];
const outcomes = ['failed', 'cancelled', 'expired', 'conflict', 'recovered'];
const fields = ['revision', 'at', 'sourceId', 'action', 'attemptId', 'outcome', 'removed', 'added', 'updated', 'unchanged'];
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;

/** A contiguous suffix of committed owner revisions. Empty legacy history is explicitly incomplete. */
export function validCatalogAudit(events: readonly CatalogAudit[], revision: number): boolean {
  return Array.isArray(events) && events.length <= MAX_AUDIT_EVENTS && events.every((e, i) => !!e
    && Object.keys(e).every(k => fields.includes(k)) && e.revision === revision - events.length + i + 1
    && count(e.revision) && e.revision > 0 && timestamp(e.at) && (!i || events[i - 1].at <= e.at)
    && validId(e.sourceId) && actions.includes(e.action)
    && [e.added, e.updated, e.unchanged].every(count)
    && (e.removed === undefined || count(e.removed))
    && (e.attemptId === undefined || validId(e.attemptId))
    && (e.outcome === undefined || outcomes.includes(e.outcome)));
}

export function retainedAudit(events: readonly CatalogAudit[], now: number): readonly CatalogAudit[] {
  if (!timestamp(now) || events.some(e => e.at > now)) throw new Error('RADAR_AUDIT_CLOCK');
  return events.filter(e => e.at > now - RADAR_AUDIT_RETENTION_MS).slice(-MAX_AUDIT_EVENTS);
}

export function appendCatalogAudit(events: readonly CatalogAudit[], event: CatalogAudit): readonly CatalogAudit[] {
  return [...retainedAudit(events, event.at), event].slice(-MAX_AUDIT_EVENTS);
}

/** No owner identity, content, URL, token or raw error leaves this projection. */
export function catalogAuditView(events: readonly CatalogAudit[], revision: number, now: number) {
  const retained = retainedAudit(events, now);
  const omittedThroughRevision = retained.length ? retained[0].revision - 1 : revision;
  return { revision, omittedThroughRevision, completeFromRevisionOne: omittedThroughRevision === 0,
    retentionMs: RADAR_AUDIT_RETENTION_MS, capacity: MAX_AUDIT_EVENTS,
    events: retained.map(e => ({ revision: e.revision, at: e.at, sourceId: e.sourceId, action: e.action,
      added: e.added, updated: e.updated, unchanged: e.unchanged,
      ...(e.attemptId === undefined ? {} : { attemptId: e.attemptId }),
      ...(e.outcome === undefined ? {} : { outcome: e.outcome }),
      ...(e.removed === undefined ? {} : { removed: e.removed }) })) };
}
