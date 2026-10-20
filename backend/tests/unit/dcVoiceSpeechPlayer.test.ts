import { PassThrough, type Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  Pcm24kMonoTo48kStereo,
  makeWav,
  pcm24kMonoTo48kStereo,
  pcm48kStereoTo16kMono,
  wavToPcm48kStereo,
} from '../../src/services/discord/voice/pcm.js';
import { SpeechPlayer, type PlayerPort, type ResourceLike } from '../../src/services/discord/voice/speechPlayer.js';

function mono24k(samples: number[]): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => out.writeInt16LE(sample, index * 2));
  return out;
}

function stereoFrames(buffer: Buffer): Array<[number, number]> {
  const frames: Array<[number, number]> = [];
  for (let at = 0; at + 3 < buffer.length; at += 4) frames.push([buffer.readInt16LE(at), buffer.readInt16LE(at + 2)]);
  return frames;
}

describe('PCM conversion', () => {
  it('turns 24 kHz mono into 48 kHz stereo: exactly twice the frames, interpolated, both channels equal', () => {
    const out = pcm24kMonoTo48kStereo(mono24k([0, 1000, -1000, 400]));
    expect(out.length).toBe(4 * 2 * 4); // 4 samples -> 8 frames -> 32 bytes
    expect(stereoFrames(out)).toEqual([
      [0, 0], [500, 500], [1000, 1000], [0, 0], [-1000, -1000], [-300, -300], [400, 400], [400, 400],
    ]);
  });

  it('gives the same bytes however the stream is cut, even through the middle of a sample', () => {
    const whole = mono24k(Array.from({ length: 101 }, (_, i) => Math.round(Math.sin(i / 5) * 12000)));
    const expected = pcm24kMonoTo48kStereo(whole);
    for (const size of [1, 3, 7, 50, 200]) {
      const converter = new Pcm24kMonoTo48kStereo();
      const parts: Buffer[] = [];
      for (let at = 0; at < whole.length; at += size) parts.push(converter.push(whole.subarray(at, at + size)));
      parts.push(converter.flush());
      expect(Buffer.concat(parts).equals(expected)).toBe(true);
    }
  });

  it('applies a gain and clips instead of wrapping', () => {
    const quiet = pcm24kMonoTo48kStereo(mono24k([10000, 10000]), 0.5);
    expect(stereoFrames(quiet)[0]).toEqual([5000, 5000]);
    const loud = pcm24kMonoTo48kStereo(mono24k([30000, 30000]), 2);
    expect(stereoFrames(loud)[0]).toEqual([32767, 32767]);
  });

  it('reads WAV files (VOICEPEAK) of any rate / channel count into 48 kHz stereo', () => {
    const mono24 = makeWav(mono24k(Array.from({ length: 240 }, () => 1000)), 24_000, 1);
    expect(wavToPcm48kStereo(mono24)!.length).toBe(480 * 4);
    const stereo48 = Buffer.alloc(100 * 4);
    for (let i = 0; i < 100; i += 1) { stereo48.writeInt16LE(i, i * 4); stereo48.writeInt16LE(-i, i * 4 + 2); }
    const passthrough = wavToPcm48kStereo(makeWav(stereo48, 48_000, 2))!;
    expect(passthrough.equals(stereo48)).toBe(true);
    const mono16 = makeWav(mono24k(Array.from({ length: 160 }, () => 2000)), 16_000, 1);
    expect(wavToPcm48kStereo(mono16)!.length).toBe(480 * 4);
    expect(wavToPcm48kStereo(Buffer.from('not a wav at all, not even close, really not a wav file'))).toBeNull();
  });

  it('downmixes captured speech to 16 kHz mono for Whisper (a sixth of the size)', () => {
    const stereo = Buffer.alloc(48_000 * 4); // one second
    for (let i = 0; i < 48_000; i += 1) { stereo.writeInt16LE(3000, i * 4); stereo.writeInt16LE(1000, i * 4 + 2); }
    const mono = pcm48kStereoTo16kMono(stereo);
    expect(mono.length).toBe(16_000 * 2);
    expect(mono.readInt16LE(0)).toBe(2000);
    expect(makeWav(mono, 16_000, 1).length).toBe(44 + mono.length);
  });
});

