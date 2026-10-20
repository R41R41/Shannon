import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BargeInMonitor } from '../../src/services/discord/voice/bargeIn.js';
import { BackchannelMonitor } from '../../src/services/discord/voice/backchannel.js';
import { SpeakerTracker } from '../../src/services/discord/voice/speakerTracker.js';
import { TurnQueue, type TurnItem, type TurnRunResult } from '../../src/services/discord/voice/turnQueue.js';
import { UtteranceCollector, type ReceiverLike, type StreamLike, type Utterance } from '../../src/services/discord/voice/utteranceCollector.js';
import type { PlaybackKind, PlaybackReport, SpeechPlayer } from '../../src/services/discord/voice/speechPlayer.js';

describe('SpeakerTracker', () => {
  let clock = 0;
  const tracker = () => new SpeakerTracker({ now: () => clock });

  it('counts someone as talking while they speak and for 0.8 s after', () => {
    clock = 1_000;
    const t = tracker();
    expect(t.isBusy()).toBe(false);
    expect(t.quietAt()).toBe(0);
    t.start('a');
    expect(t.isSpeaking('a')).toBe(true);
    expect(t.isBusy()).toBe(true);
    expect(t.quietAt()).toBeNull();
    clock = 2_000;
    t.end('a');
    expect(t.isSpeaking('a')).toBe(false);
    expect(t.isBusy()).toBe(true);
    expect(t.quietAt()).toBe(2_800);
    clock = 2_799;
    expect(t.isBusy()).toBe(true);
    clock = 2_800;
    expect(t.isBusy()).toBe(false);
    expect(t.isBusy('b')).toBe(false);
  });

  it('can ignore one person (the one whose own turn is being handled)', () => {
    clock = 0;
    const t = tracker();
    t.start('a');
    t.start('b');
    expect(t.speakingUsers().sort()).toEqual(['a', 'b']);
    expect(t.isBusy('a')).toBe(true);
    t.end('b');
    expect(t.isBusy('a')).toBe(true); // b is within the hangover
    clock = 5_000;
    expect(t.isBusy('a')).toBe(false);
  });

  it('merges bursts closer than 250 ms into one run of speech', () => {
    clock = 0;
    const t = tracker();
    t.start('a'); clock = 300; t.end('a');
    clock = 450; t.start('a'); // 150 ms breath
    expect(t.runStart('a')).toBe(0);
    clock = 600; t.end('a');
    clock = 1_000; // 400 ms later: the run is over
    expect(t.runStart('a')).toBeUndefined();
    t.start('a');
    expect(t.runStart('a')).toBe(1_000);
  });

  it('tells listeners about start and end, and survives a throwing listener', () => {
    clock = 0;
    const t = tracker();
    const events: string[] = [];
    t.on('start', u => { throw new Error(`boom ${u}`); });
    t.on('start', u => events.push(`start:${u}`));
    t.on('end', u => events.push(`end:${u}`));
    t.start('a'); t.start('a'); t.end('a'); t.end('a');
    expect(events).toEqual(['start:a', 'end:a']);
  });
});

function item(userId: string, text: string, extra: Partial<TurnItem> = {}): Omit<TurnItem, 'queuedAt' | 'parts'> {
  return { userId, name: `name-${userId}`, text, startedAt: 0, endAt: 0, sttMs: 100, utteranceMs: 1000, endpointMs: 600, ...extra };
}

