/**
 * A short wait after a respawn (or a change of dimension), before a long walk is planned.
 *
 * Run 20 (2026-10-20): the body died, came back 400 m from where it had died, and was told at once to walk to its
 * death place. The server sends the whole ring of chunks around a new position in the first seconds, the body reads
 * each (place memory, path search resets on every new chunk beside the search), and 21 s later the server dropped the
 * connection for silence. Whatever took the 70 s, planning a route across ground that is still arriving cannot have
 * helped: the chunk-loaded resets throw the search away again and again. So a walk asked for in the first seconds
 * after a respawn waits for the chunks to stop arriving (at most a few seconds), then starts.
 */
import { actionDelay } from '../execution/observedWait.js';

interface Tracker { respawnedAt: number; lastChunkAt: number; chunks: number }
interface Trackable {
  on(event: string, listener: (...args: any[]) => void): unknown;
}

const trackers = new WeakMap<object, Tracker>();

export interface SettleOptions {
  /** A respawn this recent (ms) is waited for. */
  withinMs?: number;
  /** The chunks must have been quiet this long (ms). */
  quietMs?: number;
  /** At least this long (ms) since the respawn: the first chunks are not in yet. */
  minAfterMs?: number;
  /** Never wait longer than this (ms). */
  maxWaitMs?: number;
}

export function installRespawnTracker(bot: Trackable): void {
  if (trackers.has(bot)) return;
  const tracker: Tracker = { respawnedAt: 0, lastChunkAt: 0, chunks: 0 };
  trackers.set(bot, tracker);
  const arrived = () => { tracker.respawnedAt = Date.now(); tracker.lastChunkAt = Date.now(); tracker.chunks = 0; };
  bot.on('respawn', arrived);
  bot.on('spawn', arrived);
  bot.on('chunkColumnLoad', () => { tracker.lastChunkAt = Date.now(); tracker.chunks++; });
}

/** Milliseconds since the body last respawned, or null when it never has (or nothing tracks it). */
export function sinceRespawnMs(bot: object): number | null {
  const tracker = trackers.get(bot);
  return tracker && tracker.respawnedAt ? Date.now() - tracker.respawnedAt : null;
}

/**
 * Waits, when the body respawned a moment ago, until the chunks around the new position have stopped arriving.
 * Returns what it waited for, or null when it did not wait. Never throws except the action's own interruption.
 */
export async function settleAfterRespawn(bot: object, options: SettleOptions = {}): Promise<{ waitedMs: number; chunks: number } | null> {
  const tracker = trackers.get(bot);
  if (process.env.MINEBOT_RESPAWN_SETTLE === 'off') return null;
  const { withinMs = 20_000, quietMs = 600, minAfterMs = 1_500, maxWaitMs = 6_000 } = options;
  if (!tracker || !tracker.respawnedAt || Date.now() - tracker.respawnedAt > withinMs) return null;
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    const now = Date.now();
    if (now - tracker.respawnedAt >= minAfterMs && now - tracker.lastChunkAt >= quietMs) break;
    await actionDelay(bot, 100);
  }
  return { waitedMs: Date.now() - startedAt, chunks: tracker.chunks };
}
