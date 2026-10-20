import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpeakerTracker } from '../../src/services/discord/voice/speakerTracker.js';
import { VoiceMouth, clipText, type MouthHost, type MouthLineHandle } from '../../src/services/discord/voice/voiceMouthCore.js';
import type { MouthQueueItem } from '../../src/services/integration/shannonCoreVoiceClient.js';
import { fakeVoiceClient } from '../helpers/dcVoiceFakes.js';

interface LineControl {
  text: string;
  tags?: string;
  stopped: boolean;
  finish(status: 'spoken' | 'failed', spokenText?: string): void;
}

function setup(options: { enabled?: boolean } = {}) {
  const tracker = new SpeakerTracker();
  const state = { conversation: false, busy: false };
  const changeListeners = new Set<() => void>();
  const lines: LineControl[] = [];
  const client = fakeVoiceClient();
  const host: MouthHost = {
    guildId: 'g1',
    conversationId: 'discord:g1:t1',
    client,
    tracker,
    conversationActive: () => state.conversation,
    playbackBusy: () => state.busy,
    onConversationChange: (listener) => { changeListeners.add(listener); return () => changeListeners.delete(listener); },
    participants: () => ['u1'],
    heard: () => [],
    speakLine: (text, tags): MouthLineHandle => {
      let resolve!: (value: { status: 'spoken' | 'stopped' | 'failed'; spokenText: string }) => void;
      const done = new Promise<{ status: 'spoken' | 'stopped' | 'failed'; spokenText: string }>(res => { resolve = res; });
      const control: LineControl = {
        text, tags, stopped: false,
        finish: (status, spokenText = text) => resolve({ status, spokenText }),
      };
      lines.push(control);
      return {
        done,
        stop: () => { control.stopped = true; resolve({ status: 'stopped', spokenText: text.slice(0, 3) }); },
      };
    },
  };
  const logs: string[] = [];
  const mouth = new VoiceMouth({ enabled: () => options.enabled ?? true, log: line => logs.push(line), pollWaitMs: 25_000 });
  return {
    mouth, host, tracker, state, lines, client, logs,
    notify: () => changeListeners.forEach(listener => listener()),
  };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000_000); });
afterEach(() => { vi.useRealTimers(); });

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('VoiceMouth: switches and states never throw', () => {
  it('reports disabled / not_in_voice instead of throwing', async () => {
    const off = setup({ enabled: false });
    off.mouth.attach(off.host);
    const disabled = off.mouth.say({ text: 'やあ', source: 'a' });
    expect(disabled).toMatchObject({ accepted: false, reason: 'disabled' });
    expect(await disabled.done).toBe('disabled');

    const detached = setup();
    const notIn = detached.mouth.say({ text: 'やあ', source: 'a' });
    expect(notIn).toMatchObject({ accepted: false, reason: 'not_in_voice' });
    expect(await notIn.done).toBe('not_in_voice');
  });

  it('survives nonsense input', async () => {
    const t = setup();
    t.mouth.attach(t.host);
    for (const bad of [null, undefined, {}, { source: 'x' }, { text: '', source: 'x' }, { text: 'a', facts: ['b'], source: 'x' }, { text: 'a' }, 5]) {
      const result = t.mouth.say(bad as never);
      expect(result.accepted).toBe(false);
      expect(await result.done).toBe('dropped_busy');
    }
    t.mouth.setSituation(null as never);
    expect(t.mouth.getSituation()).toBeUndefined();
  });

  it('cuts a line to 120 characters, at a sentence end when there is one', () => {
    expect(clipText('あ'.repeat(120))).toHaveLength(120);
    expect(clipText('あ'.repeat(200))).toHaveLength(120);
    const withStop = `${'あ'.repeat(60)}。${'い'.repeat(100)}`;
    expect(clipText(withStop)).toBe(`${'あ'.repeat(60)}。`);
  });

  it('speaks a plain line right away when nothing is going on, and records it for the head', async () => {
    const t = setup();
    t.mouth.attach(t.host);
    const result = t.mouth.say({ text: 'ダイヤ見つけた！', source: 'minecraft:milestone', tags: '[excited]' });
    expect(result.accepted).toBe(true);
    await tick(0);
    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]).toMatchObject({ text: 'ダイヤ見つけた！', tags: '[excited]' });
    t.lines[0]!.finish('spoken');
    expect(await result.done).toBe('spoken');
    expect(t.client.said).toHaveBeenCalledTimes(1);
    expect(t.client.said.mock.calls[0]![0]).toMatchObject({ conversationId: 'discord:g1:t1', text: 'ダイヤ見つけた！', source: 'mouth' });
    expect((t.client.said.mock.calls[0]![0] as Record<string, unknown>).interrupted).toBeUndefined();
  });
});

