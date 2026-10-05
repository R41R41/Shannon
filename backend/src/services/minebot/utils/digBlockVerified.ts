import type { Block } from 'prismarine-block';
import type { Vec3 } from 'vec3';
import type { CustomBot } from '../types/CustomBot.js';
import { actionSignal } from '../execution/ActionExecution.js';
import { holdBlockUntilConfirmed, listenFirst } from './digConfirmation.js';
import { holdsWater } from './waterBlocks.js';
import { assertNoLavaRelease } from './lavaSafety.js';
import { assertNoThreatExposure } from './exposureGuard.js';

/**
 * Mineflayer's dig() predicts air locally when its dig timer expires. Its
 * blockUpdate/diggingCompleted events therefore do not prove the server broke
 * the block. Only a matching block-change packet from the server does.
 */
export class ServerDigUnconfirmedError extends Error {
  readonly failureType = 'dig_unconfirmed';

  constructor(position: Vec3, observedStateIds: readonly number[]) {
    super(`採掘をサーバー側で確認できませんでした (${position.x},${position.y},${position.z})`
      + (observedStateIds.length ? `。受信した状態ID: ${observedStateIds.join(',')}` : '。対象のブロック更新を受信していません'));
    this.name = 'ServerDigUnconfirmedError';
  }
}

export interface ServerConfirmedDig {
  /** The state ID in the server's block-change packet, never local prediction. */
  stateId: number;
  blockName: string;
}

interface PacketClient {
  on(event: string, listener: (packet: any) => void): unknown;
  prependListener?(event: string, listener: (packet: any) => void): unknown;
  removeListener(event: string, listener: (packet: any) => void): unknown;
}

function samePosition(a: any, b: Vec3): boolean {
  return a && a.x === b.x && a.y === b.y && a.z === b.z;
}

/** Decode one Minecraft multi_block_change record to an absolute block. */
export function matchingMultiBlockStateId(bot: Pick<CustomBot, 'supportFeature'>, packet: any, target: Vec3): number | null {
  if (!Array.isArray(packet?.records)) return null;
  const singleLong = bot.supportFeature('usesMultiblockSingleLong');
  const threeDimensional = bot.supportFeature('usesMultiblock3DChunkCoords');
  const section = threeDimensional ? packet.chunkCoordinates : null;
  const sectionX = Number(section?.x ?? packet.chunkX);
  const sectionY = threeDimensional ? Number(section?.y) : 0;
  const sectionZ = Number(section?.z ?? packet.chunkZ);
  if (![sectionX, sectionY, sectionZ].every(Number.isFinite)) return null;

  for (const record of packet.records) {
    const packed = singleLong ? Number(record) : NaN;
    const blockX = singleLong ? Math.floor(packed / 256) & 15 : (Number(record?.horizontalPos) >> 4) & 15;
    const blockY = singleLong ? packed & 15 : Number(record?.y);
    const blockZ = singleLong ? (Math.floor(packed / 16) & 15) : Number(record?.horizontalPos) & 15;
    const stateId = singleLong ? Math.floor(packed / 4096) : Number(record?.blockId);
    if (![blockX, blockY, blockZ, stateId].every(Number.isFinite)) continue;
    if (sectionX * 16 + blockX === target.x
      && sectionY * 16 + blockY === target.y
      && sectionZ * 16 + blockZ === target.z) return stateId;
  }
  return null;
}

function restoreAuthoritativeState(bot: CustomBot, position: Vec3, stateId: number): void {
  try {
    if (bot.blockAt(position)?.stateId === stateId) return;
    (bot as CustomBot & { _updateBlockState?: (position: Vec3, stateId: number) => void })
      ._updateBlockState?.(position, stateId);
  } catch { /* a correction failure must not mask the original dig result */ }
}

/**
 * Mineflayer's dig() first waits for an unforced look to be sent, and that
 * wait is not cancelled by stopDigging(). A live shelter dig stalled there for
 * the whole skill timeout, and the unsettled runImpl kept the physical lease,
 * so every later skill hit lock_timeout. Force the look (the server checks
 * reach, not view direction) and bound the call by the action signal and the
 * block's own dig time.
 */
