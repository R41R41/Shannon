import { Vec3 } from 'vec3';
import { bodyReader, type BlockReader } from './localMap.js';
import { dropUnder } from './voidFooting.js';
import { isEnd } from './dragonState.js';
import { activateItemFacing } from './activateItemFacing.js';

/**
 * A fall that would cripple or kill, stopped with a bucket of water (the clutch every player knows). In the End a body that climbed a pillar for a caged crystal is up to 40 blocks over the ground, and
 * the dragon's wings push what is near: a fall of 30 blocks is 27 points of damage, and armour does not take any of it. Water laid on the ground under the body as it comes down takes the fall.
 *
 * The bucket reaches 4.5 blocks from the eye. At the speed of a fall of up to 55 blocks (under 2.9 blocks a tick) there is always a physics tick with the ground inside the reach and the body not yet
 * on it, so the pour is made in that tick (the use packet follows the position packet of the same tick). Only in the End, only with a bucket of water carried, only where the ground under the body is a
 * solid floor (not water, lava, the void or what is not loaded) and the fall would cost at least CLUTCH_MIN_DAMAGE.
 */
export const CLUTCH_FALLING_VY = -0.75;
export const CLUTCH_MIN_DAMAGE = 5;
/** Blocks from the eye to the ground at which the pour is made: the bucket reaches 4.5. */
export const CLUTCH_REACH = 4.2;
const EYE_HEIGHT = 1.62;
const LOOK_DOWN = 70;
const GAP_MS = 6000;
const POLLS = 400;
const POLL_MS = 10;
const SCOOP_TRIES = 3;
const SIDES: ReadonlyArray<readonly [number, number]> = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];

interface BodyEntity { position: Vec3; velocity?: Vec3; yaw?: number; pitch?: number; onGround?: boolean; isInWater?: boolean }
type Item = { name: string; type?: number; slot?: number };
export interface FallBody {
  entity?: BodyEntity;
  health?: number;
  game?: { dimension?: string };
  heldItem?: Item | null;
  inventory?: { items(): Item[] };
  look?(yaw: number, pitch: number, force?: boolean): unknown;
  equip?(item: Item, destination: string): Promise<void>;
  activateItem?(offHand?: boolean): void;
  deactivateItem?(): void;
  blockAt?(position: Vec3): { name?: string; metadata?: number } | null;
  _client?: { write: (...args: any[]) => unknown };
}
/** What the floor remembers of a fall: the highest y since the body last stood, and when the clutch last began. */
export interface FallMemory { from?: number; clutchAt?: number }

/** The ground under (x, y, z) as the top of its first solid block, how far under the feet that is, and what the fall would end in. */
export function groundUnder(read: BlockReader, at: { x: number; y: number; z: number }): { top: number; drop: number; kind: 'floor' | 'water' | 'lava' | 'void' | 'unknown' } {
  const cellY = Math.floor(at.y + 1e-3);
  const under = dropUnder(read, Math.floor(at.x), cellY, Math.floor(at.z), LOOK_DOWN);
  const kind = under.unknown ? 'unknown' : under.lava ? 'lava' : under.water ? 'water' : under.bottomless ? 'void' : 'floor';
  return { top: cellY - under.drop, drop: under.drop, kind };
}

/**
 * Whether the clutch starts at this physics tick, and why. Keeps `memory.from` (the highest y since the body last stood) to know how far the body has already fallen: the damage is the whole fall less three.
 */
export function clutchWanted(bot: FallBody, memory: FallMemory, now: number): string | null {
  const body = bot.entity;
  if (!body || !isEnd(bot)) return null;
  const y = body.position.y;
  if (body.onGround || body.isInWater) { memory.from = y; return null; }
  memory.from = Math.max(memory.from ?? y, y);
  if ((body.velocity?.y ?? 0) > CLUTCH_FALLING_VY) return null;
  if (memory.clutchAt !== undefined && now - memory.clutchAt < GAP_MS) return null;
  if ((bot.health ?? 20) <= 0 || !bot.inventory?.items().some(item => item.name === 'water_bucket')) return null;
  const ground = groundUnder(bodyReader(bot as never), body.position);
  if (ground.kind !== 'floor') return null;
  const total = (memory.from - y) + ground.drop;
  const damage = total - 3;
  return damage >= CLUTCH_MIN_DAMAGE ? `落ちて${total.toFixed(0)}ブロック（地面まであと${ground.drop}、受ける被害およそ${damage.toFixed(0)}）` : null;
}

