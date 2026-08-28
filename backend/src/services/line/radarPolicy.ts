import { validFeedSubscription, type FeedSubscription } from '../../modules/radar/sourceRegistry.js';
import { validTemporalSource, type WeatherSource } from '../../modules/radar/temporalSources.js';
import { feedUrl } from '../radar/feedConnector.js';
import { lineKey } from './ledger.js';
export type LineFeedSetting = Omit<FeedSubscription, 'revision' | 'audience' | 'enabled' | 'consentExpiresAt'>;
export type LineWeatherSetting = Omit<WeatherSource, 'revision' | 'owner' | 'enabled' | 'consentExpiresAt'>;
export interface LineRadarPolicy {
  version: 1; enabled: boolean; hourJst: number; minuteJst: number; consentExpiresAt: number;
  feeds: LineFeedSetting[]; weather: LineWeatherSetting | null;
}
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => k in v);
/** Protected operator configuration, not a webhook payload. No default subscriptions, location or live schedule. */
export function parseLineRadarPolicy(value: unknown, now = Date.now()): LineRadarPolicy {
  const bad = () => { throw new Error('LINE_RADAR_CONFIG_INVALID'); };
  if (!exact(value, ['version','enabled','hourJst','minuteJst','consentExpiresAt','feeds','weather'])
    || value.version !== 1 || typeof value.enabled !== 'boolean' || !Number.isInteger(value.hourJst)
    || Number(value.hourJst) < 0 || Number(value.hourJst) > 23 || !Number.isInteger(value.minuteJst)
    || Number(value.minuteJst) < 0 || Number(value.minuteJst) > 59 || !Number.isSafeInteger(value.consentExpiresAt)
    || Number(value.consentExpiresAt) < 0 || Number(value.consentExpiresAt) > now + 30 * 86400000
    || !Array.isArray(value.feeds) || value.feeds.length + (value.weather === null ? 0 : 1) > 3) return bad();
  const p = structuredClone(value) as unknown as LineRadarPolicy;
  const owner = 'line:' + 'a'.repeat(64);
  // Validate shape independently of expiry: expired authorization is allowed on disk but never usable.
  const consentExpiresAt = now + 60000;
  for (const feed of p.feeds) {
    if (!exact(feed, ['id','kind','locator','articleHosts','topicIds','maxItems','retentionMs'])) return bad();
    const source = { ...feed, revision: 1, enabled: true, consentExpiresAt, audience: { kind: 'personal' as const, subjectId: owner } };
    if (!validFeedSubscription(source, source.audience, now)) return bad();
    try { feedUrl(source); } catch { return bad(); }
  }
  if (p.weather !== null && (!exact(p.weather, ['id','kind','timeZone','latitudeTenth','longitudeTenth'])
    || p.weather.kind !== 'weather' || !validTemporalSource({ ...p.weather, revision: 1, enabled: true, consentExpiresAt, owner }, now))) return bad();
  const ids = [...p.feeds.map(s => s.id), ...(p.weather ? [p.weather.id] : [])];
  if (new Set(ids).size !== ids.length || (p.enabled && !ids.length)) return bad();
  return p;
}
export const lineRadarPolicyHash = (policy: LineRadarPolicy): string => lineKey(JSON.stringify(policy));
