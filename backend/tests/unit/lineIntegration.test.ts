import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import { lineConfig } from '../../src/services/line/config.js';
import { createLineApplication, validLineSignature } from '../../src/services/line/application.js';
import { LineLedger, lineKey, type LineState, type LineStatePort } from '../../src/services/line/ledger.js';
import { LineHttpTransport } from '../../src/services/line/transport.js';
import { parseLineTurn, lineQuiet } from '../../src/modules/conversation/lineConversation.js';
import type { LineChatPort, LineTransport } from '../../src/services/line/ports.js';
import { createLineChatModel } from '../../src/services/line/chatModel.js';
const modelFake = vi.hoisted(() => ({ invoke: vi.fn(), configurations: [] as any[] }));
vi.mock('@langchain/openai', () => ({ ChatOpenAI: class { constructor(input: any) { modelFake.configurations.push(input); } invoke = modelFake.invoke; } }));
const bot = 'U' + 'a'.repeat(32), owner = 'U' + 'b'.repeat(32), stranger = 'U' + 'c'.repeat(32);
const group = 'C' + 'd'.repeat(32), otherGroup = 'C' + 'e'.repeat(32);
const BASE = Date.parse('2026-08-29T03:00:00Z');
const env = { LINE_ENABLED: 'true', LINE_BOT_USER_ID: bot, LINE_PERSONAL_USER_ID: owner,
  LINE_ALLOWED_GROUP_IDS: group, LINE_CHANNEL_SECRET: 'test-channel-secret'.replace(/-/g, ''), LINE_CHANNEL_ACCESS_TOKEN: 'test-token'.replace(/-/g, '').repeat(4),
  LINE_CHAT_MAX_PER_24H: '100', LINE_PUSH_MAX_PER_24H: '3', LINE_PUSH_MAX_PER_MONTH: '200' };
