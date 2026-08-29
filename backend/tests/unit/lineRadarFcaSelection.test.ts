import { describe, expect, it, vi } from 'vitest';
import { RadarFca } from '../../src/services/radar/radarFca.js';
import { selectLineRadarDigest } from '../../src/services/line/lineRadarFcaSelection.js';
import { parseLineRadarPolicy } from '../../src/services/line/radarPolicy.js';

const owner = 'line:' + 'a'.repeat(64);
const now = Date.parse('2026-08-29T03:00:00Z');

function receipts() {
  const stored = new Set<string>();
  return {
    port: {
      existing: async (_owner: string, keys: readonly string[]) => new Set(keys.filter(key => stored.has(key))),
      reserve: async (_owner: string, key: string) => {
        if (stored.has(key)) return false;
        stored.add(key);
        return true;
      },
    },
    stored,
  };
}

function policy(overrides: Record<string, unknown> = {}) {
  return parseLineRadarPolicy({
    version: 1,
    enabled: true,
    hourJst: 12,
    minuteJst: 0,
    consentExpiresAt: now + 86400000,
    feeds: [{
      id: 'news',
      kind: 'web',
      locator: 'https://example.com/feed.xml',
      articleHosts: ['example.com'],
      topicIds: ['science'],
      maxItems: 10,
      retentionMs: 86400000,
    }],
    weather: null,
    topics: ['science'],
    youtubeSubscriptions: null,
    calendar: null,
    ...overrides,
  }, now);
}

