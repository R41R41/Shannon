import { timestamp, validId } from './content.js';

/** Personal context has its own contract. It is not a public feed record or a Discord draft. */
interface PersonalSource {
  readonly id: string;
  readonly revision: number;
  readonly owner: string;
  readonly enabled: boolean;
  readonly consentExpiresAt: number;
  readonly timeZone: string;
}
export interface WeatherSource extends PersonalSource {
  readonly kind: 'weather';
  /** Explicit coarse coordinates, in tenths of degrees. Never device-derived precise location. */
  readonly latitudeTenth: number;
  readonly longitudeTenth: number;
}
export interface CalendarSource extends PersonalSource {
  readonly kind: 'calendar';
  /** Server-owned binding reference. Never an OAuth token, URL, email, or client-selected calendar ID. */
  readonly bindingId: string;
  readonly days: number;
}
export type TemporalSource = WeatherSource | CalendarSource;
export const validTimeZone = (zone: unknown): zone is string => {
  if (typeof zone !== 'string' || zone.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(zone)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0); return true; } catch { return false; }
};
export function validTemporalSource(s: TemporalSource, now: number): boolean {
  if (!s || !validId(s.id) || !Number.isSafeInteger(s.revision) || s.revision < 1
    || typeof s.owner !== 'string' || !/^firebase:[a-f0-9]{64}$/.test(s.owner) || s.enabled !== true || !timestamp(now)
    || !timestamp(s.consentExpiresAt) || s.consentExpiresAt <= now || !validTimeZone(s.timeZone)) return false;
  const shared = ['id', 'revision', 'owner', 'enabled', 'consentExpiresAt', 'timeZone', 'kind'];
  const keys = s.kind === 'weather' ? [...shared, 'latitudeTenth', 'longitudeTenth'] : [...shared, 'bindingId', 'days'];
  if (Object.keys(s).length !== keys.length || Object.keys(s).some(k => !keys.includes(k))) return false;
  return s.kind === 'weather' ? Number.isInteger(s.latitudeTenth) && Math.abs(s.latitudeTenth) <= 900
    && Number.isInteger(s.longitudeTenth) && Math.abs(s.longitudeTenth) <= 1800
    : s.kind === 'calendar' && validId(s.bindingId) && Number.isInteger(s.days) && s.days >= 1 && s.days <= 7;
}
export interface WeatherDay {
  readonly date: string;
  readonly weatherCode: number | null;
  readonly minimumC: number | null;
  readonly maximumC: number | null;
  readonly precipitationPercent: number | null;
}
export type CalendarWhen = Readonly<{ kind: 'timed'; start: string; end: string }>
  | Readonly<{ kind: 'all-day'; startDate: string; endDateExclusive: string; timeZone: string }>;
export interface CalendarOccurrence {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly when: CalendarWhen;
  readonly status: 'confirmed' | 'tentative';
}
export interface PersonalTemporalSnapshot<T> {
  readonly kind: 'weather' | 'calendar';
  readonly owner: string;
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly fetchedAt: number;
  readonly validUntil: number;
  readonly visibility: 'owner-only';
  readonly notify: false;
  readonly partial: boolean;
  readonly attribution: string;
  readonly licenseUrl?: string;
  readonly providerUrl: string;
  readonly items: readonly T[];
}
