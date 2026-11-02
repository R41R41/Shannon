import { Vec3 } from 'vec3';
import { bodyReader, type BlockReader } from './localMap.js';
import { dropUnder } from './voidFooting.js';
import { isEnd } from './dragonState.js';
import { activateItemFacing } from './activateItemFacing.js';
import { actionSignal } from '../execution/ActionExecution.js';

/**
 * A fall that would cripple or kill, stopped with a bucket of water (the clutch every player knows). In the End a body that climbed a pillar for a caged crystal is up to 40 blocks over the ground, and
 * the dragon's wings push what is near: a fall of 30 blocks is 27 points of damage, and armour does not take any of it. Water laid on the ground under the body as it comes down takes the fall.
 *
 * The bucket reaches 4.5 blocks from the eye (4.2 is used). Up to a fall of about 80 blocks the body is slower than the 2.58 blocks that lie between the reach and the ground, so there is always a physics tick with the ground inside
 * the reach and the body not yet on it (checked tick by tick for falls of 10 to 120 blocks: no miss up to 80), and the pour is made in that tick (the use packet follows the position packet of the same tick). Only in the End, only with a bucket of water carried, only where the ground under the body is a
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

/**
 * The bucket used along the look, now: the packet carries the body's rotation (activateItemFacing says why), and nothing waits for a look to settle. Through the motor `port`: a body whose owner has
 * been taken (a stronger reflex holds it) sends nothing, the port throws there (independent review 2026-11-02, round 5: after the interruption the pour still went out through the bare bot).
 */
function pourNow(port: FallBody): void {
  const client = port._client, entity = port.entity;
  if (!client || !entity || !port.activateItem) return;
  const original = client.write;
  client.write = function (this: unknown, name: string, data: any, ...rest: any[]) {
    if (name === 'use_item' && data?.rotation) {
      data = { ...data, rotation: { x: (180 / Math.PI) * (Math.PI - (entity.yaw ?? 0)), y: (180 / Math.PI) * -(entity.pitch ?? 0) } };
    }
    return (original as any).call(this, name, data, ...rest);
  } as typeof client.write;
  try { port.activateItem(false); } finally { client.write = original; }
}

/** A pause that ends at once when the action that holds the body is taken from it (the wall escape, the lava escape ...): the clutch lets go of the body in that tick, not a poll later. */
function abortableDelay(port: object, ms: number): Promise<void> {
  return new Promise(resolve => {
    const signal = actionSignal(port);
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}
const interrupted = (port: object) => actionSignal(port)?.aborted === true;
const lostOwnership = (error: unknown) => /Action interrupted|Motor owner expired/u.test(String((error as Error)?.message ?? error));
const TAKEN: { success: boolean; result: string } = { success: false, result: '強い反射に操作を取られて中断した' };

/**
 * The clutch: the bucket in the hand, the look straight down, the pour in the tick the ground comes within reach, and the water taken up again once the body stands (a water source left on the island is
 * harmless, but the bucket is wanted for the next fall). Returns what happened, in words the ledger can carry. Everything that acts on the body goes through `port`, and every wait ends when the action is taken.
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
    if (interrupted(port)) return TAKEN;
    const body = bot.entity;
    if (!body || body.onGround || body.isInWater) break;
    const ground = groundUnder(read, body.position);
    if (ground.kind === 'floor' && body.position.y + EYE_HEIGHT - ground.top <= CLUTCH_REACH) { pourNow(port); poured = true; break; }
    if (ground.kind === 'water') return { success: true, result: '落ちる先が水だった' };
    await abortableDelay(port, POLL_MS);
  }
  if (!poured) return interrupted(port) ? TAKEN : { success: false, result: bot.entity?.onGround ? '水をあける前に着地した' : '地面が届く所へ来る前に落下が終わった' };
  for (let waited = 0; waited < 1500 && bot.entity && !bot.entity.onGround && !bot.entity.isInWater && !interrupted(port); waited += 25) await abortableDelay(port, 25);
  if (!interrupted(port)) await abortableDelay(port, 150);
  if (interrupted(port)) return TAKEN;
  const feet = new Vec3(Math.floor(bot.entity!.position.x), Math.floor(bot.entity!.position.y + 1e-3), Math.floor(bot.entity!.position.z));
  const waterAt = (cell: Vec3) => { try { return bot.blockAt?.(cell)?.name === 'water'; } catch { return false; } };
  const wet = bot.entity!.isInWater === true || waterAt(feet);
  // The water is taken up again: the source the bucket made lies in the cell over the ground it was poured on.
  let scooped = false;
  if (wet) {
    for (let attempt = 0; attempt < SCOOP_TRIES && !scooped && !interrupted(port); attempt++) {
      const now = bot.entity!.position;
      const base = new Vec3(Math.floor(now.x), Math.floor(now.y + 1e-3), Math.floor(now.z));
      const source = SIDES.map(([dx, dz]) => base.offset(dx, 0, dz)).find(cell => { try { const block = bot.blockAt?.(cell); return block?.name === 'water' && Number(block.metadata ?? 0) === 0; } catch { return false; } });
      if (!source) break;
      try {
        await activateItemFacing(port as never, source.offset(0.5, 0.4, 0.5));
        port.deactivateItem?.();
        for (let waited = 0; waited < 600 && bot.heldItem?.name !== 'water_bucket' && !interrupted(port); waited += 50) await abortableDelay(port, 50);
      } catch (error) { if (lostOwnership(error)) throw error; }
      scooped = bot.heldItem?.name === 'water_bucket';
    }
  }
  return { success: wet, result: wet ? `水を地面にあけて落下を止めた${scooped ? '（水は汲み直した）' : interrupted(port) ? '（水は残した：途中で操作を取られた）' : '（水は残した）'}` : '水をあけたが、水の中に着地できなかった' };
}