/** The bucket used along the look, now: the packet carries the body's rotation (activateItemFacing says why), and nothing waits for a look to settle. */
function pourNow(bot: FallBody): void {
  const client = bot._client, entity = bot.entity;
  if (!client || !entity || !bot.activateItem) return;
  const original = client.write;
  client.write = function (this: unknown, name: string, data: any, ...rest: any[]) {
    if (name === 'use_item' && data?.rotation) {
      data = { ...data, rotation: { x: (180 / Math.PI) * (Math.PI - (entity.yaw ?? 0)), y: (180 / Math.PI) * -(entity.pitch ?? 0) } };
    }
    return (original as any).call(this, name, data, ...rest);
  } as typeof client.write;
  try { bot.activateItem(false); } finally { client.write = original; }
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const lostOwnership = (error: unknown) => /Action interrupted|Motor owner expired/u.test(String((error as Error)?.message ?? error));

/**
 * The clutch: the bucket in the hand, the look straight down, the pour in the tick the ground comes within reach, and the water taken up again once the body stands (a water source left on the island is
 * harmless, but the bucket is wanted for the next fall). Returns what happened, in words the ledger can carry.
 */
export async function runFallClutch(bot: FallBody, port: FallBody): Promise<{ success: boolean; result: string }> {
  const bucket = bot.inventory?.items().find(item => item.name === 'water_bucket');
  if (!bucket || !bot.entity) return { success: false, result: '水の入ったバケツを持っていない' };
  try {
    if (bot.heldItem?.name !== 'water_bucket') await port.equip?.(bucket, 'hand');
    port.look?.(bot.entity.yaw ?? 0, -Math.PI / 2, true);
  } catch (error) {
    if (lostOwnership(error)) throw error;
    return { success: false, result: `バケツを手に持てなかった（${String((error as Error)?.message ?? error).slice(0, 40)}）` };
  }
  const read = bodyReader(bot as never);
  let poured = false;
  for (let poll = 0; poll < POLLS && !poured; poll++) {
    const body = bot.entity;
    if (!body || body.onGround || body.isInWater) break;
    const ground = groundUnder(read, body.position);
    if (ground.kind === 'floor' && body.position.y + EYE_HEIGHT - ground.top <= CLUTCH_REACH) { pourNow(bot); poured = true; break; }
    if (ground.kind === 'water') return { success: true, result: '落ちる先が水だった' };
    await pause(POLL_MS);
  }
  if (!poured) return { success: false, result: bot.entity?.onGround ? '水をあける前に着地した' : '地面が届く所へ来る前に落下が終わった' };
  for (let waited = 0; waited < 1500 && bot.entity && !bot.entity.onGround && !bot.entity.isInWater; waited += 25) await pause(25);
  await pause(150);
  const feet = new Vec3(Math.floor(bot.entity!.position.x), Math.floor(bot.entity!.position.y + 1e-3), Math.floor(bot.entity!.position.z));
  const waterAt = (cell: Vec3) => { try { return bot.blockAt?.(cell)?.name === 'water'; } catch { return false; } };
  const wet = bot.entity!.isInWater === true || waterAt(feet);
  // The water is taken up again: the source the bucket made lies in the cell over the ground it was poured on.
  let scooped = false;
  if (wet) {
    for (let attempt = 0; attempt < SCOOP_TRIES && !scooped; attempt++) {
      const now = bot.entity!.position;
      const base = new Vec3(Math.floor(now.x), Math.floor(now.y + 1e-3), Math.floor(now.z));
      const source = SIDES.map(([dx, dz]) => base.offset(dx, 0, dz)).find(cell => { try { const block = bot.blockAt?.(cell); return block?.name === 'water' && Number(block.metadata ?? 0) === 0; } catch { return false; } });
      if (!source) break;
      try {
        await activateItemFacing(bot as never, source.offset(0.5, 0.4, 0.5));
        bot.deactivateItem?.();
        for (let waited = 0; waited < 600 && bot.heldItem?.name !== 'water_bucket'; waited += 50) await pause(50);
      } catch (error) { if (lostOwnership(error)) throw error; }
      scooped = bot.heldItem?.name === 'water_bucket';
    }
  }
  return { success: wet, result: wet ? `水を地面にあけて落下を止めた${scooped ? '（水は汲み直した）' : '（水は残した）'}` : '水をあけたが、水の中に着地できなかった' };
}