describe('VoiceMouth rule 1: never while a person is talking', () => {
  it('waits until the person has been quiet for 0.8 s', async () => {
    const t = setup();
    t.mouth.attach(t.host);
    t.tracker.start('u1');
    const result = t.mouth.say({ text: 'ねえ', source: 'a', maxWaitMs: 60_000 });
    await tick(5_000);
    expect(t.lines).toHaveLength(0);
    t.tracker.end('u1');
    await tick(799);
    expect(t.lines).toHaveLength(0);
    await tick(2);
    expect(t.lines).toHaveLength(1);
    t.lines[0]!.finish('spoken');
    expect(await result.done).toBe('spoken');
  });

  it('gives up after maxWaitMs (expired)', async () => {
    const t = setup();
    t.mouth.attach(t.host);
    t.tracker.start('u1');
    const result = t.mouth.say({ text: 'ねえ', source: 'a', maxWaitMs: 1_000 });
    await tick(1_001);
    expect(await result.done).toBe('expired');
    t.tracker.end('u1');
    await tick(5_000);
    expect(t.lines).toHaveLength(0);
  });

  it('uses 3 s / 8 s / 4 s as the waits for high / normal / low when none is given', async () => {
    const t = setup();
    t.mouth.attach(t.host);
    t.tracker.start('u1');
    const high = t.mouth.say({ text: 'a', source: 'h', priority: 'high' });
    const normal = t.mouth.say({ text: 'b', source: 'n' });
    const low = t.mouth.say({ text: 'c', source: 'l', priority: 'low' });
    await tick(3_001);
    expect(await high.done).toBe('expired');
    await tick(1_000);
    expect(await low.done).toBe('expired');
    await tick(4_000);
    expect(await normal.done).toBe('expired');
  });
});

describe('VoiceMouth rule 2 and 6: a reply in progress is never interrupted', () => {
  it('normal waits until the reply is over, then speaks', async () => {
    const t = setup();
    t.mouth.attach(t.host);
    t.state.conversation = true;
    t.state.busy = true;
    const result = t.mouth.say({ text: 'あとで言う', source: 'a', maxWaitMs: 30_000 });
    await tick(3_000);
    expect(t.lines).toHaveLength(0);
    t.state.conversation = false;
    t.state.busy = false;
    t.notify();
    await tick(1);
    expect(t.lines).toHaveLength(1);
    t.lines[0]!.finish('spoken');
    expect(await result.done).toBe('spoken');
  });

  it('low is dropped as soon as a conversation is going on; normal waits; high goes first after the reply', async () => {
    const t = setup();
    t.mouth.attach(t.host);
    t.state.conversation = true;
    const low = t.mouth.say({ text: '低', source: 'l', priority: 'low' });
    expect(await low.done).toBe('dropped_busy');
    const normal = t.mouth.say({ text: '普通', source: 'n', maxWaitMs: 30_000 });
    const high = t.mouth.say({ text: '高', source: 'h', priority: 'high', maxWaitMs: 30_000 });
    await tick(2_000);
    expect(t.lines).toHaveLength(0);
    t.state.conversation = false;
    t.notify();
    await tick(1);
    expect(t.lines.map(line => line.text)).toEqual(['高']);
    t.lines[0]!.finish('spoken');
    expect(await high.done).toBe('spoken');
    await tick(1_501); // high's gap
    // normal has to wait for the 5 s gap after a line (the gap that applies is the one for the *next* line)
    expect(t.lines).toHaveLength(1);
    await tick(3_600);
    expect(t.lines.map(line => line.text)).toEqual(['高', '普通']);
    t.lines[1]!.finish('spoken');
    expect(await normal.done).toBe('spoken');
  });

  it('drops a waiting low line when a conversation starts', async () => {
    const t = setup();
    t.mouth.attach(t.host);
    t.tracker.start('u1'); // a person is talking: the low line has to wait
    const low = t.mouth.say({ text: '低', source: 'l', priority: 'low', maxWaitMs: 30_000 });
    await tick(500);
    t.state.conversation = true; // the talk turned out to be addressed to Shannon
    t.notify();
    expect(await low.done).toBe('dropped_busy');
  });

  it('also waits while Shannon is voicing something else', async () => {
    const t = setup();
    t.mouth.attach(t.host);
    t.state.busy = true;
    t.mouth.say({ text: '待つ', source: 'a', maxWaitMs: 30_000 });
    await tick(2_000);
    expect(t.lines).toHaveLength(0);
    t.state.busy = false;
    await tick(300);
    expect(t.lines).toHaveLength(1);
  });
});

