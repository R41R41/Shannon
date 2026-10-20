import { afterEach, describe, expect, it, vi } from 'vitest';
import { DcVoiceGuildSession } from '../../src/services/discord/voice/dcVoiceGuild.js';
import { SpeechFillerStore } from '../../src/services/discord/voice/speechFillerStore.js';
import { SpeechPlayer, type PlaybackSession } from '../../src/services/discord/voice/speechPlayer.js';
import { VoiceMouth } from '../../src/services/discord/voice/voiceMouthCore.js';
import type { TurnItem } from '../../src/services/discord/voice/turnQueue.js';
import type { VoiceTurnRequest } from '../../src/services/integration/shannonCoreVoiceClient.js';
import {
  FakeAudio, FakeReceiver, audioMs, fakeDecode, fakeSpeech, fakeStt, fakeVoiceClient, scriptedTurn, sleep, waitFor, wavMs,
  type ScriptedLine, type SpeechPlan,
} from '../helpers/dcVoiceFakes.js';
import type { VoiceTurnDecision } from '../../src/services/integration/shannonCoreVoiceClient.js';

interface Scenario { decision: VoiceTurnDecision; script: ScriptedLine[] }

const disposables: Array<() => void> = [];
afterEach(() => { for (const dispose of disposables.splice(0)) dispose(); });

const say = (index: number, text: string): ScriptedLine => ({ type: 'sentence', index, text });
const finished = (reply: string): ScriptedLine => ({ type: 'done', reply, threadId: 't', duplicate: false });
const respond = (script: ScriptedLine[], filler: VoiceTurnDecision['filler'] = null): Scenario => ({ decision: { respond: true, filler }, script });

function makeSession(options: {
  scenarios?: Record<string, Scenario>;
  speech?: SpeechPlan;
  manualAudio?: boolean;
  shouldListen?: (userId: string) => boolean;
  headDown?: boolean;
  /** The head holds mouth polls open until the test answers or the request is aborted. */
  holdPolls?: boolean;
} = {}) {
  const receiver = new FakeReceiver();
  const audio = new FakeAudio();
  if (!options.manualAudio) audio.auto(2);
  const player = new SpeechPlayer({ port: audio.port, createResource: audio.createResource, pollMs: 2 });
  const sessions: PlaybackSession[] = [];
  const open = player.open.bind(player);
  player.open = (kind, hooks) => { const session = open(kind, hooks); sessions.push(session); return session; };
  const store = new SpeechFillerStore();
  store.set([{ id: 'un', text: 'うん。', pcm: audioMs(80, 5) }]);
  const mouth = new VoiceMouth({ enabled: () => true, pollWaitMs: 25_000 });
  const { speech } = fakeSpeech(options.speech ?? { ms: () => 150 });
  const requests: VoiceTurnRequest[] = [];
  const turn = vi.fn(async (request: VoiceTurnRequest) => {
    requests.push(request);
    const scenario = options.scenarios?.[request.userMessage];
    if (options.headDown || !scenario) return { status: 'unavailable' as const, reason: 'http' as const, httpStatus: 503 };
    return scriptedTurn(scenario.decision, scenario.script);
  });
  const polls = { pending: [] as Array<(value: unknown) => void>, signals: [] as AbortSignal[] };
  const client = fakeVoiceClient({ turn: turn as never, speech });
  if (options.holdPolls) {
    client.mouthPoll.mockImplementation((async (_wait: number, o?: { signal?: AbortSignal }) => new Promise((resolve) => {
      polls.pending.push(resolve);
      if (o?.signal) {
        polls.signals.push(o.signal);
        o.signal.addEventListener('abort', () => resolve({ status: 'unavailable', reason: 'aborted' }));
      }
    })) as never);
  }
  const posts: string[] = [];
  const logs: string[] = [];
  const legacy = vi.fn(async (_item: TurnItem) => undefined);
  const stt = fakeStt({ 1: 'こんにちは', 2: 'ねえ', 3: 'ちょっと', 4: 'さっきの話だけど' });
  const session = new DcVoiceGuildSession({
    guildId: 'g1',
    textChannelId: 't1',
    voiceChannelId: 'v1',
    receiver: receiver as never,
    endBehaviorAfterSilence: 1,
    decodeOpus: fakeDecode,
    isBot: userId => userId === 'bot',
    displayName: userId => `name-${userId}`,
    humanIds: () => ['u1', 'u2'],
    shouldListen: options.shouldListen ?? (() => true),
    player,
    client: client as never,
    fillers: store,
    stt,
    voicepeakWav: async () => wavMs(80),
    legacy,
    postText: text => { posts.push(text); },
    mouth,
    backchannel: false,
    log: line => logs.push(line),
    warn: line => logs.push(line),
    drainMs: 200,
  });
  session.start();
  disposables.push(() => { session.dispose(); audio.dispose(); });
  /** A person speaks for `packets` * 20 ms (tag picks the text) and then falls silent for good. */
  const speak = (userId: string, tag: number, packets = 40) => {
    receiver.speak(userId);
    receiver.feed(userId, packets, tag);
    receiver.quiet(userId);
    receiver.end(userId);
  };
  return { session, receiver, audio, player, sessions, mouth, client, turn, requests, posts, logs, legacy, stt, speak, store, polls };
}

