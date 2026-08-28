import { timestamp, validId } from '../../modules/radar/content.js';
import { validTemporalSource, type TemporalSource } from '../../modules/radar/temporalSources.js';
import type { TemporalCatalogEntry, TemporalGrant, TemporalSnapshot } from '../../modules/radar/catalogVersion.js';
import { calendarDate, dateAt, nextDate } from './temporalParsing.js';
import { PersonalRadarError } from './radarAccess.js';
const fail = (): never => { throw new PersonalRadarError('UNAVAILABLE'); };
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: object, expected: string[]) => Object.keys(v).length === expected.length && Object.keys(v).every(k => expected.includes(k));
const hex = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const temporalSourceShape = (s: TemporalSource, owner: string) => !!s && s.owner === owner && typeof s.enabled === 'boolean'
  && s.consentExpiresAt > 0 && validTemporalSource({ ...s, enabled: true }, s.consentExpiresAt - 1);
export const temporalActive = (s: TemporalSource | null, owner: string, now: number): s is TemporalSource => !!s
  && s.owner === owner && validTemporalSource(s, now);
export function checkedGrant(value: TemporalGrant, now: number): TemporalGrant {
  if (!object(value) || !keys(value, ['stamp', 'expiresAt']) || !hex(value.stamp) || !timestamp(value.expiresAt) || value.expiresAt <= now) return fail();
  return Object.freeze({ stamp: value.stamp, expiresAt: value.expiresAt });
}
/** Revalidate persisted/connector data at the trust boundary; no public-card conversion. */
export function checkedTemporalSnapshot(value: unknown, source: TemporalSource, now: number): TemporalSnapshot {
  if (!object(value) || !temporalSourceShape(source, source.owner)
    || !keys(value, ['kind','owner','sourceId','sourceRevision','fetchedAt','validUntil','visibility','notify','partial','attribution','providerUrl','items', ...(source.kind === 'weather' ? ['licenseUrl'] : [])])
    || value.kind !== source.kind || value.owner !== source.owner || value.sourceId !== source.id || value.sourceRevision !== source.revision
    || !timestamp(value.fetchedAt) || value.fetchedAt > now || !timestamp(value.validUntil) || value.validUntil <= now
    || value.validUntil > Math.min(source.consentExpiresAt, value.fetchedAt + (source.kind === 'weather' ? 900000 : 60000))
    || value.visibility !== 'owner-only' || value.notify !== false || typeof value.partial !== 'boolean'
    || typeof value.attribution !== 'string' || value.attribution.length > 256 || !Array.isArray(value.items)) return fail();
  if (source.kind === 'weather') {
    if (value.providerUrl !== 'https://open-meteo.com/' || value.licenseUrl !== 'https://creativecommons.org/licenses/by/4.0/'
      || value.attribution !== 'Weather data by Open-Meteo.com (CC BY 4.0); selected daily fields, values unchanged' || value.items.length !== 3) return fail();
    const codes = [0,1,2,3,45,48,51,53,55,56,57,61,63,65,66,67,71,73,75,77,80,81,82,85,86,95,96,99];
    const nullable = (n: unknown, lo: number, hi: number) => n === null || typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;
    for (const [i, day] of value.items.entries()) {
      if (!object(day) || !keys(day, ['date','weatherCode','minimumC','maximumC','precipitationPercent'])
        || day.date !== nextDate(dateAt(value.fetchedAt, source.timeZone), i)
        || !(day.weatherCode === null || codes.includes(day.weatherCode)) || !nullable(day.minimumC,-100,70)
        || !nullable(day.maximumC,-100,70) || !nullable(day.precipitationPercent,0,100)
        || (day.minimumC !== null && day.maximumC !== null && day.minimumC > day.maximumC)) return fail();
    }
    if (value.partial !== value.items.some((d: Record<string, unknown>) => Object.values(d).some(v => v === null))) return fail();
  } else {
    if (value.providerUrl !== 'https://calendar.google.com/' || value.attribution !== 'Google Calendar' || value.items.length > 20) return fail();
    const ids = new Set<string>();
    for (const event of value.items) {
      if (!object(event) || !keys(event, ['id','version','title','when','status']) || !hex(event.id) || !hex(event.version) || ids.has(event.id)
        || typeof event.title !== 'string' || !event.title.trim() || event.title.length > 180 || /[<>\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(event.title)
        || !['confirmed','tentative'].includes(event.status) || !object(event.when)) return fail();
      ids.add(event.id); const w = event.when;
      if (w.kind === 'all-day') {
        if (!keys(w,['kind','startDate','endDateExclusive','timeZone']) || !calendarDate(w.startDate) || !calendarDate(w.endDateExclusive)
          || w.startDate >= w.endDateExclusive || w.timeZone !== source.timeZone) return fail();
      } else if (w.kind === 'timed') {
        const instant = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
        if (!keys(w,['kind','start','end']) || !instant(w.start) || !instant(w.end) || w.start >= w.end) return fail();
      } else return fail();
    }
  }
  return structuredClone(value) as TemporalSnapshot;
}
export function temporalEntryShape(entry: TemporalCatalogEntry, owner: string): boolean {
  try {
    if (!object(entry) || !keys(entry,['id','source','snapshot']) || !validId(entry.id)) return false;
    if (entry.source === null) return entry.snapshot === null;
    if (!temporalSourceShape(entry.source, owner) || entry.source.id !== entry.id) return false;
    if (entry.snapshot === null) return true;
    if (!object(entry.snapshot) || !keys(entry.snapshot,['content','grant'])) return false;
    const c = entry.snapshot.content; if (!object(c)) return false;
    checkedTemporalSnapshot(c, entry.source, c.fetchedAt);
    const grant = checkedGrant(entry.snapshot.grant, c.fetchedAt);
    return c.validUntil <= grant.expiresAt;
  } catch { return false; }
}
export function temporalVisible(entry: TemporalCatalogEntry, owner: string, now: number): boolean {
  return temporalActive(entry.source, owner, now) && !!entry.snapshot && entry.snapshot.content.validUntil > now
    && entry.snapshot.grant.expiresAt > now && (entry.source.kind !== 'weather'
      || dateAt(entry.snapshot.content.fetchedAt, entry.source.timeZone) === dateAt(now, entry.source.timeZone));
}