describe('VoiceMouth rule 3: a person starting to talk stops the line', () => {
  it('stops it, reports interrupted, tells the head only what was said, and does not repeat it', async () => {
    const t = setup();
    t.mouth.attach(t.host);
    const result = t.mouth.say({ text: 'ダイヤ見つけたよ！', source: 'a' });
    await tick(0);
    expect(t.lines).toHaveLength(1);
    t.tracker.start('u1');
    expect(t.lines[0]!.stopped).toBe(true);
    expect(await result.done).toBe('interrupted');
    expect(t.client.said.mock.calls[0]![0]).toMatchObject({ source: 'mouth', interrupted: true, spokenText: 'ダイヤ' });
    t.tracker.end('u1');
    await tick(10_000);
    expect(t.lines).toHaveLength(1);
  });

  it('does not report an interruption that said nothing', async () => {
    const t = setup();
    t.mouth.attach(t.host);
    t.mouth.say({ text: 'x', source: 'a' });
    await tick(0);
    t.lines[0]!.finish('failed');
    await tick(0);
    expect(t.client.said).not.toHaveBeenCalled();
  });
});

describe('VoiceMouth rule 4 and 5: pace and repetition', () => {
  it('leaves 5 s after a line (1.5 s before a high line)', async () => {
    const t = setup();
    t.mouth.attach(t.host);
    t.mouth.say({ text: '一つ目', source: 'a' });
    await tick(0);
    t.lines[0]!.finish('spoken');
    await tick(0);
    t.mouth.say({ text: '二つ目', source: 'b' });
    t.mouth.say({ text: '急ぎ', source: 'c', priority: 'high', maxWaitMs: 30_000 });
    await tick(1_400);
    expect(t.lines).toHaveLength(1);
    await tick(200);
    expect(t.lines.map(line => line.text)).toEqual(['一つ目', '急ぎ']);
    t.lines[1]!.finish('spoken');
    await tick(4_900);
    expect(t.lines).toHaveLength(2);
    await tick(200);
    expect(t.lines.map(line => line.text)).toEqual(['一つ目', '急ぎ', '二つ目']);
  });

  it('accepts at most 6 a minute, then says rate_limited (and recovers after the minute)', async () => {
    const t = setup();
    t.mouth.attach(t.host);
    const results = Array.from({ length: 7 }, (_, i) => t.mouth.say({ text: `文${i}`, source: `s${i}`, maxWaitMs: 60_000 }));
    expect(results.slice(0, 6).every(r => r.accepted)).toBe(true);
    expect(results[6]).toMatchObject({ accepted: false, reason: 'rate_limited' });
    await tick(60_001);
    expect(t.mouth.say({ text: 'また', source: 'again' }).accepted).toBe(true);
  });

  it('does not repeat the same source within 20 s, except high', async () => {
    const t = setup();
    t.mouth.attach(t.host);
    const first = t.mouth.say({ text: '一回目', source: 'minecraft:milestone' });
    await tick(0);
    t.lines[0]!.finish('spoken');
    await first.done;
    await tick(6_000);
    const again = t.mouth.say({ text: '二回目', source: 'minecraft:milestone' });
    expect(again).toMatchObject({ accepted: false, reason: 'duplicate' });
    expect(t.mouth.say({ text: '急ぎ', source: 'minecraft:milestone', priority: 'high' }).accepted).toBe(true);
    await tick(0);
    t.lines[1]!.finish('spoken');
    await tick(21_000);
    expect(t.mouth.say({ text: '三回目', source: 'minecraft:milestone' }).accepted).toBe(true);
  });

  it('refuses the same source while one is already waiting, but a newer line with the same key replaces the old one', async () => {
    const t = setup();
    t.mouth.attach(t.host);
    t.tracker.start('u1'); // keep everything waiting
    const first = t.mouth.say({ text: '古い', source: 'minecraft:mining', key: 'mining', maxWaitMs: 30_000 });
    const second = t.mouth.say({ text: '新しい', source: 'minecraft:mining', key: 'mining', maxWaitMs: 30_000 });
    expect(await first.done).toBe('superseded');
    expect(second.accepted).toBe(true);
    expect(t.mouth.say({ text: '別', source: 'minecraft:mining' })).toMatchObject({ accepted: false, reason: 'duplicate' });
    t.tracker.end('u1');
    await tick(1_000);
    expect(t.lines.map(line => line.text)).toEqual(['新しい']);
  });
});

