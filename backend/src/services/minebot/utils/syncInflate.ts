import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import { createLogger } from '../../../utils/logger.js';

/**
 * The body's packets from the server, inflated as they arrive.
 *
 * Run 24, in the Nether: "I_am_Shannon lost connection: Timed out" 39 s after the portal, while the body's event loop was never stopped
 * more than 0.7 s. minecraft-protocol inflates each compressed packet with zlib's thread-pool call, one packet at a time: the next is
 * started only from the callback of the last. A packet therefore costs several turns of the event loop, whatever its size. When the loop is
 * busy (the physics tick, the route search, a chunk's reading: run 24 had p99 298 ms in that minute), the turns are slow, and the inflating
 * falls to a few packets a second. The Nether's first chunks (hundreds of compressed packets) queue up behind it, and so does everything
 * that comes after them, the keep-alive included: the server waited 15 s for the answer and closed the connection, and a keep-alive was still
 * handled after the end (the 120 s clock that rang at 18:14:02). The lab (2026-10-21, netherlink) saw the same: with the loop full, three
 * compressed packets a second came out of the inflater, frames waited seconds in it, and keep-alives came seconds late.
 *
 * Inflated in place (zlib's synchronous call, as the game's own client does on its network thread), a packet no longer waits for turns of
 * the loop: the socket's data is handled in the callback it arrives in, at the speed of the CPU (a chunk packet is well under a
 * millisecond). Everything else is as the library does it: an uncompressed frame is passed on, a frame that does not inflate is dropped
 * with a line, a length that does not match is said.
 *
 * MINEBOT_SYNC_INFLATE=off leaves the library's own inflater (the way back).
 */

const log = createLogger('Minebot:Inflate');

type Callback = (error?: Error | null) => void;
type ReadVarInt = (buffer: Buffer, offset: number) => { size: number; value: number; error?: Error };
interface DecompressorLike { push(chunk: Buffer): unknown; hideErrors?: boolean }
interface TransformPrototype { _transform: (this: DecompressorLike, chunk: Buffer, encoding: BufferEncoding, callback: Callback) => void }

/** What the inflater has done (read by the link's record). */
export const inflateStats = { packets: 0, compressed: 0, bytesIn: 0, bytesOut: 0, totalMs: 0, maxMs: 0, errors: 0 };

const SAY_GAP_MS = 10_000;
let lastSaid = -Infinity;
const sayOnce = (text: string) => { const now = Date.now(); if (now - lastSaid < SAY_GAP_MS) return; lastSaid = now; log.warn(text); };

/** The transform: minecraft-protocol's Decompressor._transform, with zlib.unzipSync in place of zlib.unzip. */
export function syncInflateTransform(readVarInt: ReadVarInt, now: () => number = () => performance.now()) {
  return function (this: DecompressorLike, chunk: Buffer, _encoding: BufferEncoding, callback: Callback): void {
    const { size, value, error } = readVarInt(chunk, 0);
    if (error) return callback(error);
    inflateStats.packets++;
    if (value === 0) {
      this.push(chunk.subarray(size));
      return callback();
    }
    const started = now();
    let inflated: Buffer;
    try {
      // Z_SYNC_FLUSH, as the library: a stream the server ended without a final block still gives what it has.
      inflated = zlib.unzipSync(chunk.subarray(size), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    } catch (cause) {
      inflateStats.errors++;
      if (!this.hideErrors) sayOnce(`パケットを解凍できませんでした（${(cause as Error)?.message ?? cause}、圧縮${chunk.length}B・本来${value}B）。そのパケットは捨てます`);
      return callback();
    }
    const took = now() - started;
    inflateStats.compressed++; inflateStats.bytesIn += chunk.length; inflateStats.bytesOut += inflated.length;
    inflateStats.totalMs += took; inflateStats.maxMs = Math.max(inflateStats.maxMs, took);
    if (inflated.length !== value && !this.hideErrors) sayOnce(`解凍したパケットの長さが違います（${inflated.length}B、本来${value}B）`);
    this.push(inflated);
    return callback();
  };
}

let installed: { prototype: TransformPrototype; original: TransformPrototype['_transform'] } | null = null;

/** The library's inflater, found the way mineflayer finds it (the copy of minecraft-protocol it loads). */
function decompressorPrototype(from: NodeRequire): { prototype: TransformPrototype; readVarInt: ReadVarInt } {
  const mineflayerRequire = createRequire(from.resolve('mineflayer'));
  const protocolRequire = createRequire(mineflayerRequire.resolve('minecraft-protocol'));
  const compression = protocolRequire('./transforms/compression.js') as { createDecompressor?: (threshold: number, hideErrors?: boolean) => object };
  const readVarInt = (protocolRequire('protodef') as { types?: { varint?: [ReadVarInt] } }).types?.varint?.[0];
  if (typeof compression.createDecompressor !== 'function' || typeof readVarInt !== 'function') throw new Error('minecraft-protocol の形が違います');
  const prototype = Object.getPrototypeOf(compression.createDecompressor(256)) as TransformPrototype;
  if (typeof prototype?._transform !== 'function') throw new Error('Decompressor._transform がありません');
  return { prototype, readVarInt };
}

/**
 * Puts the in-place inflater on minecraft-protocol's Decompressor (every client made after, and the ones whose compression is set after).
 * Once a process; returns what it did.
 */
export function installSyncInflate(options: { env?: NodeJS.ProcessEnv; require?: NodeRequire } = {}): 'sync' | 'off' | 'unavailable' {
  if (installed) return 'sync';
  if ((options.env ?? process.env).MINEBOT_SYNC_INFLATE === 'off') return 'off';
  try {
    const { prototype, readVarInt } = decompressorPrototype(options.require ?? createRequire(import.meta.url));
    installed = { prototype, original: prototype._transform };
    prototype._transform = syncInflateTransform(readVarInt);
    log.info('📦 サーバーからのパケットは届いたその場で解凍します（スレッドプールを待たない）');
    return 'sync';
  } catch (error) {
    log.warn(`パケットをその場で解凍する形にできませんでした（ライブラリの形のまま）: ${error instanceof Error ? error.message : String(error)}`);
    return 'unavailable';
  }
}

/** The library's own inflater back (tests and lab comparisons). */
export function uninstallSyncInflate(): void {
  if (!installed) return;
  installed.prototype._transform = installed.original;
  installed = null;
}
