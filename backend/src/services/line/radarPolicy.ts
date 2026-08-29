import { validFeedSubscription, type FeedSubscription } from '../../modules/radar/sourceRegistry.js';
import { validTemporalSource, type CalendarSource, type WeatherSource } from '../../modules/radar/temporalSources.js';
import { feedUrl } from '../radar/feedConnector.js';
import { lineKey } from './ledger.js';
export type LineFeedSetting = Omit<FeedSubscription, 'revision' | 'audience' | 'enabled' | 'consentExpiresAt'>;
export type LineWeatherSetting = Omit<WeatherSource, 'revision' | 'owner' | 'enabled' | 'consentExpiresAt'>;
export type LineCalendarSetting = Omit<CalendarSource, 'revision' | 'owner' | 'enabled' | 'consentExpiresAt'>;
export interface LineYouTubeSubscriptionsSetting { baselineAt: number; maxSubscriptions: number; maxCandidates: number; }
export interface LineRadarPolicy {
  version: 1; enabled: boolean; hourJst: number; minuteJst: number; consentExpiresAt: number;
  feeds: LineFeedSetting[]; weather: LineWeatherSetting | null;
  topics?: string[]; youtubeSubscriptions?: LineYouTubeSubscriptionsSetting | null; calendar?: LineCalendarSetting | null;
}
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => k in v);
/** Protected operator configuration, not a webhook payload. No default subscriptions, location or live schedule. */
export function parseLineRadarPolicy(value: unknown, now = Date.now()): LineRadarPolicy {
  const bad = () => { throw new Error('LINE_RADAR_CONFIG_INVALID'); };
  const legacy=['version','enabled','hourJst','minuteJst','consentExpiresAt','feeds','weather'];
  const expanded=[...legacy,'topics','youtubeSubscriptions','calendar'];
  if (!(exact(value, legacy)||exact(value,expanded))
    || value.version !== 1 || typeof value.enabled !== 'boolean' || !Number.isInteger(value.hourJst)
    || Number(value.hourJst) < 0 || Number(value.hourJst) > 23 || !Number.isInteger(value.minuteJst)
    || Number(value.minuteJst) < 0 || Number(value.minuteJst) > 59 || !Number.isSafeInteger(value.consentExpiresAt)
    || Number(value.consentExpiresAt) < 0 || Number(value.consentExpiresAt) > now + 30 * 86400000
    || !Array.isArray(value.feeds) || value.feeds.length > 3) return bad();
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
  if ('topics' in p) {
    if (!Array.isArray(p.topics)||p.topics.length>20||p.topics.some(t=>typeof t!=='string'||!t.trim()||t.trim().length>60||/[\x00-\x1f\x7f]/.test(t))
      ||new Set(p.topics.map(t=>t.trim())).size!==p.topics.length)return bad();
    if (p.youtubeSubscriptions!==null && (!exact(p.youtubeSubscriptions,['baselineAt','maxSubscriptions','maxCandidates'])
      ||!Number.isSafeInteger(p.youtubeSubscriptions.baselineAt)||p.youtubeSubscriptions.baselineAt<0||p.youtubeSubscriptions.baselineAt>now
      ||!Number.isSafeInteger(p.youtubeSubscriptions.maxSubscriptions)||p.youtubeSubscriptions.maxSubscriptions<1||p.youtubeSubscriptions.maxSubscriptions>500
      ||!Number.isSafeInteger(p.youtubeSubscriptions.maxCandidates)||p.youtubeSubscriptions.maxCandidates<1||p.youtubeSubscriptions.maxCandidates>20))return bad();
    if (p.calendar!==null && (!exact(p.calendar,['id','kind','timeZone','bindingId','days'])||p.calendar.kind!=='calendar'
      ||!validTemporalSource({...p.calendar,revision:1,enabled:true,consentExpiresAt,owner},now)))return bad();
  }
  const ids = [...p.feeds.map(s => s.id), ...(p.weather ? [p.weather.id] : []), ...(p.calendar ? [p.calendar.id] : [])];
  if (new Set(ids).size !== ids.length || (p.enabled && !ids.length && !p.youtubeSubscriptions)) return bad();
  if(p.feeds.length+(p.weather?1:0)+(p.calendar?1:0)+(p.youtubeSubscriptions?1:0)>6)return bad();
  return p;
}
export const lineRadarPolicyHash = (policy: LineRadarPolicy): string => lineKey(JSON.stringify(policy));
