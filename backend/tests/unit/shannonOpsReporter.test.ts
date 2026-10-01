import { describe, expect, it, vi } from 'vitest';
import { createShannonOpsReporter } from '../../src/services/integration/shannonOpsReporter.js';

const config = {
  url: 'http://127.0.0.1:4319/v1/platform/turns', token: 'a'.repeat(32), timeoutMs: 3_000,
  release: 'platform-people-20261002-cc7480f', startedAt: '2026-10-02T00:00:00.000Z',
};
const at = new Date('2026-10-02T01:00:00.000Z');

describe('Shannon operations reporter', () => {
  it('is off without a valid bridge configuration', () => {
    expect(createShannonOpsReporter({ ...config, url: '' })).toBeNull();
    expect(createShannonOpsReporter({ ...config, token: 'short' })).toBeNull();
    expect(createShannonOpsReporter({ ...config, url: 'http://example.com/v1/platform/turns' })).toBeNull();
  });

  it('reports service states, schedule names and times, and skills, and nothing a schedule would post', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    const reporter = createShannonOpsReporter(config, fetcher as typeof fetch)!;
    reporter.observeStatus('discord', 'running');
    reporter.observeStatus('minecraft:lab', 'connecting');
    reporter.observeStatus('twitter', 'stopped');
    reporter.observeStatus('bad id', 'running');
    reporter.observeSchedules([{ name: 'morning_post', time: '0 8 * * *', data: { secretBody: '投稿の本文' } } as never]);
    reporter.observeSkills([
      { name: 'search', description: '検索する\n二行目', parameters: [{ name: 'q', description: 'x' }] },
      { name: 'search', description: 'duplicate', parameters: [] },
    ]);
    await expect(reporter.report(at)).resolves.toBe('reported');
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4319/v1/platform/ops/snapshot');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${config.token}`);
    expect(JSON.parse(init.body as string)).toEqual({
      scopeKey: 'owner', reportedAt: at.toISOString(),
      runtime: { release: 'platform-people-20261002-cc7480f', startedAt: config.startedAt },
      services: [
        { id: 'discord', label: 'discord', category: 'discord', status: 'running' },
        { id: 'minecraft:lab', label: 'minecraft:lab', category: 'minecraft', status: 'degraded' },
        { id: 'twitter', label: 'twitter', category: 'twitter', status: 'stopped' },
      ],
      minebot: [],
      schedules: [{ name: 'morning_post', time: '0 8 * * *' }],
      skills: [{ name: 'search', description: '検索する 二行目' }],
    });
    expect(init.body as string).not.toContain('投稿の本文');
  });

  it('tells a refusal from an outage and never throws', async () => {
    const refused = createShannonOpsReporter(config, (async () => new Response('{}', { status: 400 })) as typeof fetch)!;
    await expect(refused.report(at)).resolves.toBe('refused');
    const limited = createShannonOpsReporter(config, (async () => new Response('{}', { status: 429 })) as typeof fetch)!;
    await expect(limited.report(at)).resolves.toBe('unavailable');
    const down = createShannonOpsReporter(config, (async () => { throw new Error('down'); }) as typeof fetch)!;
    await expect(down.report(at)).resolves.toBe('unavailable');
  });
});