describe('DcVoiceGuildSession: one person talks to Shannon', () => {
  it('hears the utterance, shows the transcript, asks the head, plays the reply, posts it', async () => {
    const t = makeSession({ scenarios: { こんにちは: respond([say(0, 'やあ。'), say(1, 'どうしたの？'), finished('やあ。どうしたの？')], { id: 'un', text: 'うん。' }) } });
    t.speak('u1', 1);
    await waitFor(() => t.sessions.length > 0, 2_000, 'a reply to start');
    await t.sessions[0]!.whenDone();
    await t.session.idle();

    expect(t.receiver.subscriptions[0]!.options.end).toEqual({ behavior: 1, duration: 600 });
    expect(t.posts).toEqual(['🎤 name-u1: こんにちは', '🔊 シャノン: やあ。どうしたの？']);
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).toMatchObject({
      conversationId: 'discord:g1:t1', voiceChannelId: 'v1', sourceUserId: 'u1', sourceDisplayName: 'name-u1',
      userMessage: 'こんにちは', participants: ['u1', 'u2'], heard: [], speakingNow: false, followsShannonTurn: false,
    });
    expect(t.requests[0]!.utteranceMs).toBe(800);
    expect(t.requests[0]!.sttMs).toBe(5);
    expect((await t.sessions[0]!.whenDone()).spokenText).toBe('うん。やあ。どうしたの？');
    expect(t.legacy).not.toHaveBeenCalled();
    expect(t.logs.filter(line => line.startsWith('[DcVoice] turn ')).length).toBe(1);
  });

  it('uses the old path for the utterance when the head cannot be reached (after the transcript is shown)', async () => {
    const t = makeSession({ headDown: true });
    t.speak('u1', 1);
    await waitFor(() => t.legacy.mock.calls.length > 0, 2_000, 'the old path');
    expect(t.legacy.mock.calls[0]![0]).toMatchObject({ userId: 'u1', name: 'name-u1', text: 'こんにちは' });
    expect(t.posts).toEqual(['🎤 name-u1: こんにちは']); // the old path posts only the reply it makes
    expect(t.sessions).toHaveLength(0);
  });

  it('ignores a "not for me" decision but remembers it for the next request', async () => {
    const t = makeSession({
      scenarios: {
        ねえ: { decision: { respond: false, filler: null }, script: [{ type: 'done', reply: '', silent: true, reason: 'table_talk' }] },
        こんにちは: respond([say(0, 'うん。'), finished('うん。')]),
      },
    });
    t.speak('u2', 2);
    await waitFor(() => t.requests.length === 1, 2_000, 'first request');
    await t.session.idle();
    expect(t.sessions).toHaveLength(0);
    t.speak('u1', 1);
    await waitFor(() => t.requests.length === 2, 2_000, 'second request');
    expect(t.requests[1]!.heard).toMatchObject([{ userId: 'u2', name: 'name-u2', text: 'ねえ' }]);
  });

  it('marks a follow-up that comes soon after Shannon spoke', async () => {
    const t = makeSession({ scenarios: { こんにちは: respond([say(0, 'うん。'), finished('うん。')]), ねえ: respond([say(0, 'なに？'), finished('なに？')]) } });
    t.speak('u1', 1);
    await waitFor(() => t.sessions.length === 1, 2_000, 'first reply');
    await t.sessions[0]!.whenDone();
    await t.session.idle();
    t.speak('u1', 2);
    await waitFor(() => t.requests.length === 2, 2_000, 'follow-up');
    expect(t.requests[1]!.followsShannonTurn).toBe(true);
    // The head counts its follow-up window (SHANNON_ADDRESSED) from the end of her speech: told only once she has spoken.
    expect(t.requests[0]).not.toHaveProperty('shannonSpokeMsAgo');
    expect(t.requests[1]!.shannonSpokeMsAgo).toBeGreaterThanOrEqual(0);
    expect(t.requests[1]!.shannonSpokeMsAgo).toBeLessThan(8_000);
  });
});

