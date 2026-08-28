import { createHash } from 'node:crypto';
import { timestamp } from '../../modules/radar/content.js';
import type { CalendarOccurrence, CalendarSource, CalendarWhen, PersonalTemporalSnapshot } from '../../modules/radar/temporalSources.js';
import { active, boundedJson, calendarDate, dateAt, record, sourceSnapshot, temporalRead, TemporalReadError } from './temporalParsing.js';

export const CALENDAR_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
export interface CalendarBinding {
  readonly id: string; readonly owner: string; readonly sourceId: string; readonly sourceRevision: number;
  readonly version: number; readonly calendarId: string; readonly timeZone: string; readonly expiresAt: number;
  readonly scopes: readonly string[];
}
export interface CalendarListRequest {
  readonly calendarId: string; readonly timeMin: string; readonly timeMax: string; readonly timeZone: string;
  readonly singleEvents: true; readonly orderBy: 'startTime'; readonly showDeleted: false;
  readonly maxResults: 20; readonly eventTypes: readonly ['default']; readonly fields: string;
}
export interface BoundCalendarReader {
  readonly binding: CalendarBinding;
  /** Exactly one events.list GET. Implementations must enforce bounded bytes, no retry/redirect, and signal.
   * OAuth remains inside the broker/transport; no token-bearing URL or credential reaches this adapter.
   */
  read(request: CalendarListRequest, signal: AbortSignal): Promise<string>;
}
export interface CalendarReadAuthority {
  /** Must verify current owner-to-Google-account binding, consent/revocation and read-only grant.
   * Not an arbitrary browser-supplied reader. No default implementation or ambient ADC fallback.
   */
  authorize(source: CalendarSource, signal: AbortSignal): Promise<BoundCalendarReader>;
}
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function bindingSnapshot(binding: CalendarBinding, source: CalendarSource, now: number): CalendarBinding {
  if (!binding || binding.id !== source.bindingId || binding.owner !== source.owner || binding.sourceId !== source.id
    || binding.sourceRevision !== source.revision || !Number.isSafeInteger(binding.version) || binding.version < 1
    || !timestamp(binding.expiresAt) || binding.expiresAt <= now || binding.timeZone !== source.timeZone
    || typeof binding.calendarId !== 'string' || !/^[A-Za-z0-9@._+#-]{1,256}$/.test(binding.calendarId)
    || !Array.isArray(binding.scopes) || binding.scopes.length !== 1 || binding.scopes[0] !== CALENDAR_READ_SCOPE)
    throw new TemporalReadError('DENIED');
  return Object.freeze({ id: binding.id, owner: binding.owner, sourceId: binding.sourceId, sourceRevision: binding.sourceRevision,
    version: binding.version, calendarId: binding.calendarId, timeZone: binding.timeZone, expiresAt: binding.expiresAt,
    scopes: Object.freeze([...binding.scopes]) });
}
export function calendarListRequest(source: CalendarSource, binding: CalendarBinding, now: number): CalendarListRequest {
  const s = sourceSnapshot(source, now); if (s.kind !== 'calendar') throw new TemporalReadError('INVALID_SOURCE'); const b = bindingSnapshot(binding, s, now);
  // Whole seconds: Google ignores milliseconds in timeMin/timeMax. Parser uses the same exact bounds.
  const start = Math.floor(now / 1000) * 1000;
  return Object.freeze({ calendarId: b.calendarId, timeMin: new Date(start).toISOString(), timeMax: new Date(start + s.days * 86400000).toISOString(),
    timeZone: b.timeZone, singleEvents: true, orderBy: 'startTime', showDeleted: false, maxResults: 20,
    eventTypes: Object.freeze(['default'] as const),
    fields: 'kind,timeZone,accessRole,nextPageToken,items(id,status,eventType,summary,start,end,updated)' });
}
const instant = (value: unknown): number => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)
    || !calendarDate(value.slice(0, 10))) throw new TemporalReadError('UNAVAILABLE');
  const parsed = Date.parse(value); if (!timestamp(parsed)) throw new TemporalReadError('UNAVAILABLE'); return parsed;
};
function whenOf(event: Record<string, unknown>, source: CalendarSource, request: CalendarListRequest): CalendarWhen | null {
  if (!record(event.start) || !record(event.end)) throw new TemporalReadError('UNAVAILABLE');
  const start = event.start; const end = event.end;
  const min = instant(request.timeMin); const max = instant(request.timeMax);
  if (start.date !== undefined || end.date !== undefined) {
    if (!calendarDate(start.date) || !calendarDate(end.date) || start.date >= end.date
      || start.dateTime !== undefined || end.dateTime !== undefined) throw new TemporalReadError('UNAVAILABLE');
    if (start.date > dateAt(max - 1, source.timeZone) || end.date <= dateAt(min, source.timeZone)) return null;
    return Object.freeze({ kind: 'all-day', startDate: start.date, endDateExclusive: end.date, timeZone: source.timeZone });
  }
  const a = instant(start.dateTime); const b = instant(end.dateTime);
  if (a >= b) throw new TemporalReadError('UNAVAILABLE');
  if (a >= max || b <= min) return null;
  return Object.freeze({ kind: 'timed', start: new Date(a).toISOString(), end: new Date(b).toISOString() });
}
/** Strip unnecessary private fields, not just HTML. A snapshot is never an incremental deletion stream. */
export function parseCalendar(text: string, source: CalendarSource, request: CalendarListRequest, now: number) {
  const s = sourceSnapshot(source, now); if (s.kind !== 'calendar') throw new TemporalReadError('INVALID_SOURCE'); const data = boundedJson(text);
  if (data.kind !== 'calendar#events' || data.timeZone !== s.timeZone
    || !['reader', 'writer', 'writerWithoutPrivateAccess', 'owner'].includes(String(data.accessRole))
    || (data.items !== undefined && !Array.isArray(data.items)) || (Array.isArray(data.items) && data.items.length > 20)
    || (data.nextPageToken !== undefined && (typeof data.nextPageToken !== 'string' || !data.nextPageToken || data.nextPageToken.length > 4096)))
    throw new TemporalReadError('UNAVAILABLE');
  let partial = data.nextPageToken !== undefined;
  const items = new Map<string, CalendarOccurrence>();
  for (const event of (data.items ?? []) as unknown[]) {
    if (!record(event)) throw new TemporalReadError('UNAVAILABLE');
    if (event.status === 'cancelled') continue;
    if (event.eventType !== undefined && event.eventType !== 'default') { partial = true; continue; }
    if (!['confirmed', 'tentative'].includes(String(event.status)) || (typeof event.id !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(event.id))
      || (event.summary !== undefined && typeof event.summary !== 'string')) throw new TemporalReadError('UNAVAILABLE');
    const updated = instant(event.updated); if (updated > now) throw new TemporalReadError('UNAVAILABLE');
    const when = whenOf(event, s, request); if (!when) continue;
    const title = String(event.summary ?? '').replace(/<[^>]*>/g, '').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || '（無題の予定）';
    const id = hash([s.owner, s.id, event.id]); const version = hash([id, title, when, updated, event.status]);
    if (items.has(id) && items.get(id)!.version !== version) throw new TemporalReadError('UNAVAILABLE');
    items.set(id, Object.freeze({ id, version, title, when, status: event.status as 'confirmed' | 'tentative' }));
  }
  // Preserve Google's startTime order; all-day dates must not be guessed into UTC instants.
  return { items: Object.freeze([...items.values()]), partial };
}

