import { Vec3 } from 'vec3';
import { bodyReader, type BlockReader } from './localMap.js';
import { dropUnder } from './voidFooting.js';
import { isEnd } from './dragonState.js';
import { actionSignal, assertActionActive, bindActionCallback } from '../execution/ActionExecution.js';

/**
 * A fall that would cripple or kill, stopped with a bucket of water (the clutch every player knows). In the End a body that climbed a pillar for a caged crystal is up to 40 blocks over the ground, and
 * the dragon's wings push what is near: a fall of 30 blocks is 27 points of damage, and armour does not take any of it. Water laid on the ground under the body as it comes down takes the fall.
 *
 * The bucket reaches 4.5 blocks from the eye (4.4 including the horizontal aim is used). The pour is decided synchronously on physicsTick, with one movement's lead: vyNext = (vy - 0.08) * 0.98.
 * The old wall-clock poll and current-eye-only 4.2 test missed r214: eye distances 5.8668, 4.5025, then grounded. The centre column's surface was 64 but the body's 0.6-wide footprint landed at 65.
 * There is no guaranteed airborne in-reach sample at high speed. The one-movement lead assumes the server resolves use at the predicted position; the local physics event precedes updatePosition, so this
 * assumption needs packet/server validation in S1 (see docs/minecraft-end-fight.md). Only in the End, only with a bucket of water
 * in the inventory, only where a short forecast sees a solid floor (not water, lava, the void or what is not loaded) and the fall would cost at least CLUTCH_MIN_DAMAGE.
 *
 * A hotbar bucket is selected in one packet. A pack bucket needs up to three ticks of preparation before the pour window: `port.equip` moves it to an empty hotbar slot, or swaps with the hotbar's LRU slot.
 * Native equip continues across awaits with the bare bot: its inventory/selection packets are fenced separately until it settles, including after interruption (round 6's two late window clicks).
 * The water poured is taken up again afterwards. A clutch cut off between the pour and the taking-up leaves a note in the floor's memory (`FallMemory.scoop`: the cell of the water), and the floor takes the
 * water up later, in a quiet moment, with a new hold on the body (`scoopWanted`, `scoopBack`): a water source and an empty bucket left behind would end the clutch for the next fall.
 *
 * Independent review 2026-11-02, round 8, of the taking-up: (1) the water is taken only where the body would stand without it (`standsDry`: the first thing under its feet that is not air is a solid floor, at most
 * SCOOP_SAFE_DROP cells down), asked when the floor decides and again just before the use: a body held up by a waterfall over a drop would be dropped; (2) the hand is given back: the clutch and the taking-up take the
 * bucket into the hand, and an attack at the dragon strikes with whatever the hand holds, so a body that ends with the bucket in its hand hits the dragon with it: both go back to the slot the hand was on when they
 * end with the body still their own (not when cut off: what the stronger reflex chose stays); (3) only the water the note names is taken: a source nearby that is not that one is not a substitute.
 *
 * Independent review 2026-11-03, round 10, leaning to the side of not taking and not giving back: (1) `standsDry` asks for a full cube under the middle of the body (its collision shape, not the walk's floor class:
 * an end rod or a ladder is no floor to take the water from); (2) the hand is given back by the item the note names, not by the slot number alone (the sword may have moved, and a slot may hold something else now); a body that
 * is dead or gone gets nothing; (3) the use is made only when the first source of water along the look is the one the note names (a source in the body's own cell is hit first), and the note is dropped only when that
 * source is really gone, not because the bucket came back full.
 */
export const CLUTCH_FALLING_VY = -0.75;
export const CLUTCH_MIN_DAMAGE = 5;
/** Euclidean eye-to-face distance predicted for use: 0.1m short of the bucket's 4.5m ray, allowing rounding and an off-centre aim. */
export const CLUTCH_REACH = 4.4;
const EYE_HEIGHT = 1.62;
const LOOK_DOWN = 70;
const GAP_MS = 6000;
const CLUTCH_TICKS = 160;
const CLUTCH_WAIT_MS = 8000;
const EQUIP_TICKS = 3;
const EQUIP_WAIT_MS = EQUIP_TICKS * 50;
const SCOOP_TRIES = 3;
/** A note of water left behind is kept this long, tried this many times (one try per SCOOP_GAP_MS at the most), and only while the body is within SCOOP_NEAR blocks of the water. */
export const SCOOP_PENDING_MS = 90_000;
export const SCOOP_PENDING_TRIES = 3;
export const SCOOP_GAP_MS = 2000;
export const SCOOP_NEAR = 4;
export const SCOOP_BUCKET_WAIT_MS = 3000;
/** Cells of air between the feet and the floor with which the body still counts as standing without the water (a fall of three blocks costs nothing; one is kept for the feet's fraction and a body that is moving). */
export const SCOOP_SAFE_DROP = 1;
/** The slots of the hotbar in the player's window. */
const HOTBAR_FIRST = 36, HOTBAR_LAST = 44;