describe('DcVoiceGuildSession: several people', () => {
  it('hears two people talking at the same time separately, and answers them one after the other', async () => {
    const t = makeSession({
      scenarios: {
        こんにちは: respond([say(0, '一人目。'), { wait: 120 }, finished('一人目。')]),
        ねえ: respond([say(0, '二人目。'), finished('二人目。')]),
      },
    });
    // interleaved packets from two people
    t.receiver.speak('u1');
    t.receiver.speak('u2');
    for (let i = 0; i < 40; i += 1) { t.receiver.feed('u1', 1, 1); t.receiver.feed('u2', 1, 2); }
    t.receiver.end('u1');
    t.receiver.end('u2');

    await waitFor(() => t.requests.length >= 1, 2_000, 'first request');
    const firstTurnStarted = Date.now();
    expect(t.requests).toHaveLength(1); // the second person waits while the first is answered
    await waitFor(() => t.requests.length === 2, 3_000, 'second request');
    expect(t.sessions[0]!.isOver).toBe(true); // ...until the first reply was fully played
    expect(Date.now() - firstTurnStarted).toBeGreaterThan(100);
    expect(t.requests.map(r => [r.sourceUserId, r.userMessage])).toEqual([['u1', 'こんにちは'], ['u2', 'ねえ']]);
    expect(t.stt).toHaveBeenCalledTimes(2);
    await waitFor(() => t.sessions.length === 2, 2_000, 'second reply');
    await t.sessions[1]!.whenDone();
    await waitFor(() => t.posts.filter(post => post.startsWith('🔊')).length === 2, 2_000, 'both replies posted');
    expect(t.posts.filter(post => post.startsWith('🔊'))).toEqual(['🔊 シャノン: 一人目。', '🔊 シャノン: 二人目。']);
  });

  it('joins what one waiting person says in a row', async () => {
    const t = makeSession({
      scenarios: {
        こんにちは: respond([say(0, '少し長い返事。'), { wait: 200 }, finished('x')]),
        'ねえ、ちょっと': respond([say(0, 'なあに。'), finished('なあに。')]),
      },
    });
    t.speak('u1', 1);
    await waitFor(() => t.requests.length === 1, 2_000, 'first request');
    t.speak('u2', 2);
    await sleep(20);
    t.speak('u2', 3);
    await waitFor(() => t.requests.length === 2, 3_000, 'second request');
    expect(t.requests[1]).toMatchObject({ sourceUserId: 'u2', userMessage: 'ねえ、ちょっと' });
    expect(t.requests).toHaveLength(2);
  });

  it('only transcribes the people it should (push-to-talk), but still sees everybody speak', async () => {
    const t = makeSession({ shouldListen: userId => userId === 'u1', scenarios: { こんにちは: respond([say(0, 'うん。'), finished('うん。')]) } });
    t.receiver.speak('u2');
    expect(t.session.tracker.isSpeaking('u2')).toBe(true);
    expect(t.receiver.subscriptions).toHaveLength(0);
    expect(t.stt).not.toHaveBeenCalled();
    t.speak('u1', 1);
    await waitFor(() => t.requests.length === 1, 2_000, 'u1 turn');
    expect(t.requests[0]!.sourceUserId).toBe('u1');
  });

  it('ignores bots completely', async () => {
    const t = makeSession();
    t.receiver.speak('bot');
    expect(t.session.tracker.isSpeaking('bot')).toBe(false);
    expect(t.receiver.subscriptions).toHaveLength(0);
  });
});

