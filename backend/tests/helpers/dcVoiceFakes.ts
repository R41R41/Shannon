/**
 * Test doubles for the dc-voice tests: a pretend Discord AudioPlayer (nothing real is played), a scripted head
 * client, and small audio helpers. No network, no Discord.
 */
import { EventEmitter } from 'node:events';
import type { PassThrough, Readable } from 'node:stream';
import { vi } from 'vitest';
import type { PlayerPort, ResourceLike } from '../../src/services/discord/voice/speechPlayer.js';
import type {
  ShannonCoreVoiceClient,
  VoiceSpeechResult,
  VoiceTurnDecision,
  VoiceTurnLine,
  VoiceTurnOpenResult,
} from '../../src/services/integration/shannonCoreVoiceClient.js';

const FRAME_BYTES = 3_840; // 20 ms of 48 kHz stereo s16le

export class FakeResource implements ResourceLike {
  playbackDuration = 0;
  consumedBytes = 0;
  missed = 0;
  /** What was taken out of the stream, in order: the audio that "went out". */
  captured: Buffer[] = [];
  constructor(readonly stream: PassThrough) {}
  consume(ms: number) {
    this.consumeBytes(Math.min(ms * 192, this.stream.readableLength));
  }
  consumeBytes(bytes: number) {
    if (bytes > 0) {
      const data = this.stream.read(bytes) as Buffer | null;
      if (data) this.captured.push(data);
    }
    this.consumedBytes += bytes;
    this.playbackDuration = Math.ceil(this.consumedBytes / FRAME_BYTES) * 20;
  }
}

/**
 * Plays "audio" either by hand (`advance`) or by itself (`auto`): every `tickMs` it takes one 20 ms frame, like the
 * library's 20 ms timer, goes idle when the source ended and drained, and goes idle after 100 ms of starvation.
 */
export class FakeAudio {
  listeners = new Set<(status: string) => void>();
  plays = 0;
  stops = 0;
  resources: FakeResource[] = [];
  current: FakeResource | null = null;
  private timer: NodeJS.Timeout | null = null;

  port: PlayerPort = {
    play: (resource) => { this.plays += 1; this.current = resource as FakeResource; (resource as FakeResource).missed = 0; this.emit('playing'); },
    stop: () => { this.stops += 1; this.current = null; this.emit('idle'); },
    onStateChange: (listener) => { this.listeners.add(listener); return () => this.listeners.delete(listener); },
    onError: () => () => undefined,
  };

  createResource = (stream: Readable): ResourceLike => {
    const resource = new FakeResource(stream as PassThrough);
    this.resources.push(resource);
    return resource;
  };

  emit(status: string) { for (const listener of [...this.listeners]) listener(status); }

  advance(ms: number) { this.current?.consume(ms); }

  starve() { this.current = null; this.emit('idle'); }

  auto(tickMs: number): this {
    const missedLimit = Math.ceil(100 / tickMs);
    this.timer = setInterval(() => {
      const resource = this.current;
      if (!resource) return;
      const buffered = resource.stream.readableLength;
      const ended = resource.stream.writableEnded;
      if (buffered >= FRAME_BYTES || (ended && buffered > 0)) {
        resource.missed = 0;
        resource.consumeBytes(Math.min(FRAME_BYTES, buffered));
      } else if (ended) {
        this.current = null;
        this.emit('idle');
      } else {
        resource.missed += 1;
        if (resource.missed >= missedLimit) this.starve();
      }
    }, tickMs);
    this.timer.unref?.();
    return this;
  }

  dispose() { if (this.timer) clearInterval(this.timer); }
}

