import type { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { matchingMultiBlockStateId } from './digBlockVerified.js';

const log = createLogger('Minebot:DigConfirmation');

/** How long the server gets to confirm a break after the client's own dig timer has run out. */
const CONFIRM_MS = 2000;

interface PredictingBot {
  on?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  _updateBlockState?(position: Vec3, stateId: number): void;
}

/**
 * The client's world must not run ahead of the server's. When the library's
 * dig timer ends it writes air into the client's world on its own; this puts
 * the block straight back, in the same instant, unless the server has already
 * said it is broken. The server's own block change then turns it to air.
 *
 * Rolling the guess back only after a wait left a window in which the client
 * held air the server did not: short on a healthy server, seconds long on one
 * that is ticking slowly (it counts a dig in its own ticks). Anything that
 * moved the body into the cell in that window was put back every tick: 69 and
 * 341 corrections in the first minutes of paid runs L34 and L35, whose
 * servers were both starting up on two cores.
 * Returns the function that stops watching.
 */
export function holdBlockUntilConfirmed(bot: PredictingBot, block: { position: Vec3; stateId: number }, confirmed: () => boolean): () => void {
  if (typeof bot.on !== 'function' || typeof bot._updateBlockState !== 'function') return () => {};
  const event = `blockUpdate:${block.position}`;
  let restoring = false;
  const onUpdate = (_before: unknown, now: { type?: number } | null) => {
    if (restoring || now?.type !== 0 || confirmed()) return;
    restoring = true;
    try { bot._updateBlockState!(block.position, block.stateId); } finally { restoring = false; }
  };
  bot.on(event, onUpdate);
  return () => { bot.removeListener?.(event, onUpdate); };
}

/** Hear the server's packet before the library applies it, so a real break is known to be real by the time the world changes. */
export function listenFirst(client: { on(event: string, listener: (packet: any) => void): unknown; prependListener?(event: string, listener: (packet: any) => void): unknown },
  event: string, listener: (packet: any) => void): void {
  if (typeof client.prependListener === 'function') client.prependListener(event, listener);
  else client.on(event, listener);
}

interface DigBot extends PredictingBot {
  dig?: (block: any, ...rest: any[]) => Promise<unknown>;
  /** The library's dig, without the confirmation below (for callers that confirm themselves). */
  unconfirmedDig?: (block: any, ...rest: any[]) => Promise<unknown>;
  blockAt?(position: Vec3): { stateId?: number } | null;
  _client?: { on(event: string, listener: (packet: any) => void): unknown; prependListener?(event: string, listener: (packet: any) => void): unknown;
    removeListener(event: string, listener: (packet: any) => void): unknown };
  supportFeature?(feature: string): boolean;
  registry?: { blocksByStateId?: Record<number, { id: number; name: string } | undefined> };
  ghostBlocksRestored?: number;
}

/**
 * Every dig is checked against the server's word. The library marks the block
 * as air when its own timer runs out; the server breaks it only when its own
 * count is done (five times slower in the air, five times again in water,
 * recomputed if the tool changes). Skills already confirm their digs, but the
 * pathfinder digs through the library directly: its "air" that the server
 * still held solid made the body walk into a block and be put back every
 * tick (73 times in 3.6 seconds in a lab probe, 27 in paid run L31), and can
 * leave it unable to move at all (L26). The client's guess is undone as it is
 * made (see holdBlockUntilConfirmed), and the dig is not reported finished
 * until the server confirms it or a short wait runs out.
 */
export function installDigConfirmation(bot: DigBot): void {
  const native = bot.dig?.bind(bot);
  const client = bot._client;
  if (!native || bot.unconfirmedDig || !client?.on) return;
  bot.unconfirmedDig = native;
  bot.ghostBlocksRestored = 0;
  bot.dig = async (block: any, ...rest: any[]) => {
    // Nothing to confirm when the block is already gone (a route planned before something else broke it).
    if (block?.type === 0 || bot.blockAt?.(block.position)?.stateId === 0) return native(block, ...rest);
    const position: Vec3 = block.position;
    const original: number = block.stateId;
    const type: number = block.type;
    let broken = false;
    let wake: (() => void) | undefined;
    const observe = (stateId: number | null) => {
      if (stateId === null || !Number.isInteger(stateId)) return;
      const replacement = bot.registry?.blocksByStateId?.[stateId];
      // The old state echoed back, or a state-only change of the same block, is not a break.
      broken = replacement ? replacement.id !== type : stateId !== original;
      if (broken) wake?.();
    };
    const onBlockChange = (packet: any) => {
      const at = packet?.location;
      if (at && at.x === position.x && at.y === position.y && at.z === position.z) observe(Number(packet.type));
    };
    const onMultiBlockChange = (packet: any) => { observe(matchingMultiBlockStateId(bot as any, packet, position)); };
    listenFirst(client, 'block_change', onBlockChange);
    listenFirst(client, 'multi_block_change', onMultiBlockChange);
    const release = holdBlockUntilConfirmed(bot, { position, stateId: original }, () => broken);
    try {
      const result = await native(block, ...rest);
      if (!broken) await new Promise<void>(resolve => { const timer = setTimeout(resolve, CONFIRM_MS); wake = () => { clearTimeout(timer); resolve(); }; });
      if (!broken) {
        if (bot.blockAt?.(position)?.stateId !== original) bot._updateBlockState?.(position, original);
        bot.ghostBlocksRestored = (bot.ghostBlocksRestored ?? 0) + 1;
        log.warn(`⛏ サーバーが破壊を確認していないブロックを元に戻した: ${block.name}(${position.x}, ${position.y}, ${position.z})（累計${bot.ghostBlocksRestored}件）`);
      }
      return result;
    } finally {
      release();
      client.removeListener('block_change', onBlockChange);
      client.removeListener('multi_block_change', onMultiBlockChange);
    }
  };
}

export function digConfirmationPlugin(bot: unknown): void { installDigConfirmation(bot as DigBot); }