interface BodyEntity { position: Vec3; velocity?: Vec3; yaw?: number; pitch?: number; onGround?: boolean; isInWater?: boolean; eyeHeight?: number; width?: number }
type Item = { name: string; type?: number; slot?: number };
export interface FallBody {
  entity?: BodyEntity;
  health?: number;
  game?: { dimension?: string };
  heldItem?: Item | null;
  /** The hotbar slot (0 to 8) the hand is on; null until the server has told it. */
  quickBarSlot?: number | null;
  inventory?: { items(): Item[] };
  look?(yaw: number, pitch: number, force?: boolean): unknown;
  lookAt?(target: Vec3, force?: boolean): unknown;
  setQuickBarSlot?(slot: number): void;
  equip?(item: Item, destination: 'hand'): Promise<void>;
  activateItem?(offHand?: boolean): void;
  deactivateItem?(): void;
  blockAt?(position: Vec3): { name?: string; metadata?: number; shapes?: unknown } | null;
  on?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
  _client?: { write: (...args: any[]) => unknown };
}
/**
 * Water poured and not yet taken up: the cell of the source (over the ground it was poured on), when it was poured, the floor's tries since, when the last one began, and the hotbar slot the hand was on
 * before the clutch took the bucket (to be given back; absent when the bucket was in the hand already).
 */
export interface PendingScoop { x: number; y: number; z: number; at: number; tries: number; lastAt?: number; hand?: number; handName?: string }
/** What the floor remembers of a fall: the highest y since the body last stood, when the clutch last began, and the water poured and not yet taken up. */
export interface FallMemory { from?: number; clutchAt?: number; scoop?: PendingScoop }
type Outcome = { success: boolean; result: string };

/** The ground under (x, y, z) as the top of its first solid block, how far under the feet that is, and what the fall would end in. */
export function groundUnder(read: BlockReader, at: { x: number; y: number; z: number }): { top: number; drop: number; kind: 'floor' | 'water' | 'lava' | 'void' | 'unknown' } {
  const cellY = Math.floor(at.y + 1e-3);
  const under = dropUnder(read, Math.floor(at.x), cellY, Math.floor(at.z), LOOK_DOWN);
  const kind = under.unknown ? 'unknown' : under.lava ? 'lava' : under.water ? 'water' : under.bottomless ? 'void' : 'floor';
  return { top: cellY - under.drop, drop: under.drop, kind };
}

/**
 * Where the item `name` is that can be used at once: in the hand (`held`), or in a slot of the hotbar (`slot` 0 to 8: selecting it is one packet). Null for a pack slot or none: moving a stack is clicks.
 */
function inHand(bot: FallBody, name: string): { held: boolean; slot: number } | null {
  if (bot.heldItem?.name === name) return { held: true, slot: -1 };
  const item = bot.inventory?.items().find(entry => entry.name === name && typeof entry.slot === 'number' && entry.slot >= HOTBAR_FIRST && entry.slot <= HOTBAR_LAST);
  return item ? { held: false, slot: (item.slot as number) - HOTBAR_FIRST } : null;
}

type WaterBucket = { held: boolean; slot: number; item?: Item };
/** Prefer the immediate hand/hotbar path; only a pack bucket needs native equip. Scoop-back keeps its immediate-only contract. */
function waterBucket(bot: FallBody): WaterBucket | null {
  const immediate = inHand(bot, 'water_bucket');
  if (immediate) return immediate;
  const item = bot.inventory?.items().find(entry => entry.name === 'water_bucket' && Number.isInteger(entry.slot));
  return item ? { held: false, slot: -1, item } : null;
}