describe('DcVoiceGuildSession: the mouth and the conversation never overlap', () => {
  it('holds a mouth line until the reply is over, then says it', async () => {
    const t = makeSession({
      scenarios: { こんにちは: respond([say(0, '返事の一文目。'), { wait: 150 }, say(1, '二文目。'), finished('x')]) },
      speech: { ms: () => 200 },
    });
    t.speak('u1', 1);
    await waitFor(() => t.sessions.length === 1, 2_000, 'reply to start');
    const mouthResult = t.mouth.say({ text: 'ダイヤ見つけた！', source: 'minecraft:milestone' });
    expect(mouthResult.accepted).toBe(true);
    await sleep(100);
    expect(t.sessions).toHaveLength(1); // still the reply: the mouth has not started
    expect(await mouthResult.done).toBe('spoken');
    expect(t.sessions.map(s => s.kind)).toEqual(['reply', 'mouth']);
    expect((await t.sessions[0]!.whenDone()).reason).toBe('completed'); // the reply was never cut by the mouth
    expect((await t.sessions[1]!.whenDone()).reason).toBe('completed');
    expect(t.client.said.mock.calls.some(call => (call[0] as { source: string }).source === 'mouth')).toBe(true);
  });

  it('says a mouth line when idle, with the head\'s voice, and a person talking stops it', async () => {
    const t = makeSession({ speech: { ms: () => 3_000 }, manualAudio: true });
    const result = t.mouth.say({ text: 'のんびり話す一言です。', source: 'a' });
    await waitFor(() => t.sessions.length === 1, 2_000, 'mouth line');
    await waitFor(() => t.audio.current !== null, 2_000, 'audio');
    t.receiver.speak('u2'); // a person starts talking
    expect(await result.done).toBe('interrupted');
    expect(t.sessions[0]!.isOver).toBe(true);
  });

  it('does not start a mouth line in the gap between a person finishing and their turn being queued', async () => {
    const t = makeSession({ scenarios: { こんにちは: respond([say(0, 'うん。'), finished('うん。')]) } });
    // the transcription is slow
    t.stt.mockImplementationOnce(async () => { await sleep(150); return { status: 'ok' as const, text: 'こんにちは', sttMs: 150 }; });
    t.speak('u1', 1);
    await sleep(20);
    const mouthResult = t.mouth.say({ text: '割り込みたい一言。', source: 'x' });
    await sleep(100);
    expect(t.sessions).toHaveLength(0); // waiting: an utterance is being transcribed
    await waitFor(() => t.sessions.length >= 1, 2_000, 'first playback');
    expect(t.sessions[0]!.kind).toBe('reply');
    expect(await mouthResult.done).toBe('spoken');
  });
});

