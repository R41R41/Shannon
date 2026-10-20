import { describe, expect, it, vi } from 'vitest';
import { CommonFcaControlLoop, type CommonFcaActuator } from '../../src/services/minebot/integration/commonFca/controlLoop.js';
import { LIVE_RECEIPT_POLLS, LiveSpeechCourier, type LiveSpeechItem, type LiveSpeechSink } from '../../src/services/common/liveSpeech.js';
import { createDiscordLiveSpeechSink, liveTextTarget, type LiveVoiceMouth } from '../../src/services/discord/liveSpeechSink.js';

const NOW = Date.parse('2026-10-20T10:00:00Z');
const item = (id: string, patch: Partial<LiveSpeechItem> = {}): LiveSpeechItem => ({ id, text: 'ダイヤ見つけた！', urgency: 'ordinary',
  expiresAt: new Date(NOW + 20_000).toISOString(), kind: 'diamond_found', ...patch });
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('liveTextTarget', () => {
  it('takes only <guild>:<channel> as digits', () => {
    expect(liveTextTarget('111:222')).toEqual({ guildId: '111', channelId: '222' });
    expect(liveTextTarget(' 111:222 ')).toEqual({ guildId: '111', channelId: '222' });
    for (const bad of ['', undefined, '111', '111:abc', 'a:2', '111:222:333', '<#222>', '111:222; drop']) expect(liveTextTarget(bad)).toBeNull();
  });
});

describe('LiveSpeechCourier', () => {
  const sinkOf = (speak: LiveSpeechSink['speak'], room = { voice: false, humanSpeaking: false, sinceHumanMs: null as number | null }): LiveSpeechSink => ({ room: () => room, speak });

  it('is inactive without a sink and then neither speaks nor tells anything', () => {
    const courier = new LiveSpeechCourier(() => null, () => NOW);
    expect(courier.active).toBe(false);
    expect(courier.room()).toBeUndefined();
    courier.accept([item('a')]);
    expect(courier.takeReceipts()).toEqual([]);
  });

  it('speaks a line once, tells the receipt in the next polls and then stops telling it', async () => {
    const speak = vi.fn(async (line: LiveSpeechItem) => ({ id: line.id, outcome: 'posted' as const, conversationId: 'discord:1:2' }));
    const courier = new LiveSpeechCourier(() => sinkOf(speak), () => NOW);
    courier.accept([item('a')]);
    courier.accept([item('a')]);
    await flush();
    expect(speak).toHaveBeenCalledTimes(1);
    for (let poll = 0; poll < LIVE_RECEIPT_POLLS; poll++) expect(courier.takeReceipts()).toEqual([{ id: 'a', outcome: 'posted', conversationId: 'discord:1:2' }]);
    expect(courier.takeReceipts()).toEqual([]);
    courier.accept([item('a')]);
    await flush();
    expect(speak).toHaveBeenCalledTimes(1);
  });

  it('runs one line at a time and takes the next after it', async () => {
    let release: () => void = () => {};
    const speak = vi.fn((line: LiveSpeechItem) => new Promise<{ id: string; outcome: 'spoken' }>(resolve => { release = () => resolve({ id: line.id, outcome: 'spoken' }); }));
    const courier = new LiveSpeechCourier(() => sinkOf(speak), () => NOW);
    courier.accept([item('a')]);
    courier.accept([item('b')]);
    expect(speak).toHaveBeenCalledTimes(1);
    release();
    await flush();
    courier.accept([item('b')]);
    expect(speak).toHaveBeenCalledTimes(2);
  });

  it('declines a line that is already past its time without asking the sink, and reports a sink that throws as failed', async () => {
    const speak = vi.fn(async () => { throw new Error('boom'); });
    const courier = new LiveSpeechCourier(() => sinkOf(speak), () => NOW);
    courier.accept([item('old', { expiresAt: new Date(NOW - 1).toISOString() })]);
    await flush();
    expect(speak).not.toHaveBeenCalled();
    expect(courier.takeReceipts()).toEqual([{ id: 'old', outcome: 'declined', reason: 'expired' }]);
    courier.accept([item('x')]);
    await flush();
    expect(courier.takeReceipts().at(-1)).toEqual({ id: 'x', outcome: 'failed', reason: 'error' });
  });

  it('ignores what is not a line: no id, no text, a long text, a bad time, a list that is not a list', async () => {
    const speak = vi.fn(async (line: LiveSpeechItem) => ({ id: line.id, outcome: 'spoken' as const }));
    const courier = new LiveSpeechCourier(() => sinkOf(speak), () => NOW);
    courier.accept('no');
    courier.accept([null, { text: 'x' }, { id: 'a b', text: 'x', expiresAt: item('z').expiresAt }, { id: 'a', text: '  ', expiresAt: item('z').expiresAt },
      { id: 'b', text: 'あ'.repeat(401), expiresAt: item('z').expiresAt }, { id: 'c', text: 'x', expiresAt: 'tomorrow' }]);
    await flush();
    expect(speak).not.toHaveBeenCalled();
  });

  it('cleans the text of control characters and an unknown kind', async () => {
    const speak = vi.fn(async (line: LiveSpeechItem) => ({ id: line.id, outcome: 'spoken' as const }));
    const courier = new LiveSpeechCourier(() => sinkOf(speak), () => NOW);
    courier.accept([{ id: 'a', text: 'お\u0000っ\n  すごい', urgency: 'whatever', expiresAt: item('z').expiresAt, kind: 'Bad Kind!' }]);
    await flush();
    expect(speak).toHaveBeenCalledWith({ id: 'a', text: 'お っ すごい', urgency: 'ordinary', expiresAt: item('z').expiresAt, kind: 'unknown' });
  });
});