describe('TurnQueue', () => {
  let clock = 100_000;
  const now = () => clock;

  function queue(options: { maxPending?: number } = {}) {
    const runs: Array<{ item: TurnItem; finish: (result?: TurnRunResult) => void }> = [];
    const drops: Array<[string, string]> = [];
    const q = new TurnQueue({
      now,
      maxPending: options.maxPending,
      onDrop: (dropped, reason) => drops.push([dropped.text, reason]),
      run: (turn) => new Promise<TurnRunResult>(resolve => {
        runs.push({ item: { ...turn }, finish: (result = { responded: true }) => resolve(result) });
      }),
    });
    return { q, runs, drops };
  }
  const settle = () => new Promise(resolve => setImmediate(resolve));

  beforeEach(() => { clock = 100_000; });

  it('runs one turn at a time, in order, and the second person waits', async () => {
    const { q, runs } = queue();
    q.submit(item('a', 'one'));
    q.submit(item('b', 'two'));
    expect(runs.map(r => r.item.text)).toEqual(['one']);
    expect(q.isBusy()).toBe(true);
    runs[0]!.finish();
    await settle();
    expect(runs.map(r => r.item.text)).toEqual(['one', 'two']);
    runs[1]!.finish();
    await settle();
    expect(q.isBusy()).toBe(false);
  });

  it('joins consecutive waiting utterances of the same person with 、', async () => {
    const { q, runs } = queue();
    q.submit(item('a', 'first'));
    q.submit(item('b', 'x', { sttMs: 50 }));
    q.submit(item('b', 'y', { sttMs: 70 }));
    q.submit(item('b', 'z'));
    runs[0]!.finish();
    await settle();
    expect(runs[1]!.item.text).toBe('x、y、z');
    expect(runs[1]!.item.parts).toBe(3);
    expect(runs[1]!.item.sttMs).toBe(50 + 70 + 100);
  });

  it('does not join utterances of the same person when someone else spoke in between', async () => {
    const { q, runs } = queue();
    q.submit(item('a', 'first'));
    q.submit(item('b', 'x'));
    q.submit(item('c', 'y'));
    q.submit(item('b', 'z'));
    runs[0]!.finish(); await settle();
    runs[1]!.finish(); await settle();
    runs[2]!.finish(); await settle();
    runs[3]!.finish(); await settle();
    expect(runs.map(r => r.item.text)).toEqual(['first', 'x', 'y', 'z']); // oldest first
  });

  it('drops what waited more than 15 s (into heard) and runs the rest', async () => {
    const { q, runs, drops } = queue();
    q.submit(item('a', 'first'));
    q.submit(item('b', 'old', { endAt: clock }));
    clock += 10_000;
    q.submit(item('c', 'fresh', { endAt: clock }));
    clock += 6_000; // old has now waited 16 s, fresh 6 s
    runs[0]!.finish();
    await settle();
    expect(runs.map(r => r.item.text)).toEqual(['first', 'fresh']);
    expect(drops).toEqual([['old', 'stale']]);
    expect(q.heard().map(h => h.text)).toEqual(['old']);
  });

  it('keeps at most 3 waiting; the oldest of a longer line goes to heard', async () => {
    const { q, runs, drops } = queue();
    q.submit(item('a', 'running'));
    for (const [user, text] of [['b', 'w1'], ['c', 'w2'], ['d', 'w3'], ['e', 'w4']] as const) q.submit(item(user, text, { endAt: clock }));
    expect(q.pendingCount()).toBe(3);
    expect(drops).toEqual([['w1', 'overflow']]);
    expect(q.heard().map(h => h.text)).toEqual(['w1']);
    runs[0]!.finish(); await settle();
    runs[1]!.finish(); await settle();
    runs[2]!.finish(); await settle();
    runs[3]!.finish(); await settle();
    expect(runs.map(r => r.item.text)).toEqual(['running', 'w2', 'w3', 'w4']);
  });

  it('remembers unanswered utterances as heard: newest first, 8 at most, 90 s, never the speaker\'s own', async () => {
    const { q, runs } = queue();
    for (let i = 0; i < 10; i += 1) {
      q.submit(item(i % 2 === 0 ? 'b' : 'c', `silent-${i}`, { endAt: clock }));
      runs[i]!.finish({ responded: false });
      await settle();
      clock += 1_000;
    }
    const heard = q.heard();
    expect(heard).toHaveLength(8);
    expect(heard[0]!.text).toBe('silent-9');
    expect(heard.at(-1)!.text).toBe('silent-2');
    expect(q.heard('b').every(h => h.userId !== 'b')).toBe(true);
    clock += 85_000; // silent-9 was at +9 s... now > 90 s for the older ones
    const later = q.heard();
    expect(later.every(h => clock - h.at <= 90_000)).toBe(true);
    expect(later.length).toBeLessThan(8);
  });

  it('answered turns are not heard; a turn that throws counts as unanswered', async () => {
    const q = new TurnQueue({ now, run: async (turn) => { if (turn.text === 'boom') throw new Error('x'); return { responded: true }; } });
    q.submit(item('a', 'fine', { endAt: clock }));
    await settle();
    q.submit(item('a', 'boom', { endAt: clock }));
    await settle();
    expect(q.heard().map(h => h.text)).toEqual(['boom']);
  });

  it('reserve() keeps the conversation "active" while an utterance is still being transcribed', async () => {
    const { q, runs } = queue();
    const events: string[] = [];
    q.onChange(event => events.push(event));
    const release = q.reserve();
    expect(q.isActive()).toBe(true);
    expect(q.isBusy()).toBe(false);
    q.submit(item('a', 'x'));
    release();
    expect(q.isActive()).toBe(true);
    runs[0]!.finish();
    await settle();
    expect(q.isActive()).toBe(false);
    expect(events).toEqual(['start', 'idle']);
  });
});