describe('DcVoiceGuildSession: barge-in', () => {
  it('stops the reply when a person talks over it for 0.4 s, tells the head, and then hears that person normally', async () => {
    const t = makeSession({
      manualAudio: true,
      speech: { ms: () => 3_000 },
      scenarios: {
        こんにちは: respond([say(0, 'ながい文。'), say(1, 'つづき。'), finished('ながい文。つづき。')]),
        さっきの話だけど: respond([say(0, 'うん、聞くよ。'), finished('うん、聞くよ。')]),
      },
    });
    t.speak('u1', 1);
    await waitFor(() => t.audio.current !== null && t.audio.current.stream.readableLength > 1_600 * 192, 3_000, 'the reply audio');
    t.audio.advance(1_500); // 1.5 s of the 3 s sentence have gone out
    await waitFor(() => t.player.speaking() !== null, 1_000, 'speaking');
    await sleep(600); // past the 0.5 s grace
    const cutAt = Date.now();
    t.receiver.speak('u2');
    await waitFor(() => t.sessions[0]!.isOver, 2_000, 'the cut');
    expect(Date.now() - cutAt).toBeGreaterThanOrEqual(380);
    expect(Date.now() - cutAt).toBeLessThan(700);
    const report = await t.sessions[0]!.whenDone();
    expect(report.reason).toBe('barge_in');
    expect(report.spokenText).toBe('なが');
    await t.session.idle();
    expect(t.client.said).toHaveBeenCalledTimes(1);
    expect(t.client.said.mock.calls[0]![0]).toMatchObject({ source: 'reply', interrupted: true, spokenText: 'なが' });

    // that person goes on talking, and is heard like anybody else
    t.receiver.feed('u2', 40, 4);
    t.receiver.quiet('u2');
    t.receiver.end('u2');
    await waitFor(() => t.requests.length === 2, 3_000, 'the interrupting person\'s turn');
    expect(t.requests[1]).toMatchObject({ sourceUserId: 'u2', userMessage: 'さっきの話だけど', followsShannonTurn: true });
  });

  it('does not treat a quick "un" in the first half second as an interruption', async () => {
    const t = makeSession({ manualAudio: true, speech: { ms: () => 3_000 }, scenarios: { こんにちは: respond([say(0, 'ながい文。'), finished('x')]) } });
    t.speak('u1', 1);
    await waitFor(() => t.audio.current !== null && t.audio.current.stream.readableLength > 100 * 192, 3_000, 'audio');
    t.audio.advance(100);
    await waitFor(() => t.player.speaking() !== null, 1_000, 'speaking');
    t.receiver.speak('u2');
    await sleep(150);
    t.receiver.quiet('u2');
    await sleep(900);
    expect(t.sessions[0]!.isOver).toBe(false);
    t.session.dispose();
  });
});

describe('DcVoiceGuildSession: leaving the VC', () => {
  it('stops listening, stops playing, and the mouth stops asking the head', async () => {
    const t = makeSession({
      manualAudio: true,
      holdPolls: true,
      speech: { ms: () => 3_000 },
      scenarios: { こんにちは: respond([say(0, 'ながい文。'), finished('x')]) },
    });
    await waitFor(() => t.client.mouthPoll.mock.calls.length >= 1, 1_000, 'a poll');
    expect(t.mouth.polling).toBe(true);

    t.speak('u1', 1);
    await waitFor(() => t.audio.current !== null, 3_000, 'playing');
    t.session.dispose();

    expect(t.mouth.polling).toBe(false);
    expect(t.polls.signals.at(-1)!.aborted).toBe(true);
    expect(t.mouth.hasHost()).toBe(false);
    expect(t.sessions[0]!.isOver).toBe(true);
    const calls = t.client.mouthPoll.mock.calls.length;
    await sleep(1_300);
    expect(t.client.mouthPoll.mock.calls.length).toBe(calls); // no more asking
    const subscriptions = t.receiver.subscriptions.length;
    t.receiver.speak('u2'); // nothing is heard after leaving
    expect(t.receiver.subscriptions.length).toBe(subscriptions);
  });
});