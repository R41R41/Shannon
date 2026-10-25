import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  CHANNELS, EXPRESSIONS, MinebotExpressionBridge, PresenceLease, speakerAngles,
} from '../../src/services/minebot/integration/expressionBridge.js';

/** Ported from ExpressionMod's integration/minebot/expression-bridge.test.mjs (2026-10-08), with the reflex face of 2026-10-26. */
const uuid = 'accf3442-b95f-414b-95fd-f70bbd2c9764', etag = '0123456789abcdef';
const presence = (expression = 'joyful') => ({ schemaVersion: 1, etag, pollAfterSeconds: 10, mood: { expression } });
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
type Packet = { channel: string; data: Buffer };

function fixture(fetcher: typeof fetch) {
  let now = 0; let id = 0; const timers = new Map<number, { fn: () => void; ms: number }>(); const sent: Packet[] = [];
  const bot = new EventEmitter() as any; bot._client = new EventEmitter(); bot._client.uuid = uuid;
  bot.username = 'I_am_Shannon'; bot.player = { uuid }; bot.entity = { position: { x: 0, y: 0, z: 0 }, height: 1.8, yaw: 0 }; bot.players = {};
  bot._client.write = (_name: string, packet: Packet) => sent.push(packet);
  const bridge = new MinebotExpressionBridge(bot, { baseUrl: 'http://127.0.0.1:9999', token: 'synthetic-test-token', fetcher,
    clock: () => now, setTimer: (fn, ms) => { timers.set(++id, { fn, ms }); return id as any; }, clearTimer: timer => { timers.delete(timer as any); } });
  const inside = bridge as any;
  return { bot, bridge, inside, sent, timers, setNow: (n: number) => { now = n; },
    ready: () => bot._client.emit('custom_payload', { channel: CHANNELS.ready, data: Buffer.from([1]) }) };
}
const emotes = (sent: Packet[]) => sent.filter(packet => packet.channel === CHANNELS.emote);