/** Plays "audio" by hand: nothing moves until `advance(ms)`. Emits idle like the real player does. */
class FakeAudio {
  listeners = new Set<(status: string) => void>();
  plays = 0;
  stops = 0;
  resources: FakeResource[] = [];
  current: FakeResource | null = null;
  port: PlayerPort = {
    play: (resource) => { this.plays += 1; this.current = resource as FakeResource; this.emit('playing'); },
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
  /** Consume `ms` of what has been written to the current resource. */
  advance(ms: number) {
    const resource = this.current;
    if (!resource) return;
    resource.consume(ms);
  }
  /** The library ran out of data for 100 ms. */
  starve() { this.current = null; this.emit('idle'); }
  /** Consume everything and let the library notice the stream ended. */
  finishCurrent() {
    const resource = this.current;
    if (!resource) return;
    resource.consume(1e9);
    if (resource.stream.writableEnded && resource.stream.readableLength === 0) { this.current = null; this.emit('idle'); }
  }
}

class FakeResource implements ResourceLike {
  playbackDuration = 0;
  consumedBytes = 0;
  constructor(readonly stream: PassThrough) {}
  consume(ms: number) {
    const want = Math.min(ms * 192, this.stream.readableLength);
    if (want > 0) this.stream.read(want);
    this.consumedBytes += want;
    this.playbackDuration = Math.floor(this.consumedBytes / 3840) * 20;
  }
}

/** n ms of 24 kHz mono audio (48 bytes per ms). */
function audioMs(ms: number): Buffer {
  return Buffer.alloc(ms * 48, 1);
}

function setup() {
  const audio = new FakeAudio();
  let clock = 1_000;
  const player = new SpeechPlayer({ port: audio.port, createResource: audio.createResource, now: () => clock, pollMs: 5 });
  return { audio, player, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

describe('SpeechPlayer', () => {
  it('writes sentences back to back into one stream, reports each start, and completes', async () => {
    const { audio, player, tick } = setup();
    const starts: Array<[number, string]> = [];
    const session = player.open('reply', { onSegmentStart: s => starts.push([s.index, s.kind]) });
    const filler = session.addSegment('うん。', 'filler');
    filler.writeMono24k(audioMs(200));
    filler.end();
    const s1 = session.addSegment('一文目。', 'sentence');
    const s2 = session.addSegment('二文目。', 'sentence');
    s2.writeMono24k(audioMs(100)); // arrives first, must still play after sentence one
    s1.writeMono24k(audioMs(300));
    s1.end();
    s2.end();
    session.finish();

    expect(audio.plays).toBe(1); // one resource, one continuous stream
    expect(audio.resources[0]!.stream.readableLength).toBe((200 + 300 + 100) * 192); // nothing inserted between segments

    audio.advance(50); session.poll(); tick(50);
    expect(starts).toEqual([[0, 'filler']]);
    audio.advance(200); session.poll();
    expect(starts).toEqual([[0, 'filler'], [1, 'sentence']]);
    audio.advance(310); session.poll();
    expect(starts.map(s => s[0])).toEqual([0, 1, 2]);
    audio.finishCurrent();
    const report = await session.whenDone();
    expect(report.reason).toBe('completed');
    expect(report.spokenText).toBe('うん。一文目。二文目。');
    expect(player.current()).toBeNull();
  });

  it('knows exactly what was said when stopped mid-sentence (spokenText for the head)', async () => {
    const { audio, player } = setup();
    const session = player.open('reply');
    const filler = session.addSegment('うん。', 'filler');
    filler.writeMono24k(audioMs(400)); filler.end();
    const one = session.addSegment('あいうえおかきくけこ。', 'sentence'); // 11 characters, 1000 ms
    one.writeMono24k(audioMs(1000)); one.end();
    const two = session.addSegment('さしすせそ。', 'sentence');
    two.writeMono24k(audioMs(800)); two.end();
    audio.advance(400 + 500); // filler done, half of sentence one
    const report = session.stop('barge_in');
    expect(report.reason).toBe('barge_in');
    expect(report.playedMs).toBe(900);
    expect(report.segments.map(s => s.state)).toEqual(['played', 'partial', 'unplayed']);
    expect(report.segments[1]!.playedChars).toBe(5); // 11 chars * 0.5 -> 5
    expect(report.spokenText).toBe('うん。あいうえお');
    expect(audio.stops).toBe(1);
    // After the stop nothing more is accepted and the same report comes back.
    one.writeMono24k(audioMs(10));
    expect(session.stop('manual')).toBe(report);
    expect((await session.whenDone()).spokenText).toBe('うん。あいうえお');
  });

  it('says nothing was said when stopped before the audio started', () => {
    const { player } = setup();
    const session = player.open('reply');
    session.addSegment('これから言う。', 'sentence'); // no audio yet
    const report = session.stop('barge_in');
    expect(report.spokenText).toBe('');
    expect(report.startedAt).toBeNull();
  });

  it('restarts the resource when the player ran dry between sentences, and keeps counting position', async () => {
    const { audio, player } = setup();
    const starts: number[] = [];
    const session = player.open('reply', { onSegmentStart: s => starts.push(s.index) });
    const a = session.addSegment('先の文。', 'sentence');
    a.writeMono24k(audioMs(200)); a.end();
    audio.advance(200);
    session.poll();
    audio.starve(); // the next sentence is late; the library stopped
    expect(audio.plays).toBe(1);
    const b = session.addSegment('遅れた文。', 'sentence');
    b.writeMono24k(audioMs(300)); b.end();
    expect(audio.plays).toBe(2);
    session.finish();
    audio.advance(100); session.poll();
    expect(starts).toEqual([0, 1]);
    const early = session.stop('barge_in');
    expect(early.spokenText.startsWith('先の文。')).toBe(true);
    expect(early.segments[1]!.state).toBe('partial');
  });

  it('completes on its own when nothing was ever played', async () => {
    const { player } = setup();
    const session = player.open('reply');
    session.finish();
    expect((await session.whenDone()).reason).toBe('completed');
  });

  it('stops the previous playback when a new one opens, and tracks who is speaking', async () => {
    const { audio, player, now } = setup();
    const changes: string[] = [];
    player.onSpeakingChange((speaking, kind) => changes.push(`${kind}:${speaking}`));
    const reply = player.open('reply');
    const w = reply.addSegment('こんにちは。', 'sentence');
    w.writeMono24k(audioMs(200)); w.end();
    audio.advance(100); reply.poll();
    expect(player.speaking()).toEqual({ kind: 'reply', since: now() });
    const mouth = player.open('mouth');
    expect((await reply.whenDone()).reason).toBe('preempted');
    expect(player.current()).toBe(mouth);
    expect(player.speaking()).toBeNull(); // the mouth line has no audio yet
    expect(changes).toEqual(['reply:true', 'reply:false']);
  });

  it('force-completes when the player never reports the end', async () => {
    const { audio, player } = setup();
    let clock = 1_000;
    const slow = new SpeechPlayer({ port: audio.port, createResource: audio.createResource, now: () => clock, pollMs: 1_000_000 });
    const session = slow.open('reply');
    const w = session.addSegment('文。', 'sentence');
    w.writeMono24k(audioMs(100)); w.end();
    session.finish();
    audio.advance(100);
    clock += 100 + 2_500 - 1; session.poll();
    expect(slow.current()).not.toBeNull();
    clock += 2; session.poll();
    expect((await session.whenDone()).reason).toBe('completed');
    void player;
  });
});
