/**
 * The listening path's opus codec (opusCodec.ts): @discordjs/opus when its native addon loads, else opusscript,
 * else none. The importer is a fake for the choice; the last test decodes a real packet with whichever codec this
 * machine has (opusscript is always installed).
 */
import { describe, expect, it } from 'vitest';
import { loadOpusCodec } from '../../src/services/discord/voice/opusCodec.js';

class FakeNative {
  constructor(public rate: number, public channels: number) {}
  decode(packet: Buffer): Buffer { return Buffer.concat([Buffer.from('n'), packet]); }
}

let freed = 0;
class FakeScript {
  static Application = { AUDIO: 2049 };
  constructor(public rate: number, public channels: number, public app: number) {}
  decode(packet: Buffer): Buffer { return Buffer.concat([Buffer.from('s'), packet]); }
  delete(): void { freed += 1; }
}

function importer(table: Record<string, unknown>) {
  return async (name: string) => {
    if (!(name in table)) throw new Error(`Cannot find module '${name}'`);
    const value = table[name];
    if (value instanceof Error) throw value;
    return value;
  };
}

describe('opus codec choice', () => {
  it('prefers @discordjs/opus (default export, as an ES import of the CommonJS package gives it)', async () => {
    const codec = await loadOpusCodec(importer({ '@discordjs/opus': { default: { OpusEncoder: FakeNative } }, opusscript: { default: FakeScript } }));
    expect(codec?.backend).toBe('@discordjs/opus');
    const decoder = codec!.decoder(48000, 2);
    expect(decoder.decode(Buffer.from('x')).toString()).toBe('nx');
    decoder.dispose();
  });

  it('falls back to opusscript when the native addon is not built for this node / CPU, and frees each decoder', async () => {
    const missingBuild = new Error("Cannot find module '.../prebuild/node-v127-napi-v3-linux-x64-glibc-2.31/opus.node'");
    const codec = await loadOpusCodec(importer({ '@discordjs/opus': missingBuild, opusscript: { default: FakeScript } }));
    expect(codec?.backend).toBe('opusscript');
    const before = freed;
    const decoder = codec!.decoder(48000, 2);
    expect(decoder.decode(Buffer.from('y')).toString()).toBe('sy');
    decoder.dispose();
    decoder.dispose();
    expect(freed).toBe(before + 1 + 1);
  });

  it('is null when neither loads', async () => {
    expect(await loadOpusCodec(importer({}))).toBeNull();
    expect(await loadOpusCodec(importer({ '@discordjs/opus': { default: {} }, opusscript: { default: {} } }))).toBeNull();
  });

  it('decodes a real packet with the codec this machine has (48 kHz stereo, 20 ms)', async () => {
    const codec = await loadOpusCodec();
    expect(codec).not.toBeNull();
    const OpusScript = (await import('opusscript')).default as any;
    const encoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    const pcm = Buffer.alloc(960 * 2 * 2);
    for (let i = 0; i < 960; i++) {
      const v = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 48000));
      pcm.writeInt16LE(v, i * 4);
      pcm.writeInt16LE(v, i * 4 + 2);
    }
    const packet = Buffer.from(encoder.encode(pcm, 960));
    encoder.delete();
    const decoder = codec!.decoder(48000, 2);
    try {
      expect(decoder.decode(packet).length).toBe(pcm.length);
    } finally {
      decoder.dispose();
    }
  });
});