describe('her face from her mind (presence)', () => {
  it('takes all 22 expressions only from mood.expression, and unchanged renews the lease', () => {
    for (const expression of EXPRESSIONS) {
      const lease = new PresenceLease(); expect(lease.accept(presence(expression), 0)).toBe(true);
      expect(lease.sample(24_999).expression).toBe(expression); expect(lease.sample(25_000).expression).toBe('neutral');
      expect(lease.accept({ schemaVersion: 1, etag, unchanged: true, pollAfterSeconds: 10 }, 25_001)).toBe(true);
      expect(lease.sample(25_002).expression).toBe(expression);
    }
    expect(new PresenceLease().accept({ schemaVersion: 1, etag, pollAfterSeconds: 10, expression: 'joyful' }, 0)).toBe(false);
  });

  it('never revives a cached face from an unknown shape or another etag', () => {
    const lease = new PresenceLease(); expect(lease.accept({ schemaVersion: 1, etag, unchanged: true, pollAfterSeconds: 10 }, 0)).toBe(false);
    lease.accept(presence(), 0);
    expect(lease.accept({ schemaVersion: 1, etag: 'abcdef0123456789', unchanged: true, pollAfterSeconds: 10 }, 1)).toBe(false);
    expect(lease.accept({ ...presence(), pollAfterSeconds: 0 }, 1)).toBe(false);
    expect(lease.accept(presence('private-cause'), 1)).toBe(false);
  });

  it('waits for the mod\'s acknowledgement, authenticates its GET and honours unchanged', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const f = fixture((async (url: URL, init: RequestInit) => { requests.push({ url: String(url), init });
      return Response.json(requests.length === 1 ? presence() : { schemaVersion: 1, etag, unchanged: true, pollAfterSeconds: 7 }); }) as any);
    f.bridge.start(); await flush(); expect(emotes(f.sent)).toHaveLength(0);
    expect(f.sent[0]).toEqual({ channel: 'minecraft:register', data: Buffer.from(Object.values(CHANNELS).join('\0')) });
    f.ready(); expect(emotes(f.sent).length).toBeGreaterThan(0);
    expect(new URL(requests[0]!.url).searchParams.get('scopeKey')).toBe('owner'); expect(requests[0]!.init.method).toBe('GET');
    expect(requests[0]!.init.redirect).toBe('error'); expect((requests[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer synthetic-test-token');
    f.setNow(10_000); f.bridge.refresh(); await flush(); expect(new URL(requests[1]!.url).searchParams.get('etag')).toBe(etag);
    expect([...f.timers.values()].some(timer => timer.ms === 7000)).toBe(true); f.bridge.stop(); expect(f.timers.size).toBe(0);
  });

  it('drops a late network result after stop and removes every listener', async () => {
    let resolve!: (value: Response) => void;
    const f = fixture((() => new Promise<Response>(r => { resolve = r; })) as any); f.bridge.start(); f.ready(); f.bridge.stop(); const count = f.sent.length;
    resolve(Response.json(presence())); await flush(); expect(f.sent.length).toBe(count); expect(f.timers.size).toBe(0);
    expect(f.bot._client.listenerCount('custom_payload')).toBe(0); expect(f.bot.listenerCount('spawn')).toBe(0);
  });

  it('stops on 401/403, and keeps the last face only until its lease ends when the mind is unreachable', async () => {
    const refused = fixture((async () => new Response('synthetic secret must not be logged', { status: 403 })) as any);
    refused.bridge.start(); refused.ready(); await flush(); expect(refused.inside.running).toBe(false); expect(refused.timers.size).toBe(0);
    let fail = false;
    const f = fixture((async () => { if (fail) throw Error('secret-bearing exception'); return Response.json(presence()); }) as any);
    f.bridge.start(); f.ready(); await flush(); fail = true; f.setNow(10_000); f.bridge.refresh(); await flush();
    expect(f.inside.lease.sample(24_000).expression).toBe('joyful'); expect(f.inside.lease.sample(25_000).expression).toBe('neutral');
    f.setNow(25_000); f.inside.publish(); expect(emotes(f.sent).at(-1)!.data.includes(Buffer.from('neutral'))).toBe(true); f.bridge.stop();
  });

  it('a chat turn drives listening, thinking and speaking, including an interrupted turn', async () => {
    const f = fixture((async () => Response.json(presence())) as any); f.bridge.start(); f.ready(); await flush();
    const a = f.bridge.beginTurn(uuid); expect(f.inside.activity).toBe('listening'); f.setNow(601); f.inside.publish();
    expect(f.sent.at(-1)!.data.includes(Buffer.from('thinking'))).toBe(true);
    const b = f.bridge.beginTurn(uuid); a.speaking(); expect(f.inside.activity).toBe('listening'); b.speaking(); b.finish();
    expect(f.inside.activity).toBe('speaking'); f.setNow(3000); f.inside.publish(); expect(f.sent.at(-1)!.data.includes(Buffer.from('idle'))).toBe(true);
    const c = f.bridge.beginTurn(uuid); c.finish(); expect(f.inside.activity).toBe('idle'); f.bridge.stop();
  });

  it('a reflex face shows at once over her mind\'s face, for its moment only', async () => {
    const f = fixture((async () => Response.json(presence('calm'))) as any); f.bridge.start(); f.ready(); await flush();
    f.bridge.flash('surprised', 1200);
    expect(emotes(f.sent).at(-1)!.data.includes(Buffer.from('surprised'))).toBe(true);
    f.setNow(1300); f.inside.publish();
    expect(emotes(f.sent).at(-1)!.data.includes(Buffer.from('calm'))).toBe(true);
    // Nothing is shown before the mod acknowledged, or after stop.
    f.bridge.stop(); const count = f.sent.length; f.bridge.flash('surprised', 1200); expect(f.sent.length).toBe(count);
  });

  it('looks at the speaker only locally, near and in front; it never turns her body', () => {
    const bot = { entity: { position: { x: 0, y: 0, z: 0 }, yaw: 0 }, players: { other: { uuid, entity: { position: { x: 1, y: 0, z: -3 } } } } };
    expect(speakerAngles(bot, uuid)!.yaw).toBeGreaterThan(0); bot.players.other.entity.position.z = 3; expect(speakerAngles(bot, uuid)).toBeNull();
    bot.players.other.entity.position.z = -30; expect(speakerAngles(bot, uuid)).toBeNull(); expect(speakerAngles(bot, 'bad')).toBeNull();
  });

  it('reads the real contract over loopback, and refuses any other host for the device credential', async () => {
    const paths: string[] = [];
    const server = createServer((request, response) => { paths.push(request.url ?? '');
      expect(request.headers.authorization).toBe('Bearer synthetic-test-token');
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(presence('concerned'))); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const f = fixture(fetch); f.inside.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      f.bridge.start(); f.ready(); for (let i = 0; i < 30 && !f.inside.lease.etag; i++) await new Promise(resolve => setTimeout(resolve, 10));
      expect(f.inside.lease.expression).toBe('concerned'); expect(paths).toHaveLength(1); expect(paths[0]!.startsWith('/v1/body/presence?')).toBe(true);
    } finally { f.bridge.stop(); await new Promise(resolve => server.close(resolve)); }
    expect(() => new MinebotExpressionBridge({} as any, { baseUrl: 'https://example.com', token: 'synthetic-test-token' })).toThrow(/LOOPBACK/);
  });

  it('a refresh during a read schedules one follow-up, never overlapping reads; an unknown mod version shows nothing', async () => {
    let calls = 0; let resolve!: (value: Response) => void;
    const f = fixture((() => { calls++; return new Promise<Response>(r => { resolve = r; }); }) as any);
    f.bridge.start(); f.bridge.refresh(); f.bridge.refresh(); expect(calls).toBe(1); resolve(Response.json(presence())); await flush();
    const follow = [...f.timers.values()].find(timer => timer.ms === 0); expect(follow).toBeTruthy(); follow!.fn(); expect(calls).toBe(2);
    f.bridge.stop(); resolve(Response.json(presence())); await flush();
    const big = fixture((async () => new Response('x'.repeat(65_537))) as any); big.bridge.start();
    big.bot._client.emit('custom_payload', { channel: CHANNELS.ready, data: Buffer.from([99]) }); await flush();
    expect(big.inside.ready).toBe(false); expect(big.inside.lease.etag).toBeUndefined(); big.bridge.stop();
  });
});