/** Leave three movements for equip and one for the next-position pour decision. A late pack swap never starts. */
function timeToEquip(body: BodyEntity, floor: number): boolean {
  if (!body.velocity || body.velocity.y > CLUTCH_FALLING_VY) return false;
  let y = body.position.y, vy = body.velocity.y;
  for (let tick = 0; tick <= EQUIP_TICKS; tick++) { vy = (vy - 0.08) * 0.98; y += vy; }
  return y > floor && y + (body.eyeHeight ?? EYE_HEIGHT) - floor > CLUTCH_REACH;
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
  const have = waterBucket(bot);
  if ((bot.health ?? 20) <= 0 || !have) return null;
  if (have.item && (!bot.equip || !bot._client || !bot.on || !bot.removeListener)) return null;
  const support = forecastSupports(bot, bodyReader(bot as never), body).pop();
  if (!support || (have.item && !timeToEquip(body, support.source.y))) return null;
  const drop = Math.max(0, y - support.source.y);
  const total = memory.from - support.source.y;
  const damage = total - 3;
  return damage >= CLUTCH_MIN_DAMAGE ? `落ちて${total.toFixed(0)}ブロック（地面まであと${drop.toFixed(0)}、受ける被害およそ${damage.toFixed(0)}）` : null;
}

/**
 * The bucket used along the look, now: the packet carries the body's rotation (activateItemFacing says why), and nothing waits for a look to settle. Through the motor `port`: a body whose owner has
 * been taken (a stronger reflex holds it) sends nothing, the port throws there (independent review 2026-11-02, round 5: after the interruption the pour still went out through the bare bot).
 */