/** Low-level, owner-bound read adapter; not an authenticated HTTP endpoint or autonomous worker. */
export class CalendarReadAdapter {
  constructor(private readonly authority: CalendarReadAuthority, private readonly clock: () => number = Date.now) {}
  async authorize(source: CalendarSource, signal: AbortSignal) {
    const startedAt = this.clock(); const s = sourceSnapshot(source, startedAt); active(s, startedAt, startedAt, signal);
    const reader = await temporalRead(signal, child => this.authority.authorize(s, child));
    active(s, startedAt, this.clock(), signal); const b = bindingSnapshot(reader.binding, s, this.clock());
    // Expiry may shorten; epoch/account/source changes must invalidate persisted snapshots.
    const { expiresAt, ...identity } = b;
    return Object.freeze({ stamp: hash(identity), expiresAt });
  }
  async read(source: CalendarSource, signal: AbortSignal): Promise<PersonalTemporalSnapshot<CalendarOccurrence>> {
    const startedAt = this.clock(); const s = sourceSnapshot(source, startedAt); if (s.kind !== 'calendar') throw new TemporalReadError('INVALID_SOURCE'); active(s, startedAt, startedAt, signal);
    const reader = await temporalRead(signal, child => this.authority.authorize(s, child));
    active(s, startedAt, this.clock(), signal);
    const binding = bindingSnapshot(reader.binding, s, this.clock());
    const request = calendarListRequest(s, binding, this.clock());
    const text = await temporalRead(signal, child => reader.read(request, child));
    active(s, startedAt, this.clock(), signal);
    const current = await temporalRead(signal, child => this.authority.authorize(s, child));
    const now = this.clock(); active(s, startedAt, now, signal);
    if (JSON.stringify(bindingSnapshot(current.binding, s, now)) !== JSON.stringify(binding) || binding.expiresAt <= now)
      throw new TemporalReadError('DENIED');
    const result = parseCalendar(text, s, request, now);
    return Object.freeze({ kind: 'calendar', owner: s.owner, sourceId: s.id, sourceRevision: s.revision, fetchedAt: now,
      validUntil: Math.min(now + 60000, s.consentExpiresAt, binding.expiresAt), visibility: 'owner-only', notify: false,
      attribution: 'Google Calendar', providerUrl: 'https://calendar.google.com/', ...result });
  }
}
