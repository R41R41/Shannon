import { Vec3 } from 'vec3';
import { bodyReader, type BlockReader } from './localMap.js';
import { dropUnder } from './voidFooting.js';
import { isEnd } from './dragonState.js';
import { actionSignal } from '../execution/ActionExecution.js';

/**
 * A fall that would cripple or kill, stopped with a bucket of water (the clutch every player knows). In the End a body that climbed a pillar for a caged crystal is up to 40 blocks over the ground, and
 * the dragon's wings push what is near: a fall of 30 blocks is 27 points of damage, and armour does not take any of it. Water laid on the ground under the body as it comes down takes the fall.
 *
 * The bucket reaches 4.5 blocks from the eye (4.2 is used). Up to a fall of about 80 blocks the body is slower than the 2.58 blocks that lie between the reach and the ground, so there is always a physics tick with the ground inside
 * the reach and the body not yet on it (checked tick by tick for falls of 10 to 120 blocks: no miss up to 80), and the pour is made in that tick (the use packet follows the position packet of the same tick). Only in the End, only with a bucket of water
 * in the hand or in the hotbar, only where the ground under the body is a solid floor (not water, lava, the void or what is not loaded) and the fall would cost at least CLUTCH_MIN_DAMAGE.
 *
 * The bucket is taken into the hand by selecting its hotbar slot: one packet, nothing to wait for (the game's own `equip` does just that for an item in the hotbar). For an item in the pack `equip` moves the
 * stack with clicks of the window over several ticks that a stronger reflex taking the body cannot stop (independent review 2026-11-02, round 6: two window clicks after the interruption, the wall escape
 * late by half a second). So a bucket in the pack, not in the hotbar, does not start the clutch.
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
/** Blocks from the eye to the ground at which the pour is made: the bucket reaches 4.5. */
export const CLUTCH_REACH = 4.2;
const EYE_HEIGHT = 1.62;
const LOOK_DOWN = 70;
const GAP_MS = 6000;
const POLLS = 400;
const POLL_MS = 10;
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

interface BodyEntity { position: Vec3; velocity?: Vec3; yaw?: number; pitch?: number; onGround?: boolean; isInWater?: boolean }
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
  activateItem?(offHand?: boolean): void;
  deactivateItem?(): void;
  blockAt?(position: Vec3): { name?: string; metadata?: number; shapes?: unknown } | null;
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
  if ((bot.health ?? 20) <= 0 || !inHand(bot, 'water_bucket')) return null;
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

/** The clutch itself (`runFallClutch` gives the hand back after it). */
async function clutch(bot: FallBody, port: FallBody, memory: FallMemory, clock: () => number, have: { held: boolean; slot: number }, before: HandBack | undefined): Promise<Outcome> {
  try {
    if (!have.held) port.setQuickBarSlot?.(have.slot);
    if (bot.heldItem?.name !== 'water_bucket') return { success: false, result: 'バケツを手に持てなかった' };
    port.look?.(bot.entity?.yaw ?? 0, -Math.PI / 2, true);
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
    if (ground.kind === 'floor' && body.position.y + EYE_HEIGHT - ground.top <= CLUTCH_REACH) {
      memory.scoop = { x: Math.floor(body.position.x), y: ground.top, z: Math.floor(body.position.z), at: clock(), tries: 0, ...(before !== undefined ? { hand: before.slot, ...(before.name !== undefined ? { handName: before.name } : {}) } : {}) };
      try { pourNow(port); } catch (error) { delete memory.scoop; throw error; }
      poured = true; break;
    }
    if (ground.kind === 'water') return { success: true, result: '落ちる先が水だった' };
    await abortableDelay(port, POLL_MS);
  }
  if (!poured) return interrupted(port) ? TAKEN : { success: false, result: bot.entity?.onGround ? '水をあける前に着地した' : '地面が届く所へ来る前に落下が終わった' };
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
 * The clutch: the bucket in the hand, the look straight down, the pour in the tick the ground comes within reach, and the water taken up again once the body stands (a water source left on the island is
 * harmless, but the bucket is wanted for the next fall). Returns what happened, in words the ledger can carry. Everything that acts on the body goes through `port`, and every wait ends when the action is taken.
 * The pour is noted in `memory.scoop` before it goes out and the note is dropped only when the water is taken up (or is not there to take): whatever cuts the clutch off after the pour leaves it for the floor.
 * The hand the bucket was taken from is given back when the clutch ends with the body still its own, and is in the note for a taking-up that comes later (`PendingScoop.hand`).
 */
export async function runFallClutch(bot: FallBody, port: FallBody, memory: FallMemory = {}, clock: () => number = Date.now): Promise<Outcome> {
  const have = inHand(bot, 'water_bucket');
  if (!have || !bot.entity) return { success: false, result: '水の入ったバケツを手にも hotbar にも持っていない' };
  const before: HandBack | undefined = !have.held && typeof bot.quickBarSlot === 'number' ? { slot: bot.quickBarSlot, ...(bot.heldItem?.name ? { name: bot.heldItem.name } : {}) } : undefined;
  const result = await clutch(bot, port, memory, clock, have, before);
  giveBackHand(bot, port, before);
  return result;
}