async function digBounded(bot: CustomBot, block: Block): Promise<void> {
  const signal = actionSignal(bot);
  const expectedMs = typeof bot.digTime === 'function' ? Number(bot.digTime(block)) : 0;
  const limitMs = (Number.isFinite(expectedMs) ? expectedMs : 0) * 2 + 10_000;
  // This function confirms the break itself: use the library's dig, not the confirming wrapper around it.
  const dig = ((bot as any).unconfirmedDig ?? bot.dig.bind(bot))(block, true) as Promise<void>;
  dig.catch(() => { /* an abandoned dig must not surface as unhandled */ });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([dig, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`採掘が${Math.round(limitMs / 1000)}秒以内に終わりませんでした（${block.name}）`)), limitMs);
      onAbort = () => reject(new Error('Action interrupted'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    })]);
  } catch (error) {
    try { bot.stopDigging?.(); } catch { /* keep the original failure */ }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Whether the state that makes this dig slow (afloat, airborne) is about to
 * end by itself, so that waiting a moment buys a dig five or twenty-five times
 * quicker. A hop lands; a flow left by a scooped source drains. Standing water
 * does neither: a body under an ice sheet waited the full three seconds for
 * the lake to go away before starting the dig that was to give it air, and the
 * air ran out first (paid run L50).
 */
export function slowDigStateIsPassing(bot: Pick<CustomBot, 'entity' | 'blockAt'>): boolean {
  const entity = bot.entity as (CustomBot['entity'] & { isInWater?: boolean }) | undefined;
  if (!entity?.position) return false;
  if (!entity.isInWater) return entity.onGround === false;
  try {
    const feet = entity.position.floored();
    // Water over the feet's cell: the body is in a pool, not in a film running off.
    if (holdsWater(bot.blockAt(feet.offset(0, 1, 0)))) return false;
    const at: any = bot.blockAt(feet);
    const level = Number(at?.getProperties?.().level ?? at?.metadata);
    // Levels 1-7 are a flow spreading from a source; the source itself (0) and falling water (8+) stay.
    return at?.name === 'water' && level >= 1 && level <= 7;
  } catch { return false; }
}

/**
 * Dig and require a server packet showing the target changed to a different
 * block type. A state-only change to the same block (e.g. crop age) is not a
 * confirmed break. On missing proof, undo Mineflayer's local ghost-air write.
 */
export async function digBlockVerified(
  bot: CustomBot,
  block: Block,
  timeoutMs = 2500,
): Promise<ServerConfirmedDig> {
  // What the dig would let loose is asked before anything else (this path calls the library's dig directly).
  assertNoLavaRelease(bot as any, block);
  // The verified dig goes round the body's own `dig` (it waits for the server's word itself), so the other
  // rule every dig is held to is asked here too.
  assertNoThreatExposure(bot as any, block);
  const client = bot._client as unknown as PacketClient | undefined;
  if (!client?.on || !client?.removeListener) {
    throw new ServerDigUnconfirmedError(block.position, []);
  }
  const position = block.position;
  const observedStateIds: number[] = [];
  let confirmation: ServerConfirmedDig | null = null;
  let notify: (() => void) | undefined;
  const observe = (stateId: number | null) => {
    if (stateId === null || !Number.isInteger(stateId)) return;
    observedStateIds.push(stateId);
    const replacement = bot.registry.blocksByStateId?.[stateId];
    // The server may first echo the old state when mining starts. Do not count
    // that acknowledgement, nor a state-only update of the same block type.
    if (!replacement) return;
    if (replacement.id === block.type) {
      confirmation = null; // a later correction supersedes an earlier change
      return;
    }
    confirmation = { stateId, blockName: replacement.name };
    notify?.();
  };
  const onBlockChange = (packet: any) => {
    if (samePosition(packet?.location, position)) observe(Number(packet.type));
  };
  const onMultiBlockChange = (packet: any) => {
    observe(matchingMultiBlockStateId(bot, packet, position));
  };

  listenFirst(client, 'block_change', onBlockChange);
  listenFirst(client, 'multi_block_change', onMultiBlockChange);
  // The library's own guess of air is undone as it is made: only the server's packet turns this block to air.
  const release = holdBlockUntilConfirmed(bot as any, block, () => confirmation !== null);
  try {
    // Mineflayer fixes the whole dig duration when digging starts (x5 in
    // water, x5 while airborne). Draining flow from a scooped source or a
    // landing hop would stretch a 9s obsidian dig past a minute. Only a state
    // that will pass is waited out.
    const settleDeadline = Date.now() + 3000;
    while (Date.now() < settleDeadline && slowDigStateIsPassing(bot)
      && !actionSignal(bot)?.aborted) await new Promise(resolve => setTimeout(resolve, 100));
    await digBounded(bot, block);
    if (!confirmation) {
      await new Promise<void>((resolve, reject) => {
        const signal = actionSignal(bot);
        let timer: ReturnType<typeof setTimeout>;
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          notify = undefined;
        };
        const onAbort = () => { cleanup(); reject(new Error('Action interrupted')); };
        timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs);
        notify = () => { cleanup(); resolve(); };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    }
    if (!confirmation) throw new ServerDigUnconfirmedError(position, observedStateIds);
    // A server packet can arrive before Mineflayer's local dig timer, which
    // then overwrites it with predicted air. Keep the local map synchronized
    // with the last authoritative state before downstream path/placement work.
    restoreAuthoritativeState(bot, position, confirmation.stateId);
    return confirmation;
  } catch (error) {
    if (!confirmation) restoreAuthoritativeState(bot, position, block.stateId);
    throw error;
  } finally {
    release();
    client.removeListener('block_change', onBlockChange);
    client.removeListener('multi_block_change', onMultiBlockChange);
  }
}