/** `ms` of 24 kHz mono s16le (48 bytes per ms), filled with a constant. */
export function audioMs(ms: number, value = 1): Buffer {
  const out = Buffer.alloc(ms * 48);
  for (let at = 0; at < out.length; at += 2) out.writeInt16LE(value, at);
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export type ScriptedLine = VoiceTurnLine | { wait: number };

/** A turn result whose lines arrive as scripted: `{ wait: ms }` pauses, anything else is a line. */
export function scriptedTurn(decision: VoiceTurnDecision, script: ScriptedLine[], decisionMs = 100): VoiceTurnOpenResult & { cancel: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn();
  async function* lines(): AsyncGenerator<VoiceTurnLine> {
    for (const entry of script) {
      if ('wait' in entry) { await sleep(entry.wait); continue; }
      yield entry;
    }
  }
  return { status: 'ok', decision, decisionMs, lines: { [Symbol.asyncIterator]: () => lines() }, cancel };
}

export interface SpeechPlan {
  /** ms of audio to answer with, per call, by text; default 200. */
  ms?: (text: string) => number;
  /** ms before the first chunk. */
  delay?: (text: string) => number;
  /** The constant sample value of the audio, to tell sentences apart in the output. */
  value?: (text: string) => number;
  /** Make a call fail before any audio (HTTP error). */
  fail?: (text: string) => boolean;
}

/** A client whose `speech` answers from the plan and tracks how many requests were in flight at once. */
export function fakeSpeech(plan: SpeechPlan = {}) {
  let inflight = 0;
  const stats = { max: 0, calls: [] as Array<{ text: string; style?: string }> };
  const speech = vi.fn(async (text: string, options?: { style?: string }): Promise<VoiceSpeechResult> => {
    stats.calls.push({ text, style: options?.style });
    inflight += 1;
    stats.max = Math.max(stats.max, inflight);
    try {
      await sleep(plan.delay?.(text) ?? 0);
      if (plan.fail?.(text)) return { status: 'unavailable', reason: 'http', httpStatus: 503 };
      const ms = plan.ms?.(text) ?? 200;
      async function* chunks(): AsyncGenerator<Buffer> {
        const total = audioMs(ms, plan.value?.(text) ?? 1);
        for (let at = 0; at < total.length; at += 4_800) {
          yield total.subarray(at, Math.min(at + 4_800, total.length));
          await sleep(1);
        }
      }
      return { status: 'ok', chunks: { [Symbol.asyncIterator]: () => chunks() } };
    } finally {
      inflight -= 1;
    }
  });
  return { speech, stats };
}

export function fakeVoiceClient(parts: Partial<Pick<ShannonCoreVoiceClient, 'turn' | 'speech' | 'said' | 'wording' | 'mouthPoll' | 'mouthResult'>> = {}) {
  return {
    turn: vi.fn(async () => ({ status: 'unavailable', reason: 'http', httpStatus: 503 } as VoiceTurnOpenResult)),
    speech: vi.fn(async () => ({ status: 'unavailable', reason: 'http' } as VoiceSpeechResult)),
    said: vi.fn(async () => ({ status: 'ok' as const })),
    wording: vi.fn(async () => ({ status: 'ok' as const, say: false })),
    mouthPoll: vi.fn(async () => ({ status: 'ok' as const, items: [] })),
    mouthResult: vi.fn(async () => ({ status: 'ok' as const })),
    ...parts,
  };
}

/** A voice receiver the test drives by hand: `speaking` events and one fake opus stream per subscription. */
export class FakeReceiver {
  speaking = new EventEmitter();
  subscriptions: Array<{ userId: string; options: { end: { behavior: number; duration: number } }; stream: FakeStream }> = [];
  subscribe(userId: string, options: { end: { behavior: number; duration: number } }) {
    const stream = new FakeStream();
    this.subscriptions.push({ userId, options, stream });
    return stream;
  }
  speak(userId: string) { this.speaking.emit('start', userId); }
  quiet(userId: string) { this.speaking.emit('end', userId); }
  stream(userId: string) { return this.subscriptions.filter(s => s.userId === userId).at(-1)!.stream; }
  /** `packets` 20 ms packets whose first byte is `tag` (the fake decoder and STT read it back). */
  feed(userId: string, packets: number, tag: number) {
    for (let i = 0; i < packets; i += 1) this.stream(userId).emit('data', Buffer.from([tag]));
  }
  /** The silence wait is over: the stream ends. */
  end(userId: string) { this.stream(userId).emit('end'); }
}

export class FakeStream extends EventEmitter {
  destroyed = false;
  destroy() { this.destroyed = true; this.emit('close'); return this; }
}

/** Decoder for the fake receiver: 20 ms of 48 kHz stereo per packet, every sample = tag * 100. */
export function fakeDecode(packets: Buffer[]): Buffer {
  const out = Buffer.alloc(packets.length * 3_840);
  const value = (packets[0]?.[0] ?? 0) * 100;
  for (let at = 0; at + 1 < out.length; at += 2) out.writeInt16LE(value, at);
  return out;
}

/** STT for the fake decoder: reads the tag back out of the WAV and answers with the text registered for it. */
export function fakeStt(texts: Record<number, string>) {
  return vi.fn(async (wav: Buffer) => {
    const tag = Math.round(wav.readInt16LE(44) / 100);
    const text = texts[tag];
    return text ? { status: 'ok' as const, text, sttMs: 5 } : { status: 'empty' as const, sttMs: 5 };
  });
}

export async function waitFor(condition: () => boolean, timeoutMs = 3_000, label = 'condition'): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(2);
  }
}

/** Run-length view of the left channel of 48 kHz stereo audio: [[value, frames], ...]. */
export function sampleRuns(buffers: Buffer[]): Array<[number, number]> {
  const all = Buffer.concat(buffers);
  const runs: Array<[number, number]> = [];
  for (let at = 0; at + 3 < all.length; at += 4) {
    const value = all.readInt16LE(at);
    const last = runs[runs.length - 1];
    if (last && last[0] === value) last[1] += 1;
    else runs.push([value, 1]);
  }
  return runs;
}

/** A minimal WAV (mono 24 kHz) so the VOICEPEAK fallback has something readable. */
export function wavMs(ms: number): Buffer {
  const pcm = audioMs(ms, 7);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
