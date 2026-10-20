import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpeechFillerStore } from '../../src/services/discord/voice/speechFillerStore.js';
import { SpeechPlayer, type PlaybackSession } from '../../src/services/discord/voice/speechPlayer.js';
import type { TurnItem } from '../../src/services/discord/voice/turnQueue.js';
import { runDcVoiceTurn, type DcVoiceTurnEnv } from '../../src/services/llm/voice/dcVoiceTurn.js';
import type { VoiceTurnLine } from '../../src/services/integration/shannonCoreVoiceClient.js';
import {
  FakeAudio, audioMs, fakeSpeech, fakeVoiceClient, sampleRuns, scriptedTurn, sleep, wavMs,
  type ScriptedLine, type SpeechPlan,
} from '../helpers/dcVoiceFakes.js';

type Impl = Parameters<typeof fakeVoiceClient>[0] extends infer P ? (P extends { turn?: infer T } ? T : never) : never;
const audios: FakeAudio[] = [];
afterEach(() => { for (const audio of audios.splice(0)) audio.dispose(); });

function sentence(index: number, text: string, voiceText?: string): VoiceTurnLine {
  return { type: 'sentence', index, text, ...(voiceText ? { voiceText } : {}) };
}
const done = (reply: string): VoiceTurnLine => ({ type: 'done', reply, threadId: 't', duplicate: false });

