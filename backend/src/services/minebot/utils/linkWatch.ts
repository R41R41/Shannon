/**
 * What the body's connection to the server is doing, kept so that a drop can be read afterwards -- and used, a little, while it lasts.
 *
 * Run 24, 39 s after the portal to the Nether: the server wrote "I_am_Shannon lost connection: Timed out" (it had had no answer to its
 * keep-alive for 15 s), the body wrote EPIPE, and the keep-alive clock of the dead client rang 120 s later, which means a keep-alive
 * packet was still being handled after the connection had ended. Twelve digs between 18:11:46 and 18:12:02 had been put back as "the server
 * never confirmed them". The body's event loop was never stopped more than 0.7 s, and the server had been slow once, 40 s before. So
 * something between the socket and the packet handlers ran about fifteen seconds behind, or the answers did not get out; the journal could
 * not say which. Kept here:
 *   - when the last packet was handled, how many, and how many bytes the socket had read and not yet handed on;
 *   - each keep-alive in and out: how long the answer took, and how late the packet was (the server's own clock runs in its ids);
 *   - the dimension changes (what the client was told, and when the first position and the first chunk came after);
 * written to the journal when a keep-alive was answered late or not at all, and in one line when the connection ends. `snapshot()` is the
 * same in a sentence for the lines that need it (the dig the server did not confirm).
 */
import { createLogger } from '../../../utils/logger.js';
import { inflateStats } from './syncInflate.js';

const log = createLogger('Minebot:Link');

/** A keep-alive answered later than this, or one that arrived later than the server's own clock says it was sent: said in the journal. */
export const LATE_KEEPALIVE_MS = 3_000;
/** Without a keep-alive in for this long the link is called silent. */
export const SILENT_MS = 20_000;
/** A server keep-alive comes about every 15 s; the check runs this often. */
const CHECK_MS = 5_000;
/** No more than one line of a kind in this long. */
const SAY_GAP_MS = 10_000;

interface Buffered { readableLength?: number; writableLength?: number }
interface ClientLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  prependListener?(event: string, listener: (...args: any[]) => void): unknown;
  write(name: string, params?: unknown): unknown;
  socket?: { on?(event: string, listener: (...args: any[]) => void): unknown; readableLength?: number; writableLength?: number; bytesRead?: number; bytesWritten?: number };
  /** The stages after the socket (minecraft-protocol): the frames cut from it, and the inflater. Piped, so the socket's own buffer stays
   * near empty while these fill (lab 2026-10-21: socket 0 B, splitter 34 KB, inflater 20 KB and 240 frames). */
  splitter?: Buffered | null;
  decompressor?: Buffered | null;
  state?: string;
}
interface WatchedBot {
  _client?: ClientLike;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  game?: { dimension?: unknown };
  entity?: { position?: { x: number; y: number; z: number } };
}

export interface LinkStats {
  packetsIn: number;
  lastPacketAt: number;
  keepAlivesIn: number;
  keepAlivesOut: number;
  lastKeepAliveInAt: number;
  lastKeepAliveOutAt: number;
  /** The longest an answer took after its keep-alive was handled (ms), and the most a keep-alive was late by the server's clock. */
  maxAnswerMs: number;
  maxLateMs: number;
  /** Keep-alives handled and not answered yet. */
  unanswered: number;
  dimensionChanges: Array<{ at: number; to: string; firstPositionMs: number | null; firstChunkMs: number | null }>;
}

export interface LinkWatch {
  stats: LinkStats;
  /** One sentence of the link's state now (empty when there is nothing odd). */
  snapshot(): string;
  /** Whether the link looks behind: a keep-alive unanswered for LATE_KEEPALIVE_MS, or none heard for SILENT_MS. */
  behind(now?: number): boolean;
  dispose(): void;
}

const watches = new WeakMap<object, LinkWatch>();
export function linkWatchOf(bot: object): LinkWatch | undefined { return watches.get(bot); }

/** A keep-alive id as a number: the library gives a BigInt, or [high, low]. */
function idOf(value: unknown): number | null {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  if (Array.isArray(value) && value.length === 2) return Number(value[0]) * 4294967296 + (Number(value[1]) >>> 0);
  return null;
}