/** A receiver whose streams the test feeds by hand. */
class FakeReceiver implements ReceiverLike {
  speaking = new EventEmitter() as ReceiverLike['speaking'] & EventEmitter;
  subscriptions: Array<{ userId: string; options: { end: { behavior: number; duration: number } }; stream: FakeStream }> = [];
  subscribe(userId: string, options: { end: { behavior: number; duration: number } }): StreamLike {
    const stream = new FakeStream();
    this.subscriptions.push({ userId, options, stream });
    return stream;
  }
}
class FakeStream extends EventEmitter {
  destroyed = false;
  destroy() { this.destroyed = true; this.emit('close'); return this; }
}

describe('UtteranceCollector', () => {
  let clock = 0;
  const packet = (tag = 1) => Buffer.from([tag]);
  const decode = (packets: Buffer[]) => Buffer.alloc(packets.length * 3_840); // 20 ms of 48 kHz stereo each

  function setup(overrides: { shouldCollect?: (u: string) => boolean; maxMs?: number } = {}) {
    const receiver = new FakeReceiver();
    const tracker = new SpeakerTracker({ now: () => clock });
    const utterances: Utterance[] = [];
    const discards: Array<[string, string]> = [];
    const collector = new UtteranceCollector({
      receiver,
      tracker,
      endBehaviorAfterSilence: 1,
      decode,
      isIgnored: userId => userId === 'bot',
      shouldCollect: overrides.shouldCollect ?? (() => true),
      onUtterance: u => utterances.push(u),
      onDiscard: info => discards.push([info.userId, info.reason]),
      now: () => clock,
      maxMs: overrides.maxMs,
    });
    collector.start();
    const speak = (userId: string) => receiver.speaking.emit('start', userId);
    const stop = (userId: string) => receiver.speaking.emit('end', userId);
    const stream = (userId: string) => receiver.subscriptions.filter(s => s.userId === userId).at(-1)!.stream;
    const feed = (userId: string, packets: number) => { for (let i = 0; i < packets; i += 1) { clock += 20; stream(userId).emit('data', packet()); } };
    return { receiver, tracker, collector, utterances, discards, speak, stop, stream, feed };
  }

  beforeEach(() => { clock = 10_000; });

  it('listens per person: two people at the same time never mix', () => {
    const { speak, feed, stream, utterances, receiver } = setup();
    speak('a'); speak('b');
    feed('a', 30);
    feed('b', 40);
    feed('a', 10);
    clock += 600; stream('b').emit('end');
    clock += 100; stream('a').emit('end');
    expect(receiver.subscriptions.map(s => s.options.end)).toEqual([{ behavior: 1, duration: 600 }, { behavior: 1, duration: 600 }]);
    expect(utterances).toHaveLength(2);
    const byUser = Object.fromEntries(utterances.map(u => [u.userId, u]));
    expect(byUser.b!.pcm.length).toBe(40 * 3_840);
    expect(byUser.a!.pcm.length).toBe(40 * 3_840);
    expect(byUser.a!.durationMs).toBe(800);
  });

  it('measures the end of speech at the last packet, not at the stream end', () => {
    const { speak, feed, stream, utterances } = setup();
    speak('a');
    feed('a', 50);
    const lastPacket = clock;
    clock += 600;
    stream('a').emit('end');
    expect(utterances[0]!.endAt).toBe(lastPacket);
    expect(utterances[0]!.endpointMs).toBe(600);
    expect(utterances[0]!.closedAt).toBe(lastPacket + 600);
  });

  it('throws away anything shorter than 0.5 s of speech', () => {
    const { speak, feed, stream, utterances, discards } = setup();
    speak('a'); feed('a', 24); stream('a').emit('end'); // 480 ms
    speak('b'); feed('b', 25); stream('b').emit('end'); // 500 ms
    expect(discards).toEqual([['a', 'short']]);
    expect(utterances.map(u => u.userId)).toEqual(['b']);
  });

  it('cuts a monologue at 30 s and goes on collecting while the person still talks', () => {
    const { speak, feed, stream, utterances, receiver, tracker } = setup();
    speak('a');
    feed('a', 1_500);
    expect(utterances).toHaveLength(1);
    expect(utterances[0]!.cut).toBe(true);
    expect(utterances[0]!.durationMs).toBe(30_000);
    expect(receiver.subscriptions).toHaveLength(2); // a new collection began at once
    expect(tracker.isSpeaking('a')).toBe(true);
    feed('a', 100);
    stream('a').emit('end');
    expect(utterances).toHaveLength(2);
    expect(utterances[1]!.cut).toBe(false);
  });

  it('keeps tracking everybody but only transcribes the ones it should (PTT)', () => {
    const { speak, receiver, tracker } = setup({ shouldCollect: userId => userId === 'ptt' });
    speak('other');
    speak('ptt');
    expect(tracker.speakingUsers().sort()).toEqual(['other', 'ptt']);
    expect(receiver.subscriptions.map(s => s.userId)).toEqual(['ptt']);
  });

  it('ignores bots entirely', () => {
    const { speak, receiver, tracker } = setup();
    speak('bot');
    expect(tracker.speakingUsers()).toEqual([]);
    expect(receiver.subscriptions).toHaveLength(0);
  });

  it('a pause shorter than the silence wait stays one utterance (speaking restarts on the same stream)', () => {
    const { speak, stop, feed, stream, utterances, receiver } = setup();
    speak('a'); feed('a', 30); stop('a');
    clock += 300; speak('a'); // same stream still open: no second subscription
    feed('a', 30);
    stream('a').emit('end');
    expect(receiver.subscriptions).toHaveLength(1);
    expect(utterances).toHaveLength(1);
    expect(utterances[0]!.durationMs).toBe(1_200);
  });

  it('reports how long somebody has been speaking, and stops everything on dispose', () => {
    const { speak, feed, collector, stream } = setup();
    speak('a');
    feed('a', 50);
    expect(collector.collectingMs('a')).toBe(980); // from the first packet
    expect(collector.isCollecting('a')).toBe(true);
    collector.dispose();
    expect((stream('a') as FakeStream).destroyed).toBe(true);
    expect(collector.collectingMs('a')).toBe(0);
  });
});