describe('the Discord sink', () => {
  const GUILD = '111', CHANNEL = '222';
  function discord(options: { guildId?: string; permissions?: bigint[]; thread?: boolean; textBased?: boolean; missing?: boolean } = {}) {
    const sent: any[] = [];
    const handlers: Array<(message: any) => void> = [];
    const permissions = options.permissions ?? ['ViewChannel', 'SendMessages', 'SendMessagesInThreads'].map(() => 0n);
    const channel = {
      guildId: options.guildId ?? GUILD, isTextBased: () => options.textBased !== false, isThread: () => options.thread === true,
      send: vi.fn(async (message: unknown) => { sent.push(message); }),
      permissionsFor: () => ({ has: (flag: bigint) => options.permissions ? options.permissions.includes(flag) : true }),
    };
    const client = { user: { id: 'bot' }, channels: { cache: { get: (id: string) => (options.missing || id !== CHANNEL ? undefined : channel) } },
      on: (_event: string, handler: (message: any) => void) => { handlers.push(handler); } };
    return { client: client as never, sent, channel, human: (channelId = CHANNEL, bot = false) => handlers.forEach(handler => handler({ channelId, author: { bot } })), permissions };
  }
  const mouth = (patch: Partial<LiveVoiceMouth> & { done?: string; accepted?: boolean; reason?: string } = {}) => {
    const say = vi.fn(() => ({ id: 'v1', accepted: patch.accepted !== false, ...(patch.reason ? { reason: patch.reason } : {}), done: Promise.resolve(patch.done ?? 'spoken') }));
    return { say, state: patch.state } as LiveVoiceMouth & { say: typeof say };
  };
  const make = (d: ReturnType<typeof discord>, parts: { voice?: LiveVoiceMouth | null; target?: boolean; now?: () => number } = {}) => createDiscordLiveSpeechSink(d.client, {
    isRunning: () => true, target: parts.target === false ? null : { guildId: GUILD, channelId: CHANNEL }, voice: async () => parts.voice ?? null, now: parts.now ?? (() => NOW) });

  it('posts a line into the set channel with no mention, and says which conversation it went into', async () => {
    const d = discord();
    const sink = make(d);
    const receipt = await sink.speak(item('a', { text: '@everyone ダイヤだ' }));
    expect(receipt).toEqual({ id: 'a', outcome: 'posted', conversationId: 'discord:111:222' });
    expect(d.sent).toEqual([{ content: '@everyone ダイヤだ', allowedMentions: { parse: [], repliedUser: false } }]);
  });

  it('says the line in the voice channel when she is in one, and writes nothing then (the voice records its own)', async () => {
    const d = discord();
    const voice = mouth({ state: () => ({ inVoice: true, humanSpeaking: false, sinceHumanMs: 9000 }) });
    const sink = make(d, { voice });
    expect(await sink.speak(item('a', { urgency: 'urgent' }))).toEqual({ id: 'a', outcome: 'spoken' });
    expect(voice.say).toHaveBeenCalledWith(expect.objectContaining({ text: 'ダイヤ見つけた！', source: 'minecraft:live:diamond_found', key: 'live:diamond_found', priority: 'high' }));
    expect(d.sent).toEqual([]);
  });

  it('does not fall to text when the voice mouth is busy or dropped it, but does when she is not in a voice channel', async () => {
    const busy = mouth({ done: 'dropped_busy' });
    expect(await make(discord(), { voice: busy }).speak(item('a'))).toEqual({ id: 'a', outcome: 'declined', reason: 'busy' });
    expect(await make(discord(), { voice: mouth({ done: 'expired' }) }).speak(item('a'))).toEqual({ id: 'a', outcome: 'declined', reason: 'expired' });
    expect(await make(discord(), { voice: mouth({ accepted: false, reason: 'rate_limited' }) }).speak(item('a'))).toMatchObject({ outcome: 'declined', reason: 'busy' });
    const d = discord();
    expect(await make(d, { voice: mouth({ done: 'not_in_voice' }) }).speak(item('a'))).toMatchObject({ outcome: 'posted' });
    expect(await make(discord(), { voice: mouth({ accepted: false, reason: 'disabled' }) }).speak(item('a'))).toMatchObject({ outcome: 'posted' });
    const away = discord();
    expect(await make(away, { voice: mouth({ state: () => ({ inVoice: false, humanSpeaking: false, sinceHumanMs: null }) }) }).speak(item('a'))).toMatchObject({ outcome: 'posted' });
  });

  it('declines when no text channel is set, the channel is not in the guild, is not text, is not known, or the bot may not write', async () => {
    expect(await make(discord(), { target: false }).speak(item('a'))).toEqual({ id: 'a', outcome: 'declined', reason: 'no_channel' });
    expect(await make(discord({ guildId: '999' })).speak(item('a'))).toMatchObject({ reason: 'no_channel' });
    expect(await make(discord({ textBased: false })).speak(item('a'))).toMatchObject({ reason: 'no_channel' });
    expect(await make(discord({ missing: true })).speak(item('a'))).toMatchObject({ reason: 'no_channel' });
    const d = discord({ permissions: [1n << 10n] });
    expect(await make(d).speak(item('a'))).toMatchObject({ reason: 'no_channel' });
    expect(d.sent).toEqual([]);
  });

  it('keeps quiet in the text channel for a moment after someone wrote there, and not for a bot or another channel', async () => {
    let clock = NOW;
    const d = discord();
    const sink = make(d, { now: () => clock });
    d.human('999');
    d.human(CHANNEL, true);
    expect(sink.room().sinceHumanMs).toBeNull();
    d.human();
    clock += 1_000;
    expect(await sink.speak(item('a'))).toEqual({ id: 'a', outcome: 'declined', reason: 'busy' });
    expect(sink.room()).toEqual({ voice: false, humanSpeaking: false, sinceHumanMs: 1000 });
    clock += 3_000;
    expect(await sink.speak(item('b'))).toMatchObject({ outcome: 'posted' });
  });

  it('tells the room: in voice or not, someone speaking, and the shorter of the two silences', async () => {
    let clock = NOW;
    const d = discord();
    let state = { inVoice: true, humanSpeaking: true, sinceHumanMs: 700 };
    const sink = make(d, { voice: mouth({ state: () => state }), now: () => clock });
    await sink.speak(item('warm')).catch(() => null);
    expect(sink.room()).toEqual({ voice: true, humanSpeaking: true, sinceHumanMs: 700 });
    d.human();
    clock += 200;
    state = { inVoice: true, humanSpeaking: false, sinceHumanMs: 5_000 };
    expect(sink.room()).toEqual({ voice: true, humanSpeaking: false, sinceHumanMs: 200 });
    state = { inVoice: false, humanSpeaking: true, sinceHumanMs: 10 };
    expect(sink.room()).toEqual({ voice: false, humanSpeaking: false, sinceHumanMs: 200 });
  });

  it('reports a failure to post as failed, never as thrown', async () => {
    const d = discord();
    d.channel.send.mockRejectedValueOnce(new Error('rate limited'));
    expect(await make(d).speak(item('a'))).toEqual({ id: 'a', outcome: 'failed', reason: 'error' });
  });
});