describe('VoiceMouth: facts become wording through the head', () => {
  it('asks the head, speaks its wording and tags', async () => {
    const t = setup();
    t.client.wording.mockResolvedValueOnce({ status: 'ok', say: true, text: 'お、鉄のツルハシだね。', tags: '[excited]' } as never);
    t.mouth.attach(t.host);
    t.mouth.setSituation({ text: '洞窟を下りている。' });
    const result = t.mouth.say({ facts: ['鉄のツルハシを作り終えた'], source: 'minecraft:craft', priority: 'low' });
    await tick(0);
    expect(t.client.wording.mock.calls[0]![0]).toMatchObject({
      conversationId: 'discord:g1:t1', facts: ['鉄のツルハシを作り終えた'], source: 'minecraft:craft', participants: ['u1'], situation: '洞窟を下りている。',
    });
    expect(t.lines[0]).toMatchObject({ text: 'お、鉄のツルハシだね。', tags: '[excited]' });
    t.lines[0]!.finish('spoken');
    expect(await result.done).toBe('spoken');
  });

  it('says nothing when the head decides to stay silent (declined), or cannot answer', async () => {
    const t = setup();
    t.mouth.attach(t.host);
    const silent = t.mouth.say({ facts: ['何か'], source: 'a' });
    await tick(0);
    expect(await silent.done).toBe('declined');
    t.client.wording.mockResolvedValueOnce({ status: 'unavailable', reason: 'timeout' } as never);
    const failed = t.mouth.say({ facts: ['何か'], source: 'b' });
    await tick(0);
    expect(await failed.done).toBe('declined');
    expect(t.lines).toHaveLength(0);
  });

  it('does not even ask the head for a low line while a conversation is going on', async () => {
    const t = setup();
    t.mouth.attach(t.host);
    t.state.conversation = true;
    const result = t.mouth.say({ facts: ['何か'], source: 'a', priority: 'low' });
    expect(await result.done).toBe('dropped_busy');
    expect(t.client.wording).not.toHaveBeenCalled();
  });
});

describe('VoiceMouth: situation', () => {
  it('keeps the latest text until its ttl (60 s by default) and clips it to 300 characters', () => {
    const t = setup();
    t.mouth.setSituation({ text: '古い状況' });
    t.mouth.setSituation({ text: 'あ'.repeat(500), ttlMs: 10_000 });
    expect(t.mouth.getSituation()).toHaveLength(300);
    vi.advanceTimersByTime(9_999);
    expect(t.mouth.getSituation()).toHaveLength(300);
    vi.advanceTimersByTime(2);
    expect(t.mouth.getSituation()).toBeUndefined();
    t.mouth.setSituation({ text: '既定' });
    vi.advanceTimersByTime(59_000);
    expect(t.mouth.getSituation()).toBe('既定');
    vi.advanceTimersByTime(2_000);
    expect(t.mouth.getSituation()).toBeUndefined();
  });
});