export function installLinkWatch(bot: WatchedBot, options: { now?: () => number; checkMs?: number } = {}): LinkWatch | null {
  const client = bot._client;
  if (!client || typeof client.on !== 'function') return null;
  if (watches.has(bot)) return watches.get(bot)!;
  const now = options.now ?? Date.now;
  const stats: LinkStats = { packetsIn: 0, lastPacketAt: now(), keepAlivesIn: 0, keepAlivesOut: 0, lastKeepAliveInAt: 0, lastKeepAliveOutAt: 0,
    maxAnswerMs: 0, maxLateMs: 0, unanswered: 0, dimensionChanges: [] };
  const said = new Map<string, number>();
  const say = (kind: string, text: string, level: 'warn' | 'info' = 'warn') => {
    const at = now();
    if (at - (said.get(kind) ?? -Infinity) < SAY_GAP_MS) return;
    said.set(kind, at);
    log[level](text);
  };
  let pendingIn: number[] = [];
  let lastId: { id: number; at: number } | null = null;
  const held = (stage: Buffered | null | undefined) => (stage?.readableLength ?? 0) + (stage?.writableLength ?? 0);
  // Read from the socket and not yet handled: the socket's buffer, the splitter's and the inflater's.
  const unread = () => (client.socket?.readableLength ?? 0) + held(client.splitter) + held(client.decompressor);
  const unsent = () => client.socket?.writableLength ?? 0;

  const describe = () => {
    const at = now();
    const parts = [
      `最後に処理したパケット ${Math.round((at - stats.lastPacketAt) / 100) / 10}秒前（計${stats.packetsIn}個）`,
      stats.lastKeepAliveInAt ? `keep-alive 受信 ${Math.round((at - stats.lastKeepAliveInAt) / 100) / 10}秒前（${stats.keepAlivesIn}回）` : 'keep-alive はまだ受信していない',
      stats.lastKeepAliveOutAt ? `返信 ${Math.round((at - stats.lastKeepAliveOutAt) / 100) / 10}秒前（${stats.keepAlivesOut}回、未返信${stats.unanswered}）` : '返信なし',
      `返信の最長 ${stats.maxAnswerMs}ms、サーバーの時計より遅れた最大 ${stats.maxLateMs}ms`,
      `未処理 受信${unread()}B（ソケット${client.socket?.readableLength ?? 0}B・切り分け${held(client.splitter)}B・解凍待ち${held(client.decompressor)}B）・送信待ち${unsent()}B`,
      `解凍 ${inflateStats.compressed}個・最長${Math.round(inflateStats.maxMs)}ms`,
      `状態 ${client.state ?? '?'}`,
    ];
    return parts.join('、');
  };

  // Every packet handled; and a keep-alive heard before the library answers it.
  const onPacket = () => { stats.packetsIn++; stats.lastPacketAt = now(); };
  const onKeepAlive = (packet: { keepAliveId?: unknown }) => {
    const at = now();
    stats.keepAlivesIn++; stats.lastKeepAliveInAt = at; stats.unanswered++;
    pendingIn.push(at);
    const id = idOf(packet?.keepAliveId);
    if (id !== null && lastId) {
      // The ids are the server's clock in ms: the gap between two ids against the gap between their arrivals is how late this one is.
      const late = (at - lastId.at) - (id - lastId.id);
      if (id > lastId.id && id - lastId.id < 120_000) {
        stats.maxLateMs = Math.max(stats.maxLateMs, Math.max(0, Math.round(late)));
        if (late >= LATE_KEEPALIVE_MS) say('late', `🔗 keep-alive がサーバーの時計より${Math.round(late / 100) / 10}秒遅れて届きました（${describe()}）`);
      }
    }
    if (id !== null) lastId = { id, at };
  };
  // A client with no write (a test double) is watched for what it receives only.
  const original: ClientLike['write'] = typeof client.write === 'function' ? client.write.bind(client) : () => undefined;
  const wrapped = (name: string, params?: unknown) => {
    if (name === 'keep_alive') {
      const at = now();
      const heard = pendingIn.shift();
      stats.keepAlivesOut++; stats.lastKeepAliveOutAt = at; stats.unanswered = Math.max(0, stats.unanswered - 1);
      if (heard !== undefined) {
        const took = at - heard;
        stats.maxAnswerMs = Math.max(stats.maxAnswerMs, took);
        if (took >= LATE_KEEPALIVE_MS) say('slow-answer', `🔗 keep-alive の返信に${Math.round(took / 100) / 10}秒かかりました（${describe()}）`);
      }
    }
    return original(name, params);
  };
  const canWrap = typeof client.write === 'function';
  if (canWrap) (client as { write: ClientLike['write'] }).write = wrapped;

  // Dimension changes: what came after the respawn packet, and how soon.
  const onRespawn = () => {
    const at = now();
    const entry = { at, to: String(bot.game?.dimension ?? '?'), firstPositionMs: null as number | null, firstChunkMs: null as number | null };
    stats.dimensionChanges.push(entry);
    if (stats.dimensionChanges.length > 6) stats.dimensionChanges.shift();
    // Each is heard once (the first position and the first chunk after the change) and then taken off.
    const position = () => { entry.firstPositionMs ??= now() - at; bot.removeListener?.('move', position); };
    const chunk = () => { entry.firstChunkMs ??= now() - at; bot.removeListener?.('chunkColumnLoad', chunk); };
    bot.on('move', position);
    bot.on('chunkColumnLoad', chunk);
    log.info(`🔗 次元が変わりました（${entry.to}）。${describe()}`);
  };
  bot.on('respawn', onRespawn);

  const timer = setInterval(() => {
    const at = now();
    if (stats.lastKeepAliveInAt && at - stats.lastKeepAliveInAt > SILENT_MS) say('silent', `🔗 サーバーからの keep-alive が${Math.round((at - stats.lastKeepAliveInAt) / 1000)}秒来ていません（${describe()}）`);
    if (stats.unanswered > 0 && pendingIn.length && at - pendingIn[0] > LATE_KEEPALIVE_MS) say('unanswered', `🔗 keep-alive に${Math.round((at - pendingIn[0]) / 100) / 10}秒返信していません（${describe()}）`);
    if (unread() > 512 * 1024) say('backlog', `🔗 ソケットに読み残しが${Math.round(unread() / 1024)}KBあります（${describe()}）`);
  }, options.checkMs ?? CHECK_MS);
  (timer as { unref?: () => void }).unref?.();

  if (typeof client.prependListener === 'function') client.prependListener('keep_alive', onKeepAlive); else client.on('keep_alive', onKeepAlive);
  client.on('packet', onPacket);

  const watch: LinkWatch = {
    stats,
    snapshot: () => describe(),
    behind(at = now()) {
      return (stats.unanswered > 0 && pendingIn.length > 0 && at - pendingIn[0] > LATE_KEEPALIVE_MS)
        || (stats.lastKeepAliveInAt > 0 && at - stats.lastKeepAliveInAt > SILENT_MS) || unread() > 512 * 1024;
    },
    dispose() {
      clearInterval(timer);
      if (canWrap && (client as { write: unknown }).write === wrapped) (client as { write: ClientLike['write'] }).write = original;
      watches.delete(bot);
    },
  };
  watches.set(bot, watch);
  // The end of the connection, in one line, with the last keep-alive and the longest answers; and the keep-alive listeners come off the
  // dead client (a keep-alive handled after the end armed a 120 s clock that rang on a body that had gone: run 24, 18:14:02).
  bot.on('end', () => {
    log.warn(`🔗 接続が終わりました。${describe()}`);
    try { (client as unknown as { removeAllListeners?(event: string): unknown }).removeAllListeners?.('keep_alive'); } catch { /* the client is gone anyway */ }
    watch.dispose();
  });
  return watch;
}

export function linkWatchPlugin(bot: unknown): void { installLinkWatch(bot as WatchedBot); }
