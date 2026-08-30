/** Pure Radar contracts. No connector, database, timer, conversation graph or publisher imports. */
export type RadarAudience = Readonly<{ kind: 'personal'; subjectId: string }
  | { kind: 'community'; guildId: string; channelId: string }>;
export type SourceKind = 'youtube' | 'weather' | 'calendar' | 'web';
export interface ContentItem {
  readonly id: string;
  readonly revision: number;
  readonly clusterId: string;
  readonly sourceId: string;
  readonly sourceKind: SourceKind;
  readonly sourceUrl: string;
  readonly fetchedAt: number;
  readonly publishedAt: number;
  readonly expiresAt: number;
  readonly visibility: 'public' | RadarAudience;
  readonly verification: 'source_checked' | 'unverified';
  readonly title: string;
  readonly fact: string;
  readonly metadata: readonly string[];
  readonly topicIds: readonly string[];
  readonly novelty: number;
  readonly quality: number;
}
export interface RankingContext {
  readonly audience: RadarAudience;
  readonly now: number;
  /** Explicit preferences selected in this exact audience; not inferred person profiles. */
  readonly preferences: readonly { topicId: string; weight: number }[];
}
export interface RankedCandidate {
  readonly audience: RadarAudience;
  readonly item: ContentItem;
  readonly score: number;
  /** Internal audit only. Never render personal reasons into community cards. */
  readonly matchedTopicIds: readonly string[];
}
export const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9:_-]{1,128}$/.test(v);
export const unit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
export const timestamp = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
export function audienceKey(a?: RadarAudience): string | null {
  if (a?.kind === 'personal' && validId(a.subjectId)) return JSON.stringify(['personal', a.subjectId]);
  if (a?.kind === 'community' && typeof a.guildId === 'string' && typeof a.channelId === 'string'
    && /^\d{1,25}$/.test(a.guildId) && /^\d{1,25}$/.test(a.channelId))
    return JSON.stringify(['community', a.guildId, a.channelId]);
  return null;
}
/** Display link only, never permission to fetch. Connector adapters must validate hosts/redirects/SSRF. */
export function validSourceUrl(value: string): boolean {
  return typeof value === 'string' && value.length <= 2048
    && /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9!$&'()*+,;=:%/?#._~-]*)?$/.test(value);
}
const shortText = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
export function eligibleContent(item: ContentItem, audience: RadarAudience, now: number): boolean {
  const key = audienceKey(audience);
  return !!key && timestamp(now) && !!item && validId(item.id) && validId(item.clusterId) && validId(item.sourceId)
    && Number.isSafeInteger(item.revision) && item.revision > 0
    && ['youtube', 'weather', 'calendar', 'web'].includes(item.sourceKind)
    && validSourceUrl(item.sourceUrl) && timestamp(item.fetchedAt) && timestamp(item.publishedAt)
    && timestamp(item.expiresAt) && item.fetchedAt <= now && item.publishedAt <= now && item.expiresAt > now
    && item.verification === 'source_checked' && unit(item.novelty) && unit(item.quality)
    && shortText(item.title, 180) && shortText(item.fact, 500)
    && Array.isArray(item.metadata) && item.metadata.length <= 5 && item.metadata.every(v => shortText(v, 100))
    && Array.isArray(item.topicIds) && item.topicIds.length <= 10 && item.topicIds.every(validId)
    && (item.visibility === 'public' || audienceKey(item.visibility) === key)
    // Calendar is private in the first MVP even if a connector mislabels it as public.
    && (item.sourceKind !== 'calendar' || (audience.kind === 'personal' && item.visibility !== 'public'
      && item.visibility.kind === 'personal' && audienceKey(item.visibility) === key));
}
/** Ranking does not receive a transport, schedule, approval or delivery budget. */
export function rankCandidates(items: readonly ContentItem[], context: RankingContext): readonly RankedCandidate[] {
  if (!audienceKey(context.audience) || !timestamp(context.now)) return [];
  const preferences = new Map(context.preferences.filter(p => validId(p.topicId) && unit(p.weight)).map(p => [p.topicId, p.weight]));
  const audience = Object.freeze({ ...context.audience });
  const ranked = items.filter(item => eligibleContent(item, audience, context.now)).map(original => {
    const item = Object.freeze({ ...original, visibility: original.visibility === 'public' ? 'public' as const : Object.freeze({ ...original.visibility }),
      metadata: Object.freeze([...original.metadata]), topicIds: Object.freeze([...original.topicIds]) });
    const matchedTopicIds = Object.freeze(item.topicIds.filter(id => preferences.has(id)));
    const affinity = Math.max(0, ...matchedTopicIds.map(id => preferences.get(id) ?? 0));
    const freshness = Math.max(0, 1 - (context.now - item.publishedAt) / (7 * 86400000));
    return Object.freeze({ audience, item, matchedTopicIds,
      score: affinity * 0.5 + item.novelty * 0.2 + item.quality * 0.2 + freshness * 0.1 });
  }).sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  const seen = new Set<string>();
  return Object.freeze(ranked.filter(candidate => {
    if (seen.has(candidate.item.clusterId)) return false;
    seen.add(candidate.item.clusterId); return true;
  }));
}