describe('the control loop and her lines', () => {
  function fixture(sink: LiveSpeechSink | null) {
    const requests: any[] = [], responses: any[] = [];
    let sequence = 0;
    const actuator: CommonFcaActuator = { skills: [], observe: () => ({ schemaVersion: 1, bodyId: 'minecraft:home', sequence: ++sequence,
      stateAt: new Date(NOW).toISOString(), receivedAt: new Date(NOW).toISOString(), state: {}, facts: {}, connected: true }),
      candidates: () => [], execute: vi.fn(), release: vi.fn(async () => true) };
    const loop = new CommonFcaControlLoop({ baseUrl: 'http://127.0.0.1:3000', token: 'fake-device-token', serverId: 'home', connectionId: 'connection1', now: () => NOW, actuator,
      speech: new LiveSpeechCourier(() => sink, () => NOW),
      fetcher: vi.fn(async (_, init) => { requests.push(JSON.parse(init!.body as string));
        return new Response(JSON.stringify({ schemaVersion: 1, mode: 'common-fca', commands: [], cancel: [], acknowledged: [], ...responses.shift() })); }) });
    return { loop, requests, responses };
  }

  it('sends neither the room nor receipts without a sink, and ignores a line it is sent', async () => {
    const f = fixture(null);
    f.responses.push({ speech: [item('a')] });
    await f.loop.poll();
    await f.loop.poll();
    expect(f.requests[0]).not.toHaveProperty('liveRoom');
    expect(f.requests[1]).not.toHaveProperty('speechReceipts');
    await f.loop.stop();
  });

  it('tells the room each poll, speaks the line a reply carries and tells what became of it', async () => {
    const speak = vi.fn(async (line: LiveSpeechItem) => ({ id: line.id, outcome: 'spoken' as const }));
    const f = fixture({ room: () => ({ voice: true, humanSpeaking: false, sinceHumanMs: 4000 }), speak });
    f.responses.push({ speech: [item('a')] });
    await f.loop.poll();
    expect(f.requests[0].liveRoom).toEqual({ voice: true, humanSpeaking: false, sinceHumanMs: 4000 });
    expect(f.requests[0]).not.toHaveProperty('speechReceipts');
    await flush();
    await f.loop.poll();
    expect(speak).toHaveBeenCalledTimes(1);
    expect(f.requests[1].speechReceipts).toEqual([{ id: 'a', outcome: 'spoken' }]);
    await f.loop.stop();
  });
});