describe('VoiceMouth: the head\'s queue (long poll)', () => {
  function pollingSetup() {
    const t = setup();
    const pending: Array<(value: unknown) => void> = [];
    const signals: AbortSignal[] = [];
    t.client.mouthPoll.mockImplementation((async (_wait: number, options?: { signal?: AbortSignal }) => new Promise((resolve) => {
      pending.push(resolve);
      if (options?.signal) {
        signals.push(options.signal);
        options.signal.addEventListener('abort', () => resolve({ status: 'unavailable', reason: 'aborted' }));
      }
    })) as never);
    return { ...t, pending, signals };
  }
  const item = (over: Partial<MouthQueueItem> = {}): MouthQueueItem => ({ id: 'r1', text: 'ダイヤだ！', source: 'minecraft:milestone', priority: 'normal', maxWaitMs: 8_000, ...over });

  it('polls only while in a VC, speaks what it gets and reports the result straight away, then polls again', async () => {
    const t = pollingSetup();
    expect(t.client.mouthPoll).not.toHaveBeenCalled();
    t.mouth.attach(t.host);
    await tick(0);
    expect(t.client.mouthPoll).toHaveBeenCalledTimes(1);
    expect(t.client.mouthPoll.mock.calls[0]![0]).toBe(25_000);

    t.pending.shift()!({ status: 'ok', items: [item()] });
    await tick(0);
    expect(t.client.mouthPoll).toHaveBeenCalledTimes(2); // asked again at once, without waiting for the line to finish
    expect(t.lines.map(line => line.text)).toEqual(['ダイヤだ！']);
    t.lines[0]!.finish('spoken');
    await tick(0);
    expect(t.client.mouthResult).toHaveBeenCalledWith({ id: 'r1', status: 'spoken' });
  });

  it('reports why a line from the head could not be said', async () => {
    const t = pollingSetup();
    t.mouth.attach(t.host);
    await tick(0);
    t.state.conversation = true;
    t.pending.shift()!({ status: 'ok', items: [item({ id: 'low', priority: 'low', source: 'a' })] });
    await tick(0);
    expect(t.client.mouthResult).toHaveBeenCalledWith({ id: 'low', status: 'dropped_busy' });
    t.pending.shift()!({ status: 'ok', items: [item({ id: 'facts', facts: ['x'], text: undefined, source: 'b' })] });
    t.state.conversation = false;
    await tick(0);
    expect(t.client.mouthResult).toHaveBeenCalledWith({ id: 'facts', status: 'declined' });
  });

  it('backs off 1 s, 2 s, 4 s ... up to 30 s on failures, and starts over after a good answer', async () => {
    const t = pollingSetup();
    t.mouth.attach(t.host);
    await tick(0);
    const callsAfter = async (ms: number) => { await tick(ms); return t.client.mouthPoll.mock.calls.length; };
    t.pending.shift()!({ status: 'unavailable', reason: 'http', httpStatus: 503 });
    expect(await callsAfter(999)).toBe(1);
    expect(await callsAfter(2)).toBe(2);
    t.pending.shift()!({ status: 'unavailable', reason: 'http', httpStatus: 503 });
    expect(await callsAfter(1_999)).toBe(2);
    expect(await callsAfter(2)).toBe(3);
    t.pending.shift()!({ status: 'unavailable', reason: 'network' });
    expect(await callsAfter(3_999)).toBe(3);
    expect(await callsAfter(2)).toBe(4);
    t.pending.shift()!({ status: 'ok', items: [item({ id: 'x', source: 'z' })] });
    await tick(0);
    expect(t.client.mouthPoll.mock.calls.length).toBe(5);
    t.pending.shift()!({ status: 'unavailable', reason: 'network' });
    expect(await callsAfter(999)).toBe(5);
    expect(await callsAfter(2)).toBe(6); // back to 1 s
  });

  it('does not spin when the head answers an empty poll immediately', async () => {
    const t = pollingSetup();
    t.mouth.attach(t.host);
    await tick(0);
    t.pending.shift()!({ status: 'ok', items: [] });
    await tick(100);
    expect(t.client.mouthPoll).toHaveBeenCalledTimes(1);
    await tick(300);
    expect(t.client.mouthPoll).toHaveBeenCalledTimes(2);
  });

  it('stops polling when the VC is left, and cancels the request in flight', async () => {
    const t = pollingSetup();
    const detach = t.mouth.attach(t.host);
    await tick(0);
    expect(t.mouth.polling).toBe(true);
    detach();
    expect(t.mouth.polling).toBe(false);
    expect(t.signals[0]!.aborted).toBe(true);
    await tick(120_000);
    expect(t.client.mouthPoll).toHaveBeenCalledTimes(1);
    expect(t.mouth.hasHost()).toBe(false);
  });

  it('does not poll at all while the switch is off', async () => {
    const t = setup({ enabled: false });
    t.mouth.attach(t.host);
    await tick(1_000);
    expect(t.client.mouthPoll).not.toHaveBeenCalled();
    expect(t.mouth.polling).toBe(false);
  });

  it('answers waiting lines with not_in_voice when the last VC is left', async () => {
    const t = setup();
    const detach = t.mouth.attach(t.host);
    t.tracker.start('u1');
    const waiting = t.mouth.say({ text: '待つ', source: 'a', maxWaitMs: 30_000 });
    detach();
    expect(await waiting.done).toBe('not_in_voice');
  });
});
