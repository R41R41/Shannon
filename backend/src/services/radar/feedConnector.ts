import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { audienceKey, eligibleContent, type ContentItem } from '../../modules/radar/content.js';
import { validFeedSubscription, type FeedSubscription, type FeedRecord } from '../../modules/radar/sourceRegistry.js';
import { FeedReadError, MAX_FEED_BYTES, publicFeedUrl, type FeedHttpPort } from './safeFeedHttp.js';

export type { FeedRecord } from '../../modules/radar/sourceRegistry.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value: string, max: number) => value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
export function feedUrl(source: FeedSubscription): string {
  const url = publicFeedUrl(source.kind === 'youtube'
    ? `https://www.youtube.com/feeds/videos.xml?channel_id=${source.locator}` : source.locator);
  // First Web adapter accepts public, query-free feed endpoints only, never credential/signed feed links.
  if (source.kind === 'web' && url.search) throw new FeedReadError('target');
  return url.href;
}
export function articleUrl(raw: string, source: FeedSubscription): string {
  const url = publicFeedUrl(raw);
  if (!source.articleHosts.includes(url.hostname)) throw new FeedReadError('target');
  for (const name of [...url.searchParams.keys()]) {
    if (/token|secret|password|signature|credential|^(?:key|api_key|auth|sig)$/i.test(name)) throw new FeedReadError('target');
    if (/^utm_/i.test(name)) url.searchParams.delete(name);
  }
  return url.href;
}
/** Only feed metadata is verified; this does not fact-check the linked article or infer live schedules. */
export function parseFeed(xml: string, source: FeedSubscription, now: number): readonly FeedRecord[] {
  if (!validFeedSubscription(source, source.audience, now)) throw new FeedReadError('target');
  if (Buffer.byteLength(xml, 'utf8') > MAX_FEED_BYTES) throw new FeedReadError('size');
  if (/<!DOCTYPE|<!ENTITY|\x00/i.test(xml)) throw new FeedReadError('format');
  const $ = load(xml, { xml: true });
  const root = $.root().children();
  if (root.length !== 1 || !['feed', 'rss'].includes(root[0].tagName)) throw new FeedReadError('format');
  const atom = root[0].tagName === 'feed';
  if (source.kind === 'youtube' && !atom) throw new FeedReadError('format');
  const entries = atom ? root.children('entry') : root.children('channel').children('item');
  const records: FeedRecord[] = []; const seen = new Set<string>();
  const fetchedUrl = feedUrl(source);
  entries.slice(0, 100).each((_index, entry) => {
    if (records.length >= source.maxItems) return;
    const child = (name: string) => $(entry).children().filter((_i, node) => node.tagName === name).first().text();
    const title = text(child('title'), 180);
    const publishedAt = Date.parse(child(atom ? 'published' : 'pubDate'));
    const updatedRaw = atom ? child('updated') : '';
    const updatedAt = updatedRaw ? Date.parse(updatedRaw) : publishedAt;
    if (!title || !Number.isSafeInteger(publishedAt) || !Number.isSafeInteger(updatedAt)
      || publishedAt < 0 || updatedAt < publishedAt || updatedAt > now) return;
    let url: string; let externalId: string;
    try {
      if (source.kind === 'youtube') {
        externalId = child('yt:videoId');
        if (child('yt:channelId') !== source.locator || !/^[A-Za-z0-9_-]{11}$/.test(externalId)) return;
        url = articleUrl(`https://www.youtube.com/watch?v=${externalId}`, source);
      } else {
        const rawLink = atom ? $(entry).children('link').filter((_i, node) => !$(node).attr('rel') || $(node).attr('rel') === 'alternate').first().attr('href') : child('link');
        if (!rawLink) return;
        url = articleUrl(rawLink.trim(), source);
        externalId = text(child(atom ? 'id' : 'guid') || url, 512);
      }
    } catch { return; }
    const entityKey = hash([audienceKey(source.audience), source.id, externalId]);
    const versionHash = hash([externalId, title, url, publishedAt, updatedAt]);
    const clusterId = hash(url);
    if (seen.has(clusterId)) return;
    const content: ContentItem = Object.freeze({ id: hash([entityKey, versionHash]), revision: 1, clusterId,
      sourceId: source.id, sourceKind: source.kind, sourceUrl: url, fetchedAt: now, publishedAt,
      expiresAt: Math.min(updatedAt + source.retentionMs, source.consentExpiresAt), visibility: 'public',
      verification: 'source_checked', title,
      fact: source.kind === 'youtube' ? '登録チャンネルのフィードに掲載された動画です。' : '登録ソースのフィードに掲載された項目です。',
      metadata: Object.freeze([new Date(publishedAt).toISOString()]), topicIds: Object.freeze([...source.topicIds]),
      novelty: 0, quality: 0.5 });
    // Novelty/quality are conservative placeholders until a catalogue/history and source review are connected.
    if (!eligibleContent(content, source.audience, now)) return;
    seen.add(clusterId);
    records.push(Object.freeze({ content, provenance: Object.freeze({ entityKey, versionHash, externalId,
      sourceRevision: source.revision, fetchedUrl, fetchedAt: now, publishedAt, updatedAt }) }));
  });
  return Object.freeze(records);
}
export interface FeedConnectorPort { read(source: FeedSubscription, signal: AbortSignal): Promise<readonly FeedRecord[]>; }
export class PublicFeedConnector implements FeedConnectorPort {
  constructor(private readonly http: FeedHttpPort, private readonly clock: () => number = Date.now) {}
  async read(source: FeedSubscription, signal: AbortSignal): Promise<readonly FeedRecord[]> {
    if (signal.aborted || !validFeedSubscription(source, source.audience, this.clock())) throw new FeedReadError('aborted');
    const xml = await this.http.get(feedUrl(source), signal);
    if (signal.aborted) throw new FeedReadError('aborted');
    return parseFeed(xml, source, this.clock());
  }
}