function fakePlayer() {
  let speaking: { kind: PlaybackKind; since: number } | null = null;
  const listeners = new Set<(speaking: boolean, kind: PlaybackKind) => void>();
  const stops: string[] = [];
  const report: PlaybackReport = { reason: 'barge_in', playedMs: 900, startedAt: 0, endedAt: 0, segments: [], spokenText: 'うん。' };
  const player = {
    speaking: () => speaking,
    current: () => (speaking ? {} : null),
    stop: (reason: string) => { stops.push(reason); speaking = null; return report; },
    onSpeakingChange: (listener: (s: boolean, k: PlaybackKind) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return {
    player: player as unknown as SpeechPlayer,
    stops,
    shannonStarts: (kind: PlaybackKind = 'reply') => { speaking = { kind, since: Date.now() }; listeners.forEach(l => l(true, kind)); },
  };
}

describe('BargeInMonitor', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(shouldListen: (u: string) => boolean = () => true) {
    const tracker = new SpeakerTracker();
    const { player, stops, shannonStarts } = fakePlayer();
    const events: string[] = [];
    const monitor = new BargeInMonitor({ tracker, player, shouldListen, onBargeIn: e => events.push(e.userId) });
    return { tracker, stops, shannonStarts, events, monitor };
  }

  it('stops playback when a person keeps talking for 0.4 s (and not before)', () => {
    const { tracker, stops, shannonStarts, events } = setup();
    shannonStarts();
    vi.advanceTimersByTime(1_000); // well past the 0.5 s grace
    tracker.start('a');
    vi.advanceTimersByTime(399);
    expect(stops).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(stops).toEqual(['barge_in']);
    expect(events).toEqual(['a']);
  });

  it('does not count a voice that is gone before 0.4 s', () => {
    const { tracker, stops, shannonStarts } = setup();
    shannonStarts();
    vi.advanceTimersByTime(1_000);
    tracker.start('a');
    vi.advanceTimersByTime(300);
    tracker.end('a');
    vi.advanceTimersByTime(2_000);
    expect(stops).toEqual([]);
  });

  it('ignores a reflexive "un" in the first 0.5 s of Shannon\'s speech', () => {
    const { tracker, stops, shannonStarts } = setup();
    shannonStarts();
    vi.advanceTimersByTime(100);
    tracker.start('a'); // 0.1 s after Shannon began
    vi.advanceTimersByTime(300);
    tracker.end('a'); // 0.4 s: shorter than the grace period would allow
    vi.advanceTimersByTime(2_000);
    expect(stops).toEqual([]);
  });

  it('counts only the part of a voice after the grace period: starting at 0.2 s, still talking -> cut at 0.9 s', () => {
    const { tracker, stops, shannonStarts } = setup();
    shannonStarts();
    vi.advanceTimersByTime(200);
    tracker.start('a');
    vi.advanceTimersByTime(690);
    expect(stops).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(stops).toEqual(['barge_in']);
  });

  it('also interrupts when Shannon starts while the person is already talking', () => {
    const { tracker, stops, shannonStarts } = setup();
    tracker.start('a');
    vi.advanceTimersByTime(3_000);
    shannonStarts();
    vi.advanceTimersByTime(890);
    expect(stops).toEqual([]);
    vi.advanceTimersByTime(20);
    expect(stops).toEqual(['barge_in']);
  });

  it('bridges a short breath: 0.3 s + 0.1 s pause + more still adds up', () => {
    const { tracker, stops, shannonStarts } = setup();
    shannonStarts();
    vi.advanceTimersByTime(1_000);
    tracker.start('a');
    vi.advanceTimersByTime(300);
    tracker.end('a');
    vi.advanceTimersByTime(100);
    tracker.start('a'); // within 250 ms: the same run of speech, already 0.4 s old
    vi.advanceTimersByTime(5);
    expect(stops).toEqual(['barge_in']);
  });

  it('leaves mouth lines and backchannels alone, and people who are not listened to', () => {
    const { tracker, stops, shannonStarts } = setup(userId => userId !== 'deaf');
    shannonStarts('mouth');
    tracker.start('a');
    vi.advanceTimersByTime(5_000);
    expect(stops).toEqual([]);
    shannonStarts('reply');
    tracker.start('deaf');
    vi.advanceTimersByTime(5_000);
    expect(stops).toEqual(['barge_in']); // only because of 'a', who is still talking
  });
});

describe('BackchannelMonitor', () => {
  function setup(overrides: Partial<ConstructorParameters<typeof BackchannelMonitor>[0]> = {}) {
    const tracker = new SpeakerTracker();
    const session = { addSegment: vi.fn(() => ({ writeMono24k: vi.fn(), end: vi.fn() })), finish: vi.fn() };
    let busy = false;
    const player = { current: () => (busy ? {} : null), open: vi.fn(() => session) } as unknown as SpeechPlayer;
    let clock = 1_000_000;
    const monitor = new BackchannelMonitor({
      tracker,
      collector: { collectingMs: () => 4_000 },
      player,
      fillers: { get: (id: string) => (id === 'un' ? { id: 'un', text: 'うん。', pcm: Buffer.alloc(100) } : undefined), ids: () => ['un'] },
      shouldListen: () => true,
      humanCount: () => 1,
      lastConversationAt: () => clock - 5_000,
      now: () => clock,
      ...overrides,
    });
    return { monitor, player, session, advance: (ms: number) => { clock += ms; }, setBusy: (b: boolean) => { busy = b; } };
  }

  it('plays a small "un" at a breath after 3.5 s of talking, then not again for 10 s', () => {
    const { monitor, session, advance, player } = setup();
    expect(monitor.onPause('a')).toBe(true);
    expect(player.open).toHaveBeenCalledWith('backchannel');
    expect(session.addSegment).toHaveBeenCalledWith('うん。', 'filler', { gain: 0.35 });
    advance(9_000);
    expect(monitor.onPause('a')).toBe(false);
    advance(1_500);
    expect(monitor.onPause('a')).toBe(true);
  });

  it('stays quiet when the speech is short, others are present, Shannon is speaking, or nobody was talking to her', () => {
    expect(setup({ collector: { collectingMs: () => 3_000 } }).monitor.onPause('a')).toBe(false);
    expect(setup({ humanCount: () => 2 }).monitor.onPause('a')).toBe(false);
    const busy = setup(); busy.setBusy(true);
    expect(busy.monitor.onPause('a')).toBe(false);
    expect(setup({ lastConversationAt: () => 0 }).monitor.onPause('a')).toBe(false);
    expect(setup({ lastConversationAt: () => 1_000_000 - 4_000 - 30_000 }).monitor.onPause('a')).toBe(false);
    expect(setup({ shouldListen: () => false }).monitor.onPause('a')).toBe(false);
    expect(setup({ fillers: { get: () => undefined, ids: () => [] } }).monitor.onPause('a')).toBe(false);
  });
});