const config = lineConfig(env);
class State implements LineStatePort {
  rows = new Map<string, LineState>();
  async read(id: string) { return structuredClone(this.rows.get(id) ?? null); }
  async compareAndSwap(id: string, revision: number, next: LineState) {
    if ((this.rows.get(id)?.revision ?? 0) !== revision) return false;
    this.rows.set(id, structuredClone(next)); return true;
  }
}
let sequence = 0;
function event(text = 'こんにちは', source: any = { type: 'user', userId: owner }, extra: any = {}) {
  const id = String(++sequence);
  return { type: 'message', mode: 'active', webhookEventId: `event_${id}`, timestamp: BASE, replyToken: `reply_${id}`,
    source, message: { type: 'text', id, text }, ...extra };
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(overrides: Partial<LineChatPort> = {}, customConfig = config, store: LineStatePort = new State()) {
  let clock = BASE;
  const chat: LineChatPort = { reply: vi.fn(async () => '返答です'), ...overrides };
  let sent = 1000;
  const transport: LineTransport = { reply: vi.fn(async () => ({ status: 'accepted' as const, messageId: String(++sent) })),
    push: vi.fn(async () => ({ status: 'accepted' as const, messageId: String(++sent) })) };
  const runtime = createLineApplication(customConfig, { state: store, chat, transport }, () => clock);
  const server = await new Promise<Server>(resolve => { const s = runtime.app.listen(0, '127.0.0.1', () => resolve(s)); });
  cleanup.push(async () => { runtime.stop(); await runtime.drain(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); });
  const port = (server.address() as any).port;
  async function post(events: unknown[], options: { destination?: string; signature?: string; raw?: string; path?: string } = {}) {
    const raw = options.raw ?? JSON.stringify({ destination: options.destination ?? bot, events });
    const signature = options.signature ?? createHmac('sha256', customConfig.channelSecret).update(raw).digest('base64');
    return fetch(`http://127.0.0.1:${port}${options.path ?? '/webhooks/line'}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-line-signature': signature }, body: raw });
  }
  return { runtime, store, chat, transport, post, setClock: (value: number) => { clock = value; } };
}
describe('LINE configuration and routing', () => {
  it('defaults to no traffic, no groups and zero budgets', () => {
    const p = lineConfig({}); expect(p.enabled).toBe(false); expect(p.allowedGroupIds).toEqual([]);
    expect(p.chatMaxPer24Hours).toBe(0); expect(p.pushMaxPerMonth).toBe(0);
  });
  it.each([{ LINE_ALLOWED_GROUP_IDS: '*' }, { LINE_ALLOWED_GROUP_IDS: owner }, { LINE_ALLOWED_GROUP_IDS: `${group},${group}` },
    { LINE_ALLOWED_GROUP_IDS: 'my group' }, { LINE_PERSONAL_USER_ID: group }, { LINE_GROUP_REPLY_MODE: 'yes' },
    { LINE_PUSH_MAX_PER_MONTH: '201' }, { LINE_CHAT_MAX_PER_24H: '-1' }, { LINE_QUIET_START_JST: '24' },
    { LINE_CHANNEL_SECRET: '' }, { LINE_ENABLED: 'yes' }])('rejects invalid config without echoing values: %j', input => {
    expect(() => lineConfig({ ...env, ...input })).toThrow('LINE_CONFIG_INVALID');
  });
  it('normalizes explicit comma separated IDs and keeps an immutable allowlist', () => {
    const p = lineConfig({ ...env, LINE_ALLOWED_GROUP_IDS: ` ${group}, ${otherGroup} ` });
    expect(p.allowedGroupIds).toEqual([group, otherGroup]); expect(Object.isFrozen(p.allowedGroupIds)).toBe(true);
  });
  it.each([{ type: 'user', userId: stranger }, { type: 'group', groupId: otherGroup, userId: owner },
    { type: 'group', groupId: group }, { type: 'room', roomId: group, userId: owner }, { type: 'user', userId: bot }])('denies unauthorized source %j', source => {
    expect(parseLineTurn(event('シャノン、こんにちは', source), config, BASE)).toBeUndefined();
  });
  it('responds to an addressed allowed group, not every conversation', () => {
    const source = { type: 'group', groupId: group, userId: stranger };
    expect(parseLineTurn(event('こんにちは', source), config, BASE)).toBeUndefined();
    expect(parseLineTurn(event('シャノン、こんにちは', source), config, BASE)?.kind).toBe('group');
    expect(parseLineTurn(event('こんにちは', source), lineConfig({ ...env, LINE_GROUP_REPLY_MODE: 'all' }), BASE)?.kind).toBe('group');
  });
  it('matches bot user ID mentions, not @all or somebody else', () => {
    const e = event('こんにちは', { type: 'group', groupId: group, userId: owner });
    Object.assign(e.message, { mention: { mentionees: [{ type: 'all' }, { type: 'user', userId: stranger }] } });
    expect(parseLineTurn(e, config, BASE)).toBeUndefined();
    Object.assign(e.message, { mention: { mentionees: [{ type: 'user', userId: bot }] } });
    expect(parseLineTurn(e, config, BASE)?.kind).toBe('group');
  });
  it.each([{ mode: 'standby' }, { timestamp: BASE - 56000 }, { timestamp: BASE + 6000 }, { replyToken: '' },
    { message: { type: 'image', id: '1' } }, { message: { type: 'text', id: '1', text: 'x'.repeat(4001) } }])('ignores unsupported/stale input %j', extra => {
    expect(parseLineTurn(event('hello', undefined, extra), config, BASE)).toBeUndefined();
  });
  it('evaluates overnight quiet hours in JST', () => {
    expect(lineQuiet(config, Date.parse('2026-08-29T13:00:00Z'))).toBe(true);
    expect(lineQuiet(config, Date.parse('2026-08-29T22:59:00Z'))).toBe(true);
    expect(lineQuiet(config, Date.parse('2026-08-29T23:00:00Z'))).toBe(false);
  });
});
describe('LINE durable ledger', () => {
  it('permits one winner for eight concurrent event reservations and preserves it after reconstruction', async () => {
    const store = new State(); const ledger = new LineLedger(store, config, () => BASE);
    expect((await Promise.all(Array.from({ length: 8 }, () => ledger.reserveChat('same', 'personal:a')))).filter(Boolean)).toHaveLength(1);
    expect(await new LineLedger(store, config, () => BASE).reserveChat('same', 'personal:a')).toBe(false);
  });
  it('reserves the last LLM budget atomically even for different events', async () => {
    const ledger = new LineLedger(new State(), { ...config, chatMaxPer24Hours: 1 }, () => BASE);
    expect((await Promise.all(Array.from({ length: 8 }, (_, i) => ledger.reserveChat(`e${i}`, 'group:a')))).filter(Boolean)).toHaveLength(1);
  });
  it('refuses a changed personal identity instead of reusing consent and private content', async () => {
    const store = new State(); await new LineLedger(store, config, () => BASE).consent('on', BASE, true);
    await expect(new LineLedger(store, { ...config, personalUserId: stranger }, () => BASE).read()).rejects.toThrow('LINE_BINDING_CHANGED');
  });
  it('requires explicit opt-in; denies group/other owner and duplicate digest IDs', async () => {
    const l = new LineLedger(new State(), config, () => BASE);
    const digest = { id: 'd1', ownerUserId: owner, text: '情報\nhttps://example.com/', expiresAt: BASE + 3600000 };
    expect(await l.enqueue(digest)).toBeUndefined(); await l.consent('on', BASE, true);
    expect(await l.enqueue({ ...digest, ownerUserId: group })).toBeUndefined();
    expect(await l.enqueue(digest)).toBeTypeOf('string'); expect(await l.enqueue(digest)).toBeUndefined();
  });
  it('retains push reservations across stop/start and unknown sends', async () => {
    const l = new LineLedger(new State(), { ...config, pushMaxPerMonth: 1 }, () => BASE);
    await l.consent('on', BASE, true);
    const d = { id: 'one', ownerUserId: owner, text: 'info', expiresAt: BASE + 60000 };
    const id = (await l.enqueue(d))!; await l.claim(id); await l.finish(id, { status: 'unknown' });
    await l.consent('off', BASE + 1, false); await l.consent('on2', BASE + 2, true);
    expect(await l.enqueue({ ...d, id: 'two' })).toBeUndefined(); expect(await l.claim(id)).toBeUndefined();
  });
  it('stop wins same-time controls, clears content and cancels pending sends', async () => {
    const l = new LineLedger(new State(), config, () => BASE); await l.consent('on', BASE, true);
    const id = (await l.enqueue({ id: 'd', ownerUserId: owner, text: 'private', expiresAt: BASE + 60000 }))!;
    expect(await l.consent('off', BASE, false)).toBe(true);
    expect(await l.consent('stale-on', BASE, true)).toBe(false);
    expect(await l.claim(id)).toBeUndefined(); expect(JSON.stringify(await l.read())).not.toContain('private');
  });
  it('does not enqueue during quiet hours or after expiration', async () => {
    let now = BASE; const l = new LineLedger(new State(), config, () => now); await l.consent('on', now, true);
    expect(await l.enqueue({ id: 'old', ownerUserId: owner, text: 'x', expiresAt: now })).toBeUndefined();
    now += 12 * 3600000;
    expect(await l.enqueue({ id: 'night', ownerUserId: owner, text: 'x', expiresAt: now + 60000 })).toBeUndefined();
  });
});
describe('LINE webhook to conversation and private delivery', () => {
  it('verifies the exact original bytes, not parsed/reserialized JSON', () => {
    const b = Buffer.from('{ "text": "改行\\n\\\\" }');
    const sig = createHmac('sha256', config.channelSecret).update(b).digest('base64');
    expect(validLineSignature(b, sig, config.channelSecret)).toBe(true);
    expect(validLineSignature(Buffer.from(JSON.stringify(JSON.parse(b.toString()))), sig, config.channelSecret)).toBe(false);
    expect(validLineSignature(b, undefined, config.channelSecret)).toBe(false);
  });
  it('rejects forged signatures, wrong bot and malformed bodies without model/state writes', async () => {
    const f = await fixture();
    expect((await f.post([event()], { signature: 'wrong' })).status).toBe(401);
    expect((await f.post([event()], { destination: stranger })).status).toBe(400);
    expect((await f.post([], { raw: '{no' })).status).toBe(400);
    expect(f.chat.reply).not.toHaveBeenCalled(); expect((f.store as State).rows.size).toBe(0);
    expect((await f.post([])).status).toBe(200);
  });
  it('ignores unauthorized groups and unaddressed messages before model/storage', async () => {
    const f = await fixture();
    await f.post([event('シャノン、こんにちは', { type: 'group', groupId: otherGroup, userId: owner }),
      event('普通の会話', { type: 'group', groupId: group, userId: owner }), event('hi', { type: 'user', userId: stranger })]);
    await f.runtime.drain(); expect(f.chat.reply).not.toHaveBeenCalled(); expect((f.store as State).rows.size).toBe(0);
  });
  it('replies to the originating token once across concurrent redeliveries', async () => {
    const f = await fixture(); const e = event('シャノン、こんにちは', { type: 'group', groupId: group, userId: stranger });
    await Promise.all(Array.from({ length: 4 }, () => f.post([e]))); await f.runtime.drain();
    expect(f.chat.reply).toHaveBeenCalledTimes(1); expect(f.transport.reply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.transport.reply).mock.calls[0][0]).toBe(e.replyToken); expect(f.transport.push).not.toHaveBeenCalled();
  });
  it('does not process if durable reservation fails', async () => {
    const store = new State(); store.compareAndSwap = async () => { throw Error('unavailable'); };
    const f = await fixture({}, config, store); expect((await f.post([event()])).status).toBe(503);
    expect(f.chat.reply).not.toHaveBeenCalled(); expect(f.transport.reply).not.toHaveBeenCalled();
  });
  it('separates private and each group history, even for the same owner', async () => {
    const f = await fixture({}, lineConfig({ ...env, LINE_ALLOWED_GROUP_IDS: `${group},${otherGroup}` }));
    await f.post([event('個人の秘密')]); await f.runtime.drain();
    await f.post([event('シャノン、グループA', { type: 'group', groupId: group, userId: owner })]); await f.runtime.drain();
    await f.post([event('シャノン、グループB', { type: 'group', groupId: otherGroup, userId: owner })]); await f.runtime.drain();
    const calls = vi.mocked(f.chat.reply).mock.calls;
    expect(JSON.stringify(calls[1])).not.toContain('個人の秘密'); expect(JSON.stringify(calls[2])).not.toContain('グループA');
    expect(JSON.stringify((f.store as State).rows.get(bot))).not.toContain('個人の秘密');
  });
  it('serializes follow-up conversation with the previous reply in its context', async () => {
    const f = await fixture(); await f.post([event('最初'), event('続き')]); await f.runtime.drain();
    const calls = vi.mocked(f.chat.reply).mock.calls;
    expect(calls).toHaveLength(2); expect(calls[1][0].messages.map(m => m.content)).toEqual(['最初', '返答です', '続き']);
  });
  it('expires volatile conversation history', async () => {
    const f = await fixture(); await f.post([event('古い相談')]); await f.runtime.drain();
    f.setClock(BASE + 1800001); await f.post([event('次', undefined, { timestamp: BASE + 1800001 })]); await f.runtime.drain();
    expect(JSON.stringify(vi.mocked(f.chat.reply).mock.calls[1])).not.toContain('古い相談');
  });
  it('unsend clears derived history and prevents the active response from being sent', async () => {
    let release!: (s: string) => void;
    const f = await fixture({ reply: vi.fn(() => new Promise<string>(r => { release = r; })) });
    const e = event('消す内容'); await f.post([e]);
    await f.post([{ ...e, type: 'unsend', unsend: { messageId: e.message.id } }]);
    release('遅い返答'); await f.runtime.drain(); expect(f.transport.reply).not.toHaveBeenCalled();
  });
  it('stops after generation and never substitutes a Push for an expired reply', async () => {
    let release!: (s: string) => void;
    const f = await fixture({ reply: vi.fn(() => new Promise<string>(r => { release = r; })) });
    await f.post([event()]); f.setClock(BASE + 51000); release('late'); await f.runtime.drain();
    expect(f.transport.reply).not.toHaveBeenCalled(); expect(f.transport.push).not.toHaveBeenCalled();
  });
  it('requires personal opt-in and sends a digest only to the configured user', async () => {
    const f = await fixture(); await f.post([event('/radar on')]);
    const id = (await f.runtime.ledger.enqueue({ id: 'digest', ownerUserId: owner, text: '記事\nhttps://example.com/', expiresAt: BASE + 60000 }))!;
    expect(await f.runtime.deliver(id, async () => true)).toBe('accepted');
    expect(vi.mocked(f.transport.push).mock.calls[0][0]).toBe(owner);
    expect(await f.runtime.deliver(id, async () => true)).toBe('denied');
    expect(f.transport.push).toHaveBeenCalledTimes(1);
  });
  it('can discuss a delivered card by quote ID only in the personal conversation', async () => {
    const f = await fixture(); await f.post([event('/radar on')]);
    const id = (await f.runtime.ledger.enqueue({ id: 'd', ownerUserId: owner, text: '私的ダイジェスト', expiresAt: BASE + 60000 }))!;
    await f.runtime.deliver(id, async () => true);
    const q = event('詳しく'); Object.assign(q.message, { quotedMessageId: '1002' }); await f.post([q]); await f.runtime.drain();
    expect(JSON.stringify(vi.mocked(f.chat.reply).mock.calls[0])).toContain('私的ダイジェスト');
    const g = event('シャノン、これを説明', { type: 'group', groupId: group, userId: owner }); Object.assign(g.message, { quotedMessageId: '1002' });
    await f.post([g]); await f.runtime.drain(); expect(JSON.stringify(vi.mocked(f.chat.reply).mock.calls[1])).not.toContain('私的ダイジェスト');
  });
  it('honors revocation while the delivery authorizer is awaiting', async () => {
    const f = await fixture(); await f.post([event('/radar on')]);
    const id = (await f.runtime.ledger.enqueue({ id: 'd', ownerUserId: owner, text: 'private', expiresAt: BASE + 60000 }))!;
    let calls = 0;
    expect(await f.runtime.deliver(id, async () => { if (++calls === 2) await f.runtime.ledger.consent('stop', BASE + 1, false); return true; })).toBe('denied');
    expect(f.transport.push).not.toHaveBeenCalled();
  });
  it('ignores group attempts to opt in and persists individual stop without using the LLM', async () => {
    const f = await fixture(); await f.post([event('/radar on', { type: 'group', groupId: group, userId: owner })]);
    expect((await f.runtime.ledger.read()).optedIn).toBe(false);
    await f.post([event('/radar on')]); await f.post([event('配信停止')]);
    expect((await f.runtime.ledger.read()).optedIn).toBe(false); expect(f.chat.reply).not.toHaveBeenCalled();
  });
  it('unfollow revokes pending personal delivery without an outbound message', async () => {
    const f = await fixture(); await f.post([event('/radar on')]);
    await f.post([event('', undefined, { type: 'unfollow', timestamp: BASE + 1 })]);
    expect((await f.runtime.ledger.read()).optedIn).toBe(false); expect(f.transport.reply).toHaveBeenCalledTimes(1);
  });
  it('after stop refuses webhook and suppresses pending model output', async () => {
    let release!: (s: string) => void; const f = await fixture({ reply: vi.fn(() => new Promise<string>(r => { release = r; })) });
    await f.post([event()]); f.runtime.stop(); release('late'); await f.runtime.drain();
    expect((await f.post([event()])).status).toBe(503); expect(f.transport.reply).not.toHaveBeenCalled();
  });
});
describe('LINE outbound HTTP adapter', () => {
  it('uses a fixed endpoint, refuses redirects and adds a retry key only for personal push', async () => {
    const http = vi.fn(async () => new Response(JSON.stringify({ sentMessages: [{ id: '123' }] }), { status: 200 })) as any;
    const t = new LineHttpTransport('fake', http); const signal = new AbortController().signal;
    await t.reply('token', 'hello', signal); await t.push(owner, 'digest', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', signal);
    expect(http.mock.calls[0][0]).toBe('https://api.line.me/v2/bot/message/reply'); expect(http.mock.calls[0][1].redirect).toBe('error');
    expect(http.mock.calls[0][1].headers['X-Line-Retry-Key']).toBeUndefined(); expect(http.mock.calls[1][1].headers['X-Line-Retry-Key']).toBeTruthy();
    expect(() => t.push(group, 'no', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', signal)).toThrow();
  });
  it.each([400, 429, 500, 409])('classifies HTTP %i without an automatic retry', async status => {
    const http = vi.fn(async () => new Response('error', { status })) as any;
    const t = new LineHttpTransport('fake', http);
    expect((await t.reply('token', 'hi', new AbortController().signal)).status).toBe(status >= 500 || status === 409 ? 'unknown' : 'failed');
    expect(http).toHaveBeenCalledTimes(1);
  });
  it('treats a network error as unknown, without exposing provider details or retrying', async () => {
    const http = vi.fn(async () => { throw Error('secret'); }) as any;
    expect(await new LineHttpTransport('fake', http).reply('token', 'hi', new AbortController().signal)).toEqual({ status: 'unknown' });
    expect(http).toHaveBeenCalledTimes(1);
  });
});
describe('LINE stateless chat adapter', () => {
  it('uses explicit credentials/model, a token cap, no retries and only supplied context', async () => {
    modelFake.invoke.mockResolvedValueOnce({ content: 'こんにちは' });
    const model = createLineChatModel({ apiKey: 'fixture-key', model: 'fixture-model', profile: 'fictional character only' });
    const signal = new AbortController().signal;
    expect(await model.reply({ kind: 'group', messages: [{ role: 'user', content: 'シャノン、やあ' }], signal })).toBe('こんにちは');
    expect(modelFake.configurations.at(-1)).toEqual({ apiKey: 'fixture-key', model: 'fixture-model', maxTokens: 900, maxRetries: 0, timeout: 30000 });
    const [messages, options] = modelFake.invoke.mock.calls.at(-1)!;
    expect(messages).toHaveLength(2); expect(messages[0].content).toContain('グループ会話'); expect(options.signal).toBe(signal);
  });
  it('does not invoke the model after cancellation', async () => {
    const model = createLineChatModel({ apiKey: 'fixture-key', model: 'fixture-model', profile: 'fictional' });
    const count = modelFake.invoke.mock.calls.length; const c = new AbortController(); c.abort();
    await expect(model.reply({ kind: 'personal', messages: [], signal: c.signal })).rejects.toThrow();
    expect(modelFake.invoke.mock.calls.length).toBe(count);
  });
});
