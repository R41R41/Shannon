/**
 * dc-voice: PCM helpers. No ffmpeg anywhere; plain s16le math.
 *
 * Discord wants 48 kHz stereo s16le for `StreamType.Raw`. The head sends 24 kHz mono s16le; VOICEPEAK sends a WAV.
 * Captured speech goes the other way: 48 kHz stereo -> 16 kHz mono for Whisper (a 6x smaller upload).
 */

/** 48 kHz * 2 channels * 2 bytes = 192 bytes per millisecond. */
export const BYTES_PER_MS_48K_STEREO = 192;
export const BYTES_PER_FRAME_48K_STEREO = 4;

export function pcmMs48kStereo(bytes: number): number {
  return bytes / BYTES_PER_MS_48K_STEREO;
}

/**
 * Streaming 24 kHz mono -> 48 kHz stereo s16le converter. Linear interpolation: each input sample n becomes two
 * frames, [s(n), (s(n)+s(n+1))/2], so the output is exactly twice as many frames as the input has samples (after
 * `flush()`), and a chunk may end in the middle of a sample.
 */
export class Pcm24kMonoTo48kStereo {
  private carry: Buffer | null = null;
  private previous: number | null = null;

  constructor(private readonly gain = 1) {}

  push(chunk: Buffer): Buffer {
    let data = chunk;
    if (this.carry) {
      data = Buffer.concat([this.carry, chunk]);
      this.carry = null;
    }
    const samples = data.length >> 1;
    if (data.length & 1) this.carry = Buffer.from(data.subarray(data.length - 1));
    if (samples === 0) return Buffer.alloc(0);
    const out = Buffer.allocUnsafe(samples * 8);
    let at = 0;
    for (let i = 0; i < samples; i += 1) {
      const sample = this.scale(data.readInt16LE(i * 2));
      if (this.previous !== null) {
        at = writeFrame(out, at, this.previous);
        at = writeFrame(out, at, (this.previous + sample) >> 1);
      }
      this.previous = sample;
    }
    return out.subarray(0, at);
  }

  /** Emits the held last sample (twice). Call once when the stream is over. */
  flush(): Buffer {
    if (this.previous === null) return Buffer.alloc(0);
    const out = Buffer.allocUnsafe(8);
    let at = writeFrame(out, 0, this.previous);
    at = writeFrame(out, at, this.previous);
    this.previous = null;
    this.carry = null;
    return out.subarray(0, at);
  }

  private scale(sample: number): number {
    if (this.gain === 1) return sample;
    return clamp16(Math.round(sample * this.gain));
  }
}

function writeFrame(out: Buffer, at: number, sample: number): number {
  const value = clamp16(sample);
  out.writeInt16LE(value, at);
  out.writeInt16LE(value, at + 2);
  return at + 4;
}

function clamp16(value: number): number {
  return value > 32767 ? 32767 : value < -32768 ? -32768 : value;
}

/** Convenience for a whole buffer. */
export function pcm24kMonoTo48kStereo(mono: Buffer, gain = 1): Buffer {
  const converter = new Pcm24kMonoTo48kStereo(gain);
  return Buffer.concat([converter.push(mono), converter.flush()]);
}

/**
 * A 16-bit PCM WAV (any rate, mono or stereo) -> 48 kHz stereo s16le. Null when it is not a WAV this can read.
 * Used for the VOICEPEAK fallback sentence.
 */
export function wavToPcm48kStereo(wav: Buffer): Buffer | null {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let format = 0;
  let dataStart = -1;
  let dataLength = 0;
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString('ascii', at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === 'fmt ' && body + 16 <= wav.length) {
      format = wav.readUInt16LE(body);
      channels = wav.readUInt16LE(body + 2);
      rate = wav.readUInt32LE(body + 4);
      bits = wav.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataStart = body;
      dataLength = Math.min(size, wav.length - body);
      break;
    }
    at = body + size + (size & 1);
  }
  if (dataStart < 0 || bits !== 16 || channels < 1 || rate < 1000 || (format !== 1 && format !== 0xfffe)) return null;
  const frameBytes = channels * 2;
  const inFrames = Math.floor(dataLength / frameBytes);
  if (inFrames === 0) return Buffer.alloc(0);
  const outFrames = Math.max(1, Math.round((inFrames * 48_000) / rate));
  const out = Buffer.allocUnsafe(outFrames * 4);
  const ratio = rate / 48_000;
  const sampleAt = (frame: number, channel: number): number =>
    wav.readInt16LE(dataStart + Math.min(frame, inFrames - 1) * frameBytes + Math.min(channel, channels - 1) * 2);
  for (let i = 0; i < outFrames; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const left = sampleAt(index, 0) * (1 - fraction) + sampleAt(index + 1, 0) * fraction;
    const right = channels > 1
      ? sampleAt(index, 1) * (1 - fraction) + sampleAt(index + 1, 1) * fraction
      : left;
    out.writeInt16LE(clamp16(Math.round(left)), i * 4);
    out.writeInt16LE(clamp16(Math.round(right)), i * 4 + 2);
  }
  return out;
}

/** 48 kHz stereo s16le -> 16 kHz mono s16le (average of 3 frames and both channels). */
export function pcm48kStereoTo16kMono(stereo: Buffer): Buffer {
  const groups = Math.floor(stereo.length / (BYTES_PER_FRAME_48K_STEREO * 3));
  const out = Buffer.allocUnsafe(groups * 2);
  for (let g = 0; g < groups; g += 1) {
    let sum = 0;
    const base = g * 12;
    for (let k = 0; k < 3; k += 1) {
      sum += stereo.readInt16LE(base + k * 4) + stereo.readInt16LE(base + k * 4 + 2);
    }
    out.writeInt16LE(Math.round(sum / 6), g * 2);
  }
  return out;
}

export function makeWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