function setup(options: { speech?: SpeechPlan; fillers?: boolean; turn?: ReturnType<typeof scriptedTurn> | Impl; env?: Partial<DcVoiceTurnEnv> } = {}) {
  const audio = new FakeAudio().auto(2);
  audios.push(audio);
  const player = new SpeechPlayer({ port: audio.port, createResource: audio.createResource, pollMs: 2 });
  const sessions: PlaybackSession[] = [];
  const open = player.open.bind(player);
  player.open = (kind, hooks) => { const session = open(kind, hooks); sessions.push(session); return session; };
  const store = new SpeechFillerStore();
  if (options.fillers !== false) store.set([{ id: 'un', text: 'うん。', pcm: audioMs(100, 5) }]);
  const { speech, stats } = fakeSpeech(options.speech);
  const turn = typeof options.turn === 'function' ? options.turn : vi.fn(async () => options.turn as never);
  const client = fakeVoiceClient({ turn: turn as never, speech });
  const posts: string[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const legacy = vi.fn(async (_item: TurnItem) => undefined);
  const voicepeakWav = vi.fn(async (_text: string) => wavMs(100));
  const now = Date.now();
  const item: TurnItem = {
    userId: '7', name: 'ライ', text: 'こんにちは', startedAt: now - 2_000, endAt: now, queuedAt: now,
    sttMs: 300, utteranceMs: 1_500, endpointMs: 610, parts: 1,
  };
  const env: DcVoiceTurnEnv = {
    conversationId: 'discord:1:2',
    voiceChannelId: '9',
    client,
    fillers: store,
    player,
    speakingNow: () => false,
    followsShannonTurn: () => false,
    participants: () => ['8'],
    heard: () => [],
    situation: () => undefined,
    voicepeakWav,
    legacy,
    postText: (text) => { posts.push(text); },
    log: (line) => logs.push(line),
    warn: (line) => warns.push(line),
    drainMs: 300,
    ...options.env,
  };
  const played = () => sampleRuns(audio.resources.flatMap(resource => resource.captured));
  return { env, item, client, stats, posts, logs, warns, legacy, voicepeakWav, sessions, audio, played, player };
}

describe('runDcVoiceTurn: through the head', () => {
  it('plays the filler at once, then every sentence in order as one stream, and posts the reply text', async () => {
    const turn = scriptedTurn(
      { respond: true, reason: 'named', filler: { id: 'un', text: 'うん。' } },
      [sentence(0, '一文目。'), { wait: 5 }, sentence(1, '二文目。', '[softly] 二文目。'), done('一文目。二文目。')],
    );
    const t = setup({
      turn,
      // the first sentence's voice is slow and the second one's quick: the order of play must not change
      speech: { ms: () => 200, delay: text => (text === '一文目。' ? 80 : 5), value: text => (text === '一文目。' ? 1 : 2) },
    });
    const result = await runDcVoiceTurn(t.env, t.item);
    const report = await t.sessions[0]!.whenDone();

    expect(result).toMatchObject({ responded: true, path: 'head' });
    expect(report.reason).toBe('completed');
    expect(report.spokenText).toBe('うん。一文目。二文目。');
    expect(t.played().map(([value]) => value)).toEqual([5, 1, 2]); // filler, sentence one, sentence two: no interleaving
    expect(t.stats.calls.map(call => call.text)).toEqual(['一文目。', '[softly] 二文目。']);
    expect(t.posts).toEqual(['🔊 シャノン: 一文目。二文目。']);
    expect(t.legacy).not.toHaveBeenCalled();
    expect(t.logs).toHaveLength(1);
    expect(t.logs[0]).toMatch(/^\[DcVoice\] turn id=\S+ user=7 endpointMs=610 sttMs=300 decisionMs=100 fillerStartMs=\d+ firstSentenceMs=\d+ firstAudioMs=\d+ totalMs=\d+ path=head respond=true inChars=5 outChars=8/);
    expect(t.logs[0]).not.toContain('こんにちは'); // lengths only, never the text
    const fillerStart = Number(/fillerStartMs=(\d+)/.exec(t.logs[0]!)![1]);
    const sentenceStart = Number(/firstSentenceMs=(\d+)/.exec(t.logs[0]!)![1]);
    expect(fillerStart).toBeLessThan(sentenceStart);
  });

  it('asks the head for at most 2 sentences at a time', async () => {
    const lines: ScriptedLine[] = [0, 1, 2, 3, 4].map(i => sentence(i, `文${i}。`));
    lines.push(done('x'));
    const t = setup({ turn: scriptedTurn({ respond: true, filler: null }, lines), speech: { delay: () => 40, ms: () => 60 } });
    await runDcVoiceTurn(t.env, t.item);
    expect(t.stats.calls).toHaveLength(5);
    expect(t.stats.max).toBe(2);
    expect((await t.sessions[0]!.whenDone()).spokenText).toBe('文0。文1。文2。文3。文4。');
  });

  it('names the conversation by its text channel when the body knows the name (one head titles a conversation nobody bound)', async () => {
    const silent: VoiceTurnLine = { type: 'done', reply: '', silent: true, reason: 'table_talk' };
    const t = setup({ turn: scriptedTurn({ respond: false, filler: null }, [silent]), env: { title: () => ' 雑談 ' } });
    await runDcVoiceTurn(t.env, t.item);
    expect(t.client.turn.mock.calls[0]![0]).toMatchObject({ conversationId: 'discord:1:2', conversationTitle: '雑談' });
    const nameless = setup({ turn: scriptedTurn({ respond: false, filler: null }, [silent]) });
    await runDcVoiceTurn(nameless.env, nameless.item);
    expect(nameless.client.turn.mock.calls[0]![0]).not.toHaveProperty('conversationTitle');
  });

  it('does not play a filler it has no audio for', async () => {
    const t = setup({ fillers: false, turn: scriptedTurn({ respond: true, filler: { id: 'un', text: 'うん。' } }, [sentence(0, 'はい。'), done('はい。')]) });
    await runDcVoiceTurn(t.env, t.item);
    expect((await t.sessions[0]!.whenDone()).segments.map(s => s.kind)).toEqual(['sentence']);
    expect(t.logs[0]).toContain('fillerStartMs=-');
  });

  it('says nothing when the head decides not to respond (the utterance becomes "heard")', async () => {
    const t = setup({ turn: scriptedTurn({ respond: false, reason: 'table_talk', filler: null }, [{ type: 'done', reply: '', silent: true, reason: 'table_talk' }]) });
    const result = await runDcVoiceTurn(t.env, t.item);
    expect(result).toMatchObject({ responded: false, path: 'head' });
    expect(t.sessions).toHaveLength(0);
    expect(t.stats.calls).toHaveLength(0);
    expect(t.posts).toEqual([]);
    expect(t.legacy).not.toHaveBeenCalled();
    expect(t.logs[0]).toContain('respond=false');
  });

  it('says only the sentence that VOICEPEAK has to, when one voice request fails', async () => {
    const t = setup({
      turn: scriptedTurn({ respond: true, filler: null }, [sentence(0, '正常。'), sentence(1, '失敗。'), sentence(2, 'また正常。'), done('x')]),
      speech: { fail: text => text === '失敗。', value: () => 1, ms: () => 100 },
    });
    await runDcVoiceTurn(t.env, t.item);
    expect(t.voicepeakWav).toHaveBeenCalledTimes(1);
    expect(t.voicepeakWav).toHaveBeenCalledWith('失敗。');
    expect(t.played().map(([value]) => value)).toEqual([1, 7, 1]); // 7 = the VOICEPEAK wav
    expect((await t.sessions[0]!.whenDone()).spokenText).toBe('正常。失敗。また正常。');
  });

  it('after an error line it stops quietly and does not repeat anything through the old path', async () => {
    const t = setup({
      turn: scriptedTurn({ respond: true, filler: { id: 'un', text: 'うん。' } }, [sentence(0, '言えた分。'), { type: 'error', status: 502, error: 'MODEL_UNAVAILABLE' }, sentence(1, '出ない。')]),
    });
    const result = await runDcVoiceTurn(t.env, t.item);
    expect(result.responded).toBe(true);
    expect(t.legacy).not.toHaveBeenCalled();
    expect((await t.sessions[0]!.whenDone()).spokenText).toBe('うん。言えた分。');
    expect(t.posts).toEqual(['🔊 シャノン: 言えた分。']);
    expect(t.logs[0]).toContain('note=error:MODEL_UNAVAILABLE');
  });

  it('an error right after the decision leaves just the filler, and still no old path', async () => {
    const t = setup({ turn: scriptedTurn({ respond: true, filler: { id: 'un', text: 'うん。' } }, [{ type: 'error', status: 502, error: 'MODEL_UNAVAILABLE' }]) });
    const result = await runDcVoiceTurn(t.env, t.item);
    expect(result).toMatchObject({ responded: true, path: 'filler_only' });
    expect(t.legacy).not.toHaveBeenCalled();
    expect(t.logs[0]).toContain('path=filler_only');
  });
});

describe('runDcVoiceTurn: falling back to the old path', () => {
  it.each([
    ['the decision did not come in time', { status: 'unavailable', reason: 'timeout' }],
    ['the head answered with an HTTP error', { status: 'unavailable', reason: 'http', httpStatus: 503 }],
    ['the connection failed', { status: 'unavailable', reason: 'network' }],
    ['the first line was not a decision', { status: 'unavailable', reason: 'protocol' }],
  ])('hands the utterance to invokeGraph -> VOICEPEAK when %s', async (_name, outcome) => {
    const t = setup({ turn: outcome as never });
    const result = await runDcVoiceTurn(t.env, t.item);
    expect(result).toMatchObject({ responded: true, path: 'legacy' });
    expect(t.legacy).toHaveBeenCalledTimes(1);
    expect(t.legacy.mock.calls[0]![0]).toMatchObject({ userId: '7', text: 'こんにちは' });
    expect(t.sessions).toHaveLength(0);
    expect(t.logs[0]).toMatch(/path=legacy respond=true/);
  });

  it('stays silent (no old path) when the head rate-limits', async () => {
    const t = setup({ turn: { status: 'rate_limited' } as never });
    const result = await runDcVoiceTurn(t.env, t.item);
    expect(result).toMatchObject({ responded: false });
    expect(t.legacy).not.toHaveBeenCalled();
    expect(t.logs[0]).toContain('note=rate_limited');
  });

  it('does nothing when the turn was aborted from our side (the VC was left)', async () => {
    const t = setup({ turn: { status: 'unavailable', reason: 'aborted' } as never });
    await runDcVoiceTurn(t.env, t.item);
    expect(t.legacy).not.toHaveBeenCalled();
  });

  it('passes the decision timeout on to the client (4 s by default is the client\'s; tests may shorten it)', async () => {
    const t = setup({ turn: { status: 'unavailable', reason: 'timeout' } as never, env: { decisionTimeoutMs: 1234 } });
    await runDcVoiceTurn(t.env, t.item);
    expect(t.client.turn.mock.calls[0]![1]).toMatchObject({ decisionTimeoutMs: 1234 });
  });
});

describe('runDcVoiceTurn: what is sent to the head', () => {
  it('sends who is here, what was heard, the situation, and whether Shannon was just speaking', async () => {
    const t = setup({
      turn: { status: 'unavailable', reason: 'http' } as never,
      env: {
        participants: () => ['8', '9'],
        heard: (exclude) => [{ userId: '8', name: 'ミキ', text: '寒いね', at: Date.parse('2026-10-20T10:00:00Z') }].filter(entry => entry.userId !== exclude),
        situation: () => '洞窟を下りている',
        speakingNow: () => true,
        followsShannonTurn: () => true,
      },
    });
    await runDcVoiceTurn(t.env, t.item);
    const sent = t.client.turn.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(sent).toMatchObject({
      conversationId: 'discord:1:2',
      voiceChannelId: '9',
      sourceUserId: '7',
      sourceDisplayName: 'ライ',
      userMessage: 'こんにちは',
      participants: ['8', '9', '7'], // the speaker is always included
      heard: [{ userId: '8', name: 'ミキ', text: '寒いね', at: '2026-10-20T10:00:00.000Z' }],
      situation: '洞窟を下りている',
      followsShannonTurn: true,
      speakingNow: true,
      sttMs: 300,
      utteranceMs: 1500,
    });
    expect(sent.observedAt).toBe(new Date(t.item.endAt).toISOString());
    expect(typeof sent.requestId).toBe('string');
  });
});

describe('runDcVoiceTurn: being cut off', () => {
  it('stops at once, drops the rest, and tells the head what was really said', async () => {
    const turn = scriptedTurn(
      { respond: true, filler: { id: 'un', text: 'うん。' } },
      [sentence(0, 'あいうえおかきくけこ。'), sentence(1, 'まだ言ってない。'), { wait: 60 }, sentence(2, 'これも言わない。'), done('あいうえおかきくけこ。まだ言ってない。これも言わない。')],
    );
    const t = setup({ turn, speech: { ms: () => 2_000, value: () => 1 } });
    const running = runDcVoiceTurn(t.env, t.item);

    // wait until the first sentence has started playing, then cut in
    for (let i = 0; i < 200 && !t.sessions[0]?.startedAt; i += 1) await sleep(5);
    for (let i = 0; i < 400; i += 1) {
      if (t.audio.resources.reduce((sum, resource) => sum + resource.consumedBytes, 0) > 100 * 192 + 600 * 192) break;
      await sleep(2);
    }
    const stopStartedAt = Date.now();
    const report = t.player.stop('barge_in')!;
    const result = await running;

    expect(Date.now() - stopStartedAt).toBeLessThan(100); // the turn lets go immediately
    expect(report.reason).toBe('barge_in');
    expect(result.responded).toBe(true);
    await result.settled;
    expect(t.client.said).toHaveBeenCalledTimes(1);
    const said = t.client.said.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(said).toMatchObject({ conversationId: 'discord:1:2', source: 'reply', interrupted: true });
    expect(said.spokenText).toBe(report.spokenText);
    expect(String(said.spokenText).startsWith('うん。')).toBe(true);
    expect(String(said.spokenText).length).toBeLessThan('うん。あいうえおかきくけこ。'.length);
    // the full intended reply travels with it, including sentences that arrived after the cut
    expect(said.text).toBe('あいうえおかきくけこ。まだ言ってない。これも言わない。');
    expect(t.posts[0]).toMatch(/^🔊 シャノン: あ/);
    expect(t.posts[0]).not.toContain('まだ言ってない');
    expect(t.logs[0]).toContain('note=interrupted:barge_in');
    expect(t.legacy).not.toHaveBeenCalled();
  });
});

describe('runDcVoiceTurn: backchannel before the decision (one person alone in the VC)', () => {
  const longText = 'ちょっと相談したいことがあるんだけど';

  it('starts the filler without waiting for the decision, tells the head which one, and does not play it twice', async () => {
    let playingBeforeDecision = false;
    let ref: ReturnType<typeof setup> | null = null;
    const turn = vi.fn(async () => {
      await sleep(250); // a slow head
      playingBeforeDecision = Boolean(ref!.sessions[0]?.startedAt);
      return scriptedTurn({ respond: true, filler: { id: 'un', text: 'うん。' } }, [sentence(0, 'いいよ。'), done('いいよ。')]);
    });
    const t = setup({ turn: turn as never, env: { participants: () => [] } });
    ref = t;
    t.item.text = longText;
    await runDcVoiceTurn(t.env, t.item);
    expect(playingBeforeDecision).toBe(true);
    expect((t.client.turn.mock.calls[0]![0] as { fillerId?: string }).fillerId).toBe('un');
    expect((await t.sessions[0]!.whenDone()).spokenText).toBe('うん。いいよ。'); // once
    expect(t.played().map(([value]) => value).filter(value => value === 5)).toHaveLength(1);
  });

  it.each([
    ['a short message', 'うん、そう'],
    ['an urgent word', 'ちょっと止まって、そこ危ないから'],
    ['an apology', 'さっきは本当にごめんなさいでした'],
    ['thanks', 'いつも手伝ってくれてありがとうね'],
  ])('does not for %s', async (_name, text) => {
    const t = setup({ turn: scriptedTurn({ respond: true, filler: null }, [sentence(0, 'はい。'), done('はい。')]), env: { participants: () => [] } });
    t.item.text = text;
    await runDcVoiceTurn(t.env, t.item);
    expect((t.client.turn.mock.calls[0]![0] as { fillerId?: string }).fillerId).toBeUndefined();
    expect((await t.sessions[0]!.whenDone()).spokenText).toBe('はい。');
  });

  it('does not when other people are in the VC (the decision decides)', async () => {
    const t = setup({ turn: scriptedTurn({ respond: true, filler: null }, [sentence(0, 'はい。'), done('はい。')]), env: { participants: () => ['8'] } });
    t.item.text = longText;
    await runDcVoiceTurn(t.env, t.item);
    expect((t.client.turn.mock.calls[0]![0] as { fillerId?: string }).fillerId).toBeUndefined();
  });

  it('lets the filler finish before the old path takes over when the head turns out to be down', async () => {
    const t = setup({ turn: { status: 'unavailable', reason: 'timeout' } as never, env: { participants: () => [] } });
    t.item.text = longText;
    let fillerOverWhenLegacyStarted = false;
    t.legacy.mockImplementation(async () => { fillerOverWhenLegacyStarted = t.sessions[0]!.isOver; });
    const result = await runDcVoiceTurn(t.env, t.item);
    expect(result.path).toBe('legacy');
    expect(fillerOverWhenLegacyStarted).toBe(true);
  });
});