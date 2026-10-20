/**
 * The opus codec the voice channel's listening path decodes with (Discord sends 48 kHz stereo opus packets).
 * @discordjs/opus (native) is preferred; when its native addon is missing for this node/CPU, opusscript (wasm, the
 * same package @discordjs/voice / prism-media fall back to for playback) is used instead, so a missing build no
 * longer turns listening off. Both are dependencies of the backend.
 */
export type OpusBackend = '@discordjs/opus' | 'opusscript';

export interface OpusDecoder {
  /** One opus packet -> interleaved s16le PCM. Throws on a corrupted packet. */
  decode(packet: Buffer): Buffer;
  /** Frees the decoder (opusscript keeps wasm memory until then). */
  dispose(): void;
}

export interface OpusCodec {
  backend: OpusBackend;
  decoder(sampleRate: number, channels: number): OpusDecoder;
}

type Importer = (specifier: string) => Promise<unknown>;

const defaultImporter: Importer = (specifier) => import(specifier);

function moduleExport(mod: unknown): any {
  const value = mod as { default?: unknown } | undefined;
  return value && typeof value === 'object' && 'default' in value && value.default ? value.default : mod;
}

/** The first codec that loads: @discordjs/opus, then opusscript; null when neither does. Never throws. */
export async function loadOpusCodec(importer: Importer = defaultImporter): Promise<OpusCodec | null> {
  try {
    const OpusEncoder = moduleExport(await importer('@discordjs/opus'))?.OpusEncoder;
    if (typeof OpusEncoder === 'function') {
      return {
        backend: '@discordjs/opus',
        decoder: (sampleRate, channels) => {
          const encoder = new OpusEncoder(sampleRate, channels);
          return { decode: (packet) => encoder.decode(packet), dispose: () => undefined };
        },
      };
    }
  } catch {
    // the native addon is not built for this node / CPU: try opusscript
  }
  try {
    const OpusScript = moduleExport(await importer('opusscript'));
    if (typeof OpusScript === 'function') {
      return {
        backend: 'opusscript',
        decoder: (sampleRate, channels) => {
          const codec = new OpusScript(sampleRate, channels, OpusScript.Application?.AUDIO);
          return {
            decode: (packet) => Buffer.from(codec.decode(packet)),
            dispose: () => { try { codec.delete(); } catch { /* already freed */ } },
          };
        },
      };
    }
  } catch {
    // neither codec is installed
  }
  return null;
}