function pourNow(port: FallBody, facing?: { yaw: number; pitch: number }): void {
  const client = port._client, entity = port.entity;
  if (!client || !entity || !port.activateItem) return;
  const original = client.write;
  client.write = function (this: unknown, name: string, data: any, ...rest: any[]) {
    if (name === 'use_item' && data?.rotation) {
      data = { ...data, rotation: { x: (180 / Math.PI) * (Math.PI - (facing?.yaw ?? entity.yaw ?? 0)), y: (180 / Math.PI) * -(facing?.pitch ?? entity.pitch ?? 0) } };
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
const TAKEN: Outcome = { success: false, result: '強い反射に操作を取られて中断した' };
const CUT_AFTER_POUR: Outcome = { success: false, result: '強い反射に操作を取られて中断した（水はあけた：あとで汲み直す）' };

const isSource = (bot: FallBody, cell: Vec3): boolean => {
  try { const block = bot.blockAt?.(cell); return block?.name === 'water' && Number(block.metadata ?? 0) === 0; } catch { return false; }
};
const isWater = (bot: FallBody, cell: Vec3): boolean => { try { return bot.blockAt?.(cell)?.name === 'water'; } catch { return false; } };

/**
 * Whether the body would stand, with the water near it gone: under its feet the first cell that is not air is a solid floor (not water, lava, the void or what is not loaded), at most SCOOP_SAFE_DROP cells
 * down. A body held up by water (swimming in a waterfall, over a drop) does not: taking the source away would drop it (independent review 2026-11-02, round 8).
 */
function standsDry(bot: FallBody): boolean {
  const at = bot.entity?.position;
  if (!at) return false;
  try {
    const ground = groundUnder(bodyReader(bot as never), at);
    if (ground.kind !== 'floor' || ground.drop > SCOOP_SAFE_DROP) return false;
    // The walk's floor class counts a ladder or an end rod as a floor; what holds the body is a full cube under the middle of its feet (a body half over an edge is not asked: not taking the water is the safe side).
    return fullCube(bot, new Vec3(Math.floor(at.x), Math.floor(at.y + 1e-3) - 1 - ground.drop, Math.floor(at.z)));
  } catch { return false; }
}

/** Whether the block in the cell has one collision box that fills the whole cell. No shape known: no. */
function fullCube(bot: FallBody, cell: Vec3): boolean {
  try {
    const shapes = bot.blockAt?.(cell)?.shapes;
    return Array.isArray(shapes) && shapes.some(box => Array.isArray(box) && box.length >= 6 && box[0] <= 0.001 && box[1] <= 0.001 && box[2] <= 0.001 && box[3] >= 0.999 && box[4] >= 0.999 && box[5] >= 0.999);
  } catch { return false; }
}

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
/**
 * Whether a use of the bucket along the look, from the eye to the water's middle, takes the source of the note and no other: walking the look, the first source of water (the bucket takes only sources) or the first thing that
 * is neither air nor water must be that cell. A source in the cell of the body itself is hit first (round 10); a cell that is not loaded stops the look.
 */
function firstSourceIsOurs(bot: FallBody, source: Vec3): boolean {
  const eye = bot.entity?.position;
  if (!eye) return false;
  const from = new Vec3(eye.x, eye.y + EYE_HEIGHT, eye.z), to = source.offset(0.5, 0.4, 0.5);
  const length = from.distanceTo(to), steps = Math.max(1, Math.ceil(length / 0.05));
  let last = '';
  for (let i = 0; i <= steps; i++) {
    const p = from.plus(to.minus(from).scaled(i / steps));
    const cell = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    const id = `${cell.x},${cell.y},${cell.z}`;
    if (id === last) continue;
    last = id;
    if (cell.x === source.x && cell.y === source.y && cell.z === source.z) return isSource(bot, cell);
    let block: { name?: string } | null | undefined;
    try { block = bot.blockAt?.(cell); } catch { return false; }
    if (!block?.name) return false;
    if (AIR_NAMES.has(block.name)) continue;
    if (block.name === 'water') { if (isSource(bot, cell)) return false; continue; }
    return false;
  }
  return false;
}

/** A hand to give back: the hotbar slot it was on and the item it held (round 10: a slot number alone may hold something else by then). */
interface HandBack { slot: number; name?: string }

/**
 * The hand back to the item it held, when the body is still the caller's own: not when it was cut off or lost (whoever took it chose the hand), not when the body is dead or gone, and not when the item is nowhere in
 * the hotbar (no guess by the slot number). The slot it was on if it is still there, else the slot it is in now.
 */
function giveBackHand(bot: FallBody, port: FallBody, hand: HandBack | undefined): void {
  if (!hand || interrupted(port) || !bot.entity || (bot.health ?? 20) <= 0) return;
  let slot = hand.slot;
  if (hand.name !== undefined) {
    const at = (candidate: number) => bot.inventory?.items().find(entry => entry.slot === HOTBAR_FIRST + candidate)?.name === hand.name;
    if (!at(slot)) {
      const found = bot.inventory?.items().find(entry => entry.name === hand.name && typeof entry.slot === 'number' && entry.slot >= HOTBAR_FIRST && entry.slot <= HOTBAR_LAST);
      if (!found) return;
      slot = (found.slot as number) - HOTBAR_FIRST;
    }
  }
  if (bot.quickBarSlot === slot) return;
  try { port.setQuickBarSlot?.(slot); } catch { /* the body is no longer ours */ }
}

/** The cell of the water that was poured, when it is a source now: the one the note names and no other (a source nearby that is not that one is no substitute). */
const sourceOf = (bot: FallBody, pending: PendingScoop): Vec3 | null => {
  const cell = new Vec3(pending.x, pending.y, pending.z);
  return isSource(bot, cell) ? cell : null;
};

/** The attempts of the taking-up (`scoopBack` gives the hand back after them). */
async function takeUp(bot: FallBody, port: FallBody, memory: FallMemory, pending: PendingScoop): Promise<Outcome & { scooped: boolean }> {
  for (let attempt = 0; attempt < SCOOP_TRIES; attempt++) {
    if (interrupted(port)) return { ...TAKEN, scooped: false };
    if ((bot.health ?? 20) <= 0) { delete memory.scoop; return { success: false, result: '体が倒れていて汲み直せない', scooped: false }; }
    const source = sourceOf(bot, pending);
    if (!source) { delete memory.scoop; return { success: true, result: '汲み直す水の源がもう無い', scooped: false }; }
    // The water may be what holds the body up: the source is taken only where the body would stand without it (the note stays for a later try).
    if (!standsDry(bot)) return { success: false, result: '水を抜くと足場が無い（水に支えられている）ので汲み直さない', scooped: false };
    try {
      if (bot.heldItem?.name !== 'bucket') {
        const empty = inHand(bot, 'bucket');
        if (!empty) { delete memory.scoop; return { success: false, result: '空のバケツが手にも hotbar にも無く、水は残した', scooped: false }; }
        port.setQuickBarSlot?.(empty.slot);
      }
      await port.lookAt?.(source.offset(0.5, 0.4, 0.5), true);
      if (interrupted(port)) return { ...TAKEN, scooped: false };
      // Asked again just before the use: the body and the water are not where they were a look ago.
      if (!standsDry(bot) || !isSource(bot, source)) return { success: false, result: '汲む直前に足場か水が変わったので汲み直さない', scooped: false };
      // The first source along the look is the one used: another one in the body's own cell would be taken instead of the note's. Not used then, and the note is dropped (once).
      if (!firstSourceIsOurs(bot, source)) { delete memory.scoop; return { success: false, result: '照準の先で最初の水の源が記録の水ではないので汲まない（メモは捨てた）', scooped: false }; }
      pourNow(port);
      port.deactivateItem?.();
      for (let waited = 0; waited < 600 && bot.heldItem?.name !== 'water_bucket' && !interrupted(port); waited += 50) await abortableDelay(port, 50);
    } catch (error) { if (lostOwnership(error)) throw error; }
    if (bot.heldItem?.name === 'water_bucket') {
      // A full bucket is not yet the note's water gone: the server's word that the source went follows the item's by a tick or two.
      for (let waited = 0; waited < 500 && isSource(bot, source) && !interrupted(port); waited += 25) await abortableDelay(port, 25);
      if (interrupted(port)) return { ...TAKEN, scooped: false };
      delete memory.scoop;
      return isSource(bot, source)
        ? { success: false, result: '満水になったが記録の水の源は残っている（別の水を汲んだ：メモは捨てた）', scooped: true }
        : { success: true, result: '水を汲み直した', scooped: true };
    }
  }
  return { success: false, result: '水を汲み直せなかった', scooped: false };
}

/**
 * The water poured is taken up again: the empty bucket in the hand (its hotbar slot selected, one packet), the look at the source, the use. Through `port`, every wait ending when the action is taken. A
 * taking-up that is cut off, or that does not take, leaves the note in `memory.scoop` for the floor to finish later; a note that can no longer be kept (no source left, no empty bucket to use, the body dead) is dropped.
 * Ended with the body still its own, the hand goes back (`giveBackHand`): to the hand it was found on, or, when the empty bucket is in it (what a clutch that was cut off left there), to the hand the clutch took the
 * bucket from (`pending.hand`).
 */
export async function scoopBack(bot: FallBody, port: FallBody, memory: FallMemory): Promise<Outcome & { scooped: boolean }> {
  const pending = memory.scoop;
  if (!pending) return { success: true, result: '汲み直す水は無い', scooped: false };
  const found: HandBack | undefined = typeof bot.quickBarSlot === 'number' ? { slot: bot.quickBarSlot, ...(bot.heldItem?.name ? { name: bot.heldItem.name } : {}) } : undefined;
  const giveBack = bot.heldItem?.name === 'bucket' && pending.hand !== undefined ? { slot: pending.hand, ...(pending.handName !== undefined ? { name: pending.handName } : {}) } : found;
  const done = await takeUp(bot, port, memory, pending);
  giveBackHand(bot, port, giveBack);
  return done;
}

/**
 * Whether the floor takes up the water of a clutch that was cut off, now: the body stands (or swims) where it would stand without the water (`standsDry`), within SCOOP_NEAR blocks of the water, not tried
 * within SCOOP_GAP_MS, and an empty bucket is in the hand or the hotbar. A note that is too old, tried too often, or whose empty bucket is no longer to be had is dropped here.
 */
export function scoopWanted(bot: FallBody, memory: FallMemory, now: number): boolean {
  const pending = memory.scoop, body = bot.entity;
  if (!pending || !body) return false;
  if (now - pending.at > SCOOP_PENDING_MS || pending.tries >= SCOOP_PENDING_TRIES) { delete memory.scoop; return false; }
  if (!inHand(bot, 'bucket')) {
    // The server's word that the bucket is empty is on its way for a moment after the pour: the note is not dropped for want of the empty bucket before then.
    if (now - pending.at > SCOOP_BUCKET_WAIT_MS) delete memory.scoop;
    return false;
  }
  if ((bot.health ?? 20) <= 0 || !(body.onGround || body.isInWater) || !standsDry(bot)) return false;
  if (pending.lastAt !== undefined && now - pending.lastAt < SCOOP_GAP_MS) return false;
  return Math.hypot(body.position.x - (pending.x + 0.5), body.position.y - pending.y, body.position.z - (pending.z + 0.5)) <= SCOOP_NEAR;
}

type PourTarget = { source: Vec3; yaw: number; pitch: number };

type ForecastSupport = { source: Vec3; feet: Vec3 };
/** Shared by start and pour: next 1..8 footprints, stopping at the first collision. Still a bounded 70-cell column read, not proof of a bottomless world. */
function forecastSupports(bot: FallBody, read: BlockReader, body: BodyEntity): ForecastSupport[] {
  const v = body.velocity;
  if (!v || ![v.x, v.y, v.z].every(Number.isFinite) || v.y > CLUTCH_FALLING_VY) return [];
  const half = (body.width ?? 0.6) / 2 - 1e-6, supports: ForecastSupport[] = [];
  const columns = new Map<string, Vec3 | null>();
  let predicted = body.position.clone(), vy = v.y;
  for (let tick = 0; tick < 8; tick++) {
    vy = (vy - 0.08) * 0.98;
    predicted = predicted.offset(v.x, vy, v.z);
    let support: Vec3 | null = null, nearest = Infinity;
    for (let x = Math.floor(predicted.x - half); x <= Math.floor(predicted.x + half); x++) {
      for (let z = Math.floor(predicted.z - half); z <= Math.floor(predicted.z + half); z++) {
        const key = `${x},${z}`;
        if (!columns.has(key)) {
          const ground = groundUnder(read, { x: x + 0.5, y: body.position.y, z: z + 0.5 });
          columns.set(key, ground.kind === 'floor' && fullCube(bot, new Vec3(x, ground.top - 1, z)) ? new Vec3(x, ground.top, z) : null);
        }
        const candidate = columns.get(key);
        if (!candidate) continue;
        const distance = Math.hypot(x + 0.5 - predicted.x, z + 0.5 - predicted.z);
        if (!support || candidate.y > support.y || (candidate.y === support.y && distance < nearest)) {
          support = candidate; nearest = distance;
        }
      }
    }
    if (support) {
      supports.push({ source: support, feet: predicted });
      if (predicted.y <= support.y) break;
    }
  }
  return supports;
}

/**
 * A short ballistic forecast, with the observed horizontal velocity held constant (no steering).
 * The first full-cube support across the landing footprint wins, including a higher adjacent cell.
 * groundUnder deliberately remains a centre-column reader: its top is blockY + 1, not blockY.
 * Water is aimed at the support's top-face centre, rather than the cell the body is leaving.
 */
function targetForPour(bot: FallBody, read: BlockReader, body: BodyEntity): PourTarget | null {
  const v = body.velocity;
  if (!v || ![v.x, v.y, v.z].every(Number.isFinite) || v.y > CLUTCH_FALLING_VY) return null;
  const eyeHeight = body.eyeHeight ?? EYE_HEIGHT;
  const useEye = body.position.offset(v.x, (v.y - 0.08) * 0.98 + eyeHeight, v.z);
  // At the pour window even a slow eligible fall lands within eight ticks. No distant trajectory is trusted.
  for (const { source: support, feet } of forecastSupports(bot, read, body)) {
    if (feet.y > support.y) continue;
    // The source must have room, and the eye must still be above the face at use time.
    if (!AIR_NAMES.has(read(support.x, support.y, support.z)?.name ?? '') || useEye.y <= support.y) return null;
    const aim = support.offset(0.5, 0, 0.5).minus(useEye);
    if (aim.norm() > CLUTCH_REACH) return null;
    // Reject a top face hidden by a nearer solid/unknown cell. Do not pour on a lower floor beside a raised rim.
    const length = aim.norm(), direction = aim.scaled(1 / length);
    for (let d = 0; d < length - 0.01; d += 0.1) {
      const at = useEye.plus(direction.scaled(d));
      const block = read(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z));
      if (!block || !AIR_NAMES.has(block.name)) return null;
    }
    return { source: support, yaw: Math.atan2(-aim.x, -aim.z), pitch: Math.atan2(aim.y, Math.hypot(aim.x, aim.z)) };
  }
  return null;
}

/** Every decision and the use itself run inside the physics event, even when many catch-up ticks share one JS turn. */
function pourOnTick(bot: FallBody, port: FallBody, memory: FallMemory, clock: () => number, before: HandBack | undefined): Promise<Outcome | null> {
  if (!bot.on || !bot.removeListener) return Promise.resolve({ success: false, result: '物理tickを監視できないため水をあけない' });
  const read = bodyReader(bot as never), signal = actionSignal(port);
  return new Promise((resolve, reject) => {
    let ticks = 0, done = false;
    const finish = (result: Outcome | null, error?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      bot.removeListener?.('physicsTick', onTick);
      bot.removeListener?.('end', ended);
      signal?.removeEventListener('abort', aborted);
      if (error !== undefined) reject(error); else resolve(result);
    };
    const ended = () => finish({ success: false, result: '水をあける前に落下が終わった' });
    const aborted = () => finish(TAKEN);
    const onTick = bindActionCallback(port, () => {
      try {
        if (signal?.aborted) { aborted(); return; }
        const body = bot.entity;
        if (!body || (bot.health ?? 20) <= 0 || body.onGround) { finish({ success: false, result: '水をあける前に着地した' }); return; }
        if (body.isInWater || groundUnder(read, body.position).kind === 'water') { finish({ success: true, result: '落ちる先が水だった' }); return; }
        const target = targetForPour(bot, read, body);
        if (target) {
          if (bot.heldItem?.name !== 'water_bucket') { finish({ success: false, result: '水をあける前に手のバケツが変わった' }); return; }
          memory.scoop = { x: target.source.x, y: target.source.y, z: target.source.z, at: clock(), tries: 0, ...(before !== undefined ? { hand: before.slot, ...(before.name !== undefined ? { handName: before.name } : {}) } : {}) };
          // No awaited look: in particular vy <= -2 can cross the entire window next tick.
          // The packet carries its own aim even if look has not updated entity.pitch/yaw yet.
          try { pourNow(port, target); } catch (error) { delete memory.scoop; throw error; }
          finish(null); return;
        }
        if (++ticks >= CLUTCH_TICKS) ended();
      } catch (error) { finish(null, error); }
    });
    // The timer only releases a stalled/disconnected body; it never decides to pour.
    const timer = setTimeout(ended, CLUTCH_WAIT_MS);
    bot.on?.('physicsTick', onTick);
    bot.on?.('end', ended);
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

type Client = NonNullable<FallBody['_client']>;
type EquipFence = { signal: AbortSignal | undefined; check(): void };
const equipFences = new WeakMap<Client, { original: Client['write']; write: Client['write']; guards: Set<EquipFence> }>();

/** Native equip/moveSlotItem retain the bare bot across awaits. Fence their packets in that action's async context; other owners and protocol replies pass through. */
function fenceEquip(bot: FallBody, port: FallBody, check: () => void): () => void {
  const client = port._client;
  if (!client) throw new Error('持ち替えの送信を監視できない');
  let entry = equipFences.get(client);
  if (!entry) {
    const original = client.write, guards = new Set<EquipFence>();
    const write: Client['write'] = function (this: unknown, name: string, ...args: any[]) {
      if (name === 'window_click' || name === 'held_item_slot') {
        for (const guard of guards) if (actionSignal(bot) === guard.signal) guard.check();
      }
      return original.call(this, name, ...args);
    };
    entry = { original, write, guards }; equipFences.set(client, entry); client.write = write;
  }
  const guard = { signal: actionSignal(port), check };
  entry.guards.add(guard);
  const saved = entry;
  return () => {
    saved.guards.delete(guard);
    if (saved.guards.size === 0) {
      if (client.write === saved.write) client.write = saved.original;
      equipFences.delete(client);
    }
  };
}

/** At most three ticks/150ms of preparation. A timed-out native promise may still settle later: its fence stays until then, but the action releases immediately. */
function equipWhileFalling(bot: FallBody, port: FallBody, item: Item): Promise<void> {
  if (!port.equip || !bot.on || !bot.removeListener) return Promise.reject(new Error('落下中に持ち替えを監視できない'));
  const signal = actionSignal(port);
  return new Promise((resolve, reject) => {
    let closed = false, ticks = 0;
    const check = () => {
      assertActionActive(port);
      if (closed || signal?.aborted) throw new Error('Motor owner expired');
      if (!bot.entity || (bot.health ?? 20) <= 0 || bot.entity.onGround || bot.entity.isInWater) throw new Error('持ち替え中に落下が終わった');
    };
    const finish = (error?: unknown) => {
      if (closed) return;
      closed = true; clearTimeout(timer);
      bot.removeListener?.('physicsTick', tick); bot.removeListener?.('end', ended);
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const ended = () => finish(new Error('持ち替え中に落下が終わった'));
    const aborted = () => finish(new Error('Motor owner expired'));
    const tick = bindActionCallback(port, () => {
      try { check(); if (++ticks > EQUIP_TICKS) finish(new Error('持ち替えが3 tickに間に合わなかった')); }
      catch (error) { finish(error); }
    });
    const timer = setTimeout(() => finish(new Error('持ち替えが150msに間に合わなかった')), EQUIP_WAIT_MS);
    bot.on?.('physicsTick', tick); bot.on?.('end', ended);
    signal?.addEventListener('abort', aborted, { once: true });
    let release: (() => void) | undefined;
    try {
      check();
      release = fenceEquip(bot, port, check);
      const pending = port.equip!(item, 'hand');
      void Promise.resolve(pending).then(() => {
        try { check(); finish(); } catch (error) { finish(error); }
        finally { release?.(); }
      }, error => { release?.(); finish(error); });
    } catch (error) { release?.(); finish(error); }
  });
}

/** The clutch itself (`runFallClutch` gives the hand back after it). */
async function clutch(bot: FallBody, port: FallBody, memory: FallMemory, clock: () => number, have: WaterBucket, before: HandBack | undefined): Promise<Outcome> {
  try {
    if (interrupted(port)) return TAKEN;
    if (have.item) {
      const support = bot.entity && forecastSupports(bot, bodyReader(bot as never), bot.entity).pop();
      if (!support || !bot.entity || !timeToEquip(bot.entity, support.source.y)) return { success: false, result: '持ち替えの3 tickを残していないので水バケツを動かさない' };
      await equipWhileFalling(bot, port, have.item);
      if (interrupted(port)) return TAKEN;
    } else if (!have.held) port.setQuickBarSlot?.(have.slot);
    if (bot.heldItem?.name !== 'water_bucket') return { success: false, result: 'バケツを手に持てなかった' };
    // A visual preparation only: the eventual use has its own rotation and waits for no look promise.
    void Promise.resolve(port.look?.(bot.entity?.yaw ?? 0, -Math.PI / 2, true)).catch(() => undefined);
  } catch (error) {
    if (lostOwnership(error)) throw error;
    return { success: false, result: `バケツを手に持てなかった（${String((error as Error)?.message ?? error).slice(0, 40)}）` };
  }
  const notPoured = await pourOnTick(bot, port, memory, clock, before);
  if (notPoured) return notPoured;
  for (let waited = 0; waited < 1500 && bot.entity && !bot.entity.onGround && !bot.entity.isInWater && !interrupted(port); waited += 25) await abortableDelay(port, 25);
  if (!interrupted(port)) await abortableDelay(port, 150);
  // The server's word that the bucket is empty (the slot update) comes some ticks after the pour.
  for (let waited = 0; waited < 500 && bot.heldItem?.name === 'water_bucket' && !interrupted(port); waited += 25) await abortableDelay(port, 25);
  if (interrupted(port)) return CUT_AFTER_POUR;
  const body = bot.entity;
  if (!body) { delete memory.scoop; return { success: false, result: '水をあけた後、体が無くなった' }; }
  const wet = body.isInWater === true || isWater(bot, new Vec3(Math.floor(body.position.x), Math.floor(body.position.y + 1e-3), Math.floor(body.position.z)));
  let tail: string;
  if (bot.heldItem?.name === 'water_bucket') { delete memory.scoop; tail = '（バケツは満たされたまま）'; }
  else {
    const back = await scoopBack(bot, port, memory);
    if (interrupted(port)) return CUT_AFTER_POUR;
    tail = back.scooped ? '（水は汲み直した）' : memory.scoop ? '（水は残した：あとで汲み直す）' : '（水は残した）';
  }
  return { success: wet, result: wet ? `水を地面にあけて落下を止めた${tail}` : `水をあけたが、水の中に着地できなかった${tail}` };
}

/**
 * The clutch: the bucket in the hand, a downward look prepared without waiting, the pour on the first physics tick whose next-position ray reaches the landing face, and water taken up again once the body stands (a water source left on the island is
 * harmless, but the bucket is wanted for the next fall). Returns what happened, in words the ledger can carry. Everything that acts on the body goes through `port`, and every wait ends when the action is taken.
 * The pour is noted in `memory.scoop` before it goes out and the note is dropped only when the water is taken up (or is not there to take): whatever cuts the clutch off after the pour leaves it for the floor.
 * The hand the bucket was taken from is given back when the clutch ends with the body still its own, and is in the note for a taking-up that comes later (`PendingScoop.hand`).
 */
export async function runFallClutch(bot: FallBody, port: FallBody, memory: FallMemory = {}, clock: () => number = Date.now): Promise<Outcome> {
  const have = waterBucket(bot);
  if (!have || !bot.entity) return { success: false, result: '水の入ったバケツをインベントリに持っていない' };
  const before: HandBack | undefined = !have.held && typeof bot.quickBarSlot === 'number' ? { slot: bot.quickBarSlot, ...(bot.heldItem?.name ? { name: bot.heldItem.name } : {}) } : undefined;
  const result = await clutch(bot, port, memory, clock, have, before);
  giveBackHand(bot, port, before);
  return result;
}