describe('selectLineRadarDigest', () => {
  it('selects a web candidate from the collected news preview', async () => {
    const { port, stored } = receipts();
    const url = 'https://example.com/article';
    let turn = 0;
    const fca = new RadarFca({
      next: async input => {
        turn += 1;
        if (turn === 1) {
          return { content: '', toolCalls: [{ id: 'call_w', name: 'search_web_for_sharing', arguments: { query: 'science', limit: 3 } }] };
        }
        const payload = JSON.parse(input.messages.at(-1)!.content);
        const id = payload.untrustedCandidates[0].candidateId;
        return {
          content: '',
          toolCalls: [{ id: 'call_s', name: 'submit_personal_digest', arguments: { items: [{ candidateId: id, reason: 'fresh science' }] } }],
        };
      },
    });
    const result = await selectLineRadarDigest({
      owner,
      policy: policy(),
      news: {
        items: [{
          contentId: 'content-1',
          sourceId: 'news',
          card: {
            title: '架空の研究',
            fact: 'fixture fact',
            metadata: [new Date(now - 3600000).toISOString()],
            sourceUrl: url,
          },
        }],
      },
      temporal: { entries: [] },
      ports: { fca, receipts: port, youtube: async () => [] },
      signal: new AbortController().signal,
      now,
    });
    expect(result.selection.items).toHaveLength(1);
    expect(result.blocks[0]).toContain('架空の研究');
    expect(result.blocks[0]).toContain('選定理由: fresh science');
    expect(stored.size).toBe(1);
  });

  it('exposes weather candidates to the FCA when weather is configured', async () => {
    const { port } = receipts();
    let turn = 0;
    const fca = new RadarFca({
      next: async input => {
        turn += 1;
        if (turn === 1) {
          expect(input.tools.some(tool => tool.name === 'get_weather_forecast')).toBe(true);
          return { content: '', toolCalls: [{ id: 'call_w', name: 'get_weather_forecast', arguments: {} }] };
        }
        const payload = JSON.parse(input.messages.at(-1)!.content);
        const weather = payload.untrustedCandidates.find((row: any) => row.source === 'weather');
        expect(weather?.title).toContain('天気');
        return {
          content: '',
          toolCalls: [{ id: 'call_s', name: 'submit_personal_digest', arguments: { items: [{ candidateId: weather.candidateId, reason: 'forecast' }] } }],
        };
      },
    });
    const result = await selectLineRadarDigest({
      owner,
      policy: policy({
        weather: { id: 'weather', kind: 'weather', timeZone: 'Asia/Tokyo', latitudeTenth: 357, longitudeTenth: 1397 },
      }),
      news: { items: [] },
      temporal: {
        entries: [{
          sourceId: 'weather',
          timeZone: 'Asia/Tokyo',
          content: {
            kind: 'weather',
            providerUrl: 'https://open-meteo.com',
            attribution: 'Open-Meteo',
            fetchedAt: now,
            items: [{ date: '2026-08-29', minimumC: 20, maximumC: 30, precipitationPercent: 10 }],
          },
        }],
      },
      ports: { fca, receipts: port, youtube: async () => [] },
      signal: new AbortController().signal,
      now,
    });
    expect(result.blocks[0]).toContain('降水確率');
  });

  it('merges youtube port results ahead of feed youtube cards', async () => {
    const { port } = receipts();
    const youtube = vi.fn(async () => [{
      source: 'youtube' as const,
      externalId: 'portvideo11',
      title: 'Port 動画',
      fact: 'port · 2026-08-29',
      url: 'https://www.youtube.com/watch?v=portvideo11',
      publishedAt: now,
    }]);
    let turn = 0;
    const fca = new RadarFca({
      next: async input => {
        turn += 1;
        if (turn === 1) {
          return { content: '', toolCalls: [{ id: 'call_y', name: 'get_unshared_youtube_videos', arguments: { limit: 5 } }] };
        }
        const payload = JSON.parse(input.messages.at(-1)!.content);
        expect(payload.untrustedCandidates.some((row: any) => row.title === 'Port 動画')).toBe(true);
        const id = payload.untrustedCandidates.find((row: any) => row.title === 'Port 動画').candidateId;
        return {
          content: '',
          toolCalls: [{ id: 'call_s', name: 'submit_personal_digest', arguments: { items: [{ candidateId: id, reason: 'port first' }] } }],
        };
      },
    });
    const result = await selectLineRadarDigest({
      owner,
      policy: policy({
        feeds: [],
        youtubeSubscriptions: { baselineAt: now - 1000, maxSubscriptions: 500, maxCandidates: 20 },
      }),
      news: { items: [] },
      temporal: { entries: [] },
      ports: { fca, receipts: port, youtube },
      signal: new AbortController().signal,
      now,
    });
    expect(youtube).toHaveBeenCalledTimes(1);
    expect(result.blocks[0]).toContain('Port 動画');
  });

  it('returns empty blocks when the FCA chooses silence', async () => {
    const { port, stored } = receipts();
    const fca = new RadarFca({
      next: async () => ({
        content: '',
        toolCalls: [{ id: 'call_s', name: 'submit_personal_digest', arguments: { items: [], silenceReason: 'nothing new' } }],
      }),
    });
    const result = await selectLineRadarDigest({
      owner,
      policy: policy({ feeds: [], youtubeSubscriptions: { baselineAt: now - 1000, maxSubscriptions: 500, maxCandidates: 20 } }),
      news: { items: [] },
      temporal: { entries: [] },
      ports: { fca, receipts: port, youtube: async () => [] },
      signal: new AbortController().signal,
      now,
    });
    expect(result.selection.items).toHaveLength(0);
    expect(result.blocks).toHaveLength(0);
    expect(stored.size).toBe(0);
  });

  it('never exceeds the LINE digest byte budget', async () => {
    const { port } = receipts();
    const longTitle = 'x'.repeat(280);
    const longFact = 'y'.repeat(500);
    let turn = 0;
    const fca = new RadarFca({
      next: async input => {
        turn += 1;
        if (turn === 1) {
          return { content: '', toolCalls: [{ id: 'call_w', name: 'search_web_for_sharing', arguments: { query: 'science', limit: 5 } }] };
        }
        const payload = JSON.parse(input.messages.at(-1)!.content);
        const items = payload.untrustedCandidates.slice(0, 5).map((row: any, index: number) => ({
          candidateId: row.candidateId,
          reason: `reason-${index}`,
        }));
        return { content: '', toolCalls: [{ id: 'call_s', name: 'submit_personal_digest', arguments: { items } }] };
      },
    });
    const news = {
      items: Array.from({ length: 5 }, (_, index) => ({
        contentId: `content-${index}`,
        sourceId: 'news',
        card: {
          title: longTitle,
          fact: longFact,
          metadata: ['fixture'],
          sourceUrl: `https://example.com/${'segment/'.repeat(40)}${index}`,
        },
      })),
    };
    const result = await selectLineRadarDigest({
      owner,
      policy: policy(),
      news,
      temporal: { entries: [] },
      ports: { fca, receipts: port, youtube: async () => [] },
      signal: new AbortController().signal,
      now,
    });
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks.length).toBeLessThanOrEqual(result.selection.items.length);
    let bytes = Buffer.byteLength('Shannon Radar\n\n\n配信停止:「配信停止」');
    for (const block of result.blocks) bytes += Buffer.byteLength(block) + 2;
    expect(bytes).toBeLessThanOrEqual(4200);
  });
});
