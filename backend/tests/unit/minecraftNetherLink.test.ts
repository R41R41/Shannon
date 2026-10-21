import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { inflateStats, installSyncInflate, uninstallSyncInflate } from '../../src/services/minebot/utils/syncInflate.js';
import { installLinkWatch } from '../../src/services/minebot/utils/linkWatch.js';

// Run 24, 39 s after the portal to the Nether: "Timed out". The inflater of minecraft-protocol takes turns of the event loop for every
// compressed packet; with a busy loop the Nether's chunks queued in it and the keep-alive waited behind them for over 15 s (lab netherlink,
// 2026-10-21: three compressed packets a second with the loop full). Inflated in place, a packet waits for no turn of the loop.

const require = createRequire(import.meta.url);
const protocolRequire = createRequire(createRequire(require.resolve('mineflayer')).resolve('minecraft-protocol'));
const compression = protocolRequire('./transforms/compression.js') as { createDecompressor(threshold: number, hideErrors?: boolean): any };
const [, writeVarInt, sizeOfVarInt] = (protocolRequire('protodef') as any).types.varint;

/** A frame as the server sends it: the length before compression, then the zlib stream (or 0 and the packet as it is). */
function frame(payload: Buffer, compress = true): Buffer {
  const body = compress ? zlib.deflateSync(payload) : payload;
  const length = compress ? payload.length : 0;
  const out = Buffer.alloc(sizeOfVarInt(length) + body.length);
  const offset = writeVarInt(length, out, 0);
  body.copy(out, offset);
  return out;
}
const chunkLike = (seed: number) => Buffer.from(Array.from({ length: 40_000 }, (_, i) => (i * seed + (i >> 7)) & 0xff));

/** Feeds frames to a fresh decompressor and counts what came out after one turn of the microtask/nextTick queues (no loop turn). */
async function outAfterOneTick(frames: Buffer[]): Promise<Buffer[]> {
  const decompressor = compression.createDecompressor(256, true);
  const out: Buffer[] = [];
  decompressor.on('data', (data: Buffer) => out.push(data));
  for (const f of frames) decompressor.write(f);
  await new Promise(resolve => process.nextTick(resolve));
  await Promise.resolve();
  return out;
}

afterEach(() => { uninstallSyncInflate(); });

describe('packets are inflated as they arrive (utils/syncInflate)', () => {
  it('the library alone needs turns of the event loop: none of 50 chunk-sized packets is out after one tick', async () => {
    uninstallSyncInflate();
    const out = await outAfterOneTick(Array.from({ length: 50 }, (_, i) => frame(chunkLike(i + 3))));
    expect(out.length).toBeLessThan(50);
  });

  it('installed, all of them are out in order, unchanged, with no turn of the loop', async () => {
    expect(installSyncInflate({ env: {} })).toBe('sync');
    const payloads = Array.from({ length: 50 }, (_, i) => chunkLike(i + 3));
    const before = inflateStats.compressed;
    const out = await outAfterOneTick(payloads.map(p => frame(p)));
    expect(out).toHaveLength(50);
    out.forEach((buffer, i) => expect(buffer.equals(payloads[i])).toBe(true));
    expect(inflateStats.compressed - before).toBe(50);
  });

  it('passes small packets on as they are, and drops one that does not inflate without stopping the rest', async () => {
    installSyncInflate({ env: {} });
    const small = Buffer.from('keep-alive-ish');
    const broken = Buffer.concat([frame(Buffer.alloc(300, 1)).subarray(0, 3), Buffer.from('not zlib at all')]);
    const after = chunkLike(9);
    const out = await outAfterOneTick([frame(small, false), broken, frame(after)]);
    expect(out).toHaveLength(2);
    expect(out[0].equals(small)).toBe(true);
    expect(out[1].equals(after)).toBe(true);
  });

  it('is installed once, and MINEBOT_SYNC_INFLATE=off leaves the library as it is', () => {
    expect(installSyncInflate({ env: { MINEBOT_SYNC_INFLATE: 'off' } })).toBe('off');
    expect(installSyncInflate({ env: {} })).toBe('sync');
    expect(installSyncInflate({ env: {} })).toBe('sync');
  });
});

describe('the link record counts what waits after the socket (utils/linkWatch)', () => {
  it('the splitter and the inflater are in the unread bytes (the socket itself stays near empty while they fill)', () => {
    const client: any = Object.assign(new EventEmitter(), {
      write: () => undefined, state: 'play',
      socket: { readableLength: 0, writableLength: 0 },
      splitter: { readableLength: 24_457, writableLength: 34_382 },
      decompressor: { readableLength: 0, writableLength: 19_765 },
    });
    const events = new EventEmitter();
    const bot: any = { _client: client, on: events.on.bind(events), removeListener: events.removeListener.bind(events) };
    const watch = installLinkWatch(bot, { checkMs: 1_000_000 })!;
    const sentence = watch.snapshot();
    expect(sentence).toContain(`未処理 受信${24_457 + 34_382 + 19_765}B`);
    expect(sentence).toContain('解凍待ち19765B');
    watch.dispose();
  });
});
