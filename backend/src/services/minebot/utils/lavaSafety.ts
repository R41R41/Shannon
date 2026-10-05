import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { executeAction, preemptLowerPriorityActions } from '../execution/ActionExecution.js';
import { activateItemFacing } from './activateItemFacing.js';
import { digRefusedAt, noteRefusedDig } from './refusedDigs.js';

const log = createLogger('Minebot:LavaSafety');

interface LavaWorld { blockAt(position: Vec3): any }
interface LavaBody extends LavaWorld { entity?: { position: Vec3; isInLava?: boolean } }

const isLava = (block: any) => !!block && block.name === 'lava';
const SIDES: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]];

/**
 * The lava that breaking the block at `target` would let onto the body, or
 * null. Lava runs down and sideways into a cell that opens beside or under
 * it. It reaches the body when that cell is at the level of the body's feet
 * or above (over its head, or in the wall of the tunnel it stands in), or
 * when the block is the one the body stands on and lava lies under or beside
 * it. A block broken below the feet's level and off to the side opens a cell
 * the lava stays in: taking obsidian from the rim of a lava pool stays
 * possible.
 */
export function lavaReleasedBy(body: LavaBody, target: Vec3): Vec3 | null {
  const position = body.entity?.position;
  if (!position) return null;
  const at = (dx: number, dy: number, dz: number) => {
    const cell = target.offset(dx, dy, dz);
    try { return isLava(body.blockAt(cell)) ? cell : null; } catch { return null; }
  };
  const feetY = Math.floor(position.y + 0.001);
  const underFeet = target.x === Math.floor(position.x) && target.z === Math.floor(position.z) && target.y === feetY - 1;
  const aboveOrBeside = at(0, 1, 0) ?? SIDES.reduce<Vec3 | null>((found, [dx, , dz]) => found ?? at(dx, 0, dz), null);
  if (underFeet) return aboveOrBeside ?? at(0, -1, 0);
  return target.y >= feetY ? aboveOrBeside : null;
}

/** A dig refused because it would bring lava onto the body. */
export class LavaReleaseError extends Error {
  readonly failureType = 'lava_adjacent';
  constructor(block: { name?: string; position: Vec3 }, readonly lava: Vec3) {
    super(`掘削中止: ${block.name ?? 'ブロック'}(${block.position.x}, ${block.position.y}, ${block.position.z})を掘ると、隣の溶岩(${lava.x}, ${lava.y}, ${lava.z})が身体のいる場所へ流れ込みます。`
      + '別の方向へ進むか、先に溶岩を丸石などで塞ぐか、水をかけて固めてください');
    this.name = 'LavaReleaseError';
  }
}

/** Throws when breaking `block` would bring lava onto the body. */
export function assertNoLavaRelease(body: LavaBody, block: { name?: string; position: Vec3 } | null | undefined): void {
  if (!block?.position) return;
  const lava = lavaReleasedBy(body, block.position);
  if (lava) throw new LavaReleaseError(block, lava);
}

interface DigBody extends LavaBody { dig?: (block: any, ...rest: any[]) => Promise<unknown>; lavaDigGuard?: { refused: number; last?: string } }

/**
 * Every dig, whoever asks for it, is checked for what it would let loose.
 * The check lived in one skill: stair-mine stopped at a block with lava
 * beside it, and the next skill called, tower-up, broke the same block from
 * underneath. The lava came down on the body, which died in two seconds
 * (paid run L63). Skills, the path executor and the reflexes all dig through
 * the body's `dig`, so the rule sits there.
 */
export function installLavaDigGuard(bot: DigBody): void {
  const dig = bot.dig?.bind(bot);
  if (!dig || bot.lavaDigGuard) return;
  const state: NonNullable<DigBody['lavaDigGuard']> = bot.lavaDigGuard = { refused: 0 };
  bot.dig = async (block: any, ...rest: any[]) => {
    try { assertNoLavaRelease(bot, block); }
    catch (error) {
      state.refused++;
      state.last = (error as Error).message;
      // Lava stays where it is: the route planner leaves this block alone for a minute.
      const repeated = block?.position ? digRefusedAt(bot, block.position) : false;
      if (block?.position) noteRefusedDig(bot, block.position, 60_000);
      if (!repeated) log.warn(`🌋 ${(error as Error).message}`);
      throw error;
    }
    return dig(block, ...rest);
  };
}

export function lavaDigGuardPlugin(bot: unknown): void { installLavaDigGuard(bot as DigBody); }

// ─── Getting out of lava ────────────────────────────────────────────────────

const REACH = 6;
const MAX_CELLS = 600;
const STEPS: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
const passable = (block: any) => !!block && block.boundingBox !== 'block';
const isFire = (block: any) => !!block && (block.name === 'fire' || block.name === 'soul_fire');
/** What burns a body that is in the cell: lava, or a block of fire. */
const burnsBody = (block: any) => isLava(block) || isFire(block);

/**
 * Whether the body stands in a block of fire: any cell its footprint touches, at the feet or at the head.
 * Fire is not lava (the body does not swim in it and the server does not flag it), and nothing looked for it:
 * a ghast's fireball leaves the netherrack around the body burning, and a body whose escape had no further
 * goal stood in the flames, a point of health a second, until it died (paid run L77c).
 */
export function standsInFire(body: LavaBody): boolean {
  const position = body.entity?.position;
  if (!position) return false;
  const y = Math.floor(position.y + 0.01);
  for (const dy of [0, 1]) {
    for (const [dx, dz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) {
      try { if (isFire(body.blockAt(new Vec3(Math.floor(position.x + dx), y + dy, Math.floor(position.z + dz))))) return true; } catch { /* unloaded */ }
    }
  }
  return false;
}

/**
 * Whether the body stands on a magma block: under any part of its footprint. Magma burns whoever stands on it
 * without crouching, a little at a time through the armour, and nothing named it: a body on a field of magma by a
 * lava sea was "hurt by something unknown" for ten seconds, stood still, and died (paid run L94, the Nether reached
 * from a fresh world at 39 minutes).
 */
export function standsOnMagma(body: LavaBody): boolean {
  const position = body.entity?.position;
  if (!position) return false;
  const y = Math.floor(position.y - 0.01);
  for (const [dx, dz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) {
    try { if (body.blockAt(new Vec3(Math.floor(position.x + dx), y, Math.floor(position.z + dz)))?.name === 'magma_block') return true; } catch { /* unloaded */ }
  }
  return false;
}

/**
 * The way out of lava: the cells the body's feet pass through to the nearest
 * place it can stand clear of it (both its cells free of lava, something
 * solid or water under them that is not lava). Null when the body is not in
 * lava's reach of such a place.
 */
export function routeOutOfLava(world: LavaWorld, position: Vec3): Vec3[] | null {
  const start = new Vec3(Math.floor(position.x), Math.floor(position.y + 0.2), Math.floor(position.z));
  const at = (cell: Vec3) => world.blockAt(cell);
  const fits = (feet: Vec3) => passable(at(feet)) && passable(at(feet.offset(0, 1, 0)));
  const clear = (feet: Vec3) => {
    if (burnsBody(at(feet)) || burnsBody(at(feet.offset(0, 1, 0)))) return false;
    const under = at(feet.offset(0, -1, 0));
    return !!under && !isLava(under) && (under.boundingBox === 'block' || under.name === 'water');
  };
  const key = (cell: Vec3) => `${cell.x},${cell.y},${cell.z}`;
  const cameFrom = new Map<string, Vec3 | null>([[key(start), null]]);
  const queue: Vec3[] = [start];
  for (let head = 0; head < queue.length && cameFrom.size <= MAX_CELLS; head++) {
    const cell = queue[head];
    if (cell !== start && clear(cell)) {
      const route: Vec3[] = [];
      for (let step: Vec3 | null = cell; step && step !== start; step = cameFrom.get(key(step)) ?? null) route.unshift(step.offset(0.5, 0, 0.5));
      return route;
    }
    for (const [dx, dy, dz] of STEPS) {
      const next = cell.offset(dx, dy, dz);
      if (Math.abs(next.x - start.x) > REACH || Math.abs(next.y - start.y) > REACH || Math.abs(next.z - start.z) > REACH) continue;
      if (cameFrom.has(key(next))) continue;
      let free = false;
      try { free = fits(next); } catch { free = false; }
      if (!free) continue;
      cameFrom.set(key(next), cell);
      queue.push(next);
    }
  }
  return null;
}

interface ReflexBody extends LavaBody {
  health?: number;
  setControlState(control: string, state: boolean): void;
  look?(yaw: number, pitch: number, force?: boolean): unknown;
  on(event: 'physicsTick', listener: () => void): unknown;
  lavaReflex?: LavaReflexState;
}
export interface LavaReflexState { engaged: boolean; engagements: number; clearTicks: number; in?: 'lava' | 'fire' | 'magma' }

/** Ticks out of lava before the reflex lets go of the keys. */
const RELEASE_TICKS = 6;

/**
 * One physics tick of the lava reflex, run after every other mover has set
 * its keys. Lava takes a fifth of the body's health every half second:
 * nothing that waits for a plan is in time. In lava the body swims (jump)
 * and heads for the nearest place clear of it; with no such place in reach
 * it still swims up. A body stood still in a lava flow for the two seconds
 * it took to die, its emergency plan not yet begun (paid run L63).
 */
export function lavaReflexTick(bot: ReflexBody, state: LavaReflexState): 'engaged' | 'released' | null {
  const entity = bot.entity;
  if (!entity || (bot.health ?? 20) <= 0) {
    if (!state.engaged) return null;
    state.engaged = false;
    return 'released';
  }
  const inLava = entity.isInLava === true;
  // A block of fire is left the same way, on foot: there is nothing to swim up through.
  const inFire = !inLava && standsInFire(bot);
  // On magma the body crouches, which the game leaves unburnt; whoever is moving it goes on doing so, slower.
  const onMagma = !inLava && !inFire && standsOnMagma(bot);
  if (onMagma) {
    bot.setControlState('sneak', true);
    state.clearTicks = 0;
    if (state.engaged) return null;
    state.engaged = true;
    state.in = 'magma';
    state.engagements++;
    return 'engaged';
  }
  if (!inLava && !inFire) {
    if (!state.engaged) return null;
    if (++state.clearTicks < RELEASE_TICKS) return null;
    state.engaged = false;
    if (state.in === 'magma') bot.setControlState('sneak', false);
    else for (const control of ['forward', 'jump', 'sprint']) bot.setControlState(control, false);
    return 'released';
  }
  state.clearTicks = 0;
  state.in = inLava ? 'lava' : 'fire';
  let route: Vec3[] | null = null;
  try { route = routeOutOfLava(bot, entity.position); } catch { route = null; }
  // In fire with nowhere clear in reach, the keys are left to whoever holds them.
  if (inFire && !route?.length) return null;
  bot.setControlState('jump', inLava || (!!route?.[0] && route[0].y > entity.position.y + 0.5));
  bot.setControlState('sneak', false);
  const next = route?.[0];
  if (next) {
    const dx = next.x - entity.position.x, dz = next.z - entity.position.z;
    if (Math.hypot(dx, dz) > 0.2) bot.look?.(Math.atan2(-dx, -dz), 0, true);
    bot.setControlState('forward', Math.hypot(dx, dz) > 0.2);
    bot.setControlState('sprint', true);
  }
  if (state.engaged) return null;
  state.engaged = true;
  state.engagements++;
  return 'engaged';
}

/** Above breaking out for air (300): nothing else is as short of time. */
const LAVA_ESCAPE_PRIORITY = 400;

export function installLavaReflex(bot: ReflexBody): void {
  if (bot.lavaReflex) return;
  const state: LavaReflexState = bot.lavaReflex = { engaged: false, engagements: 0, clearTicks: 0 };
  let release: (() => void) | null = null;
  bot.on('physicsTick', () => {
    let outcome: ReturnType<typeof lavaReflexTick> = null;
    try { outcome = lavaReflexTick(bot, state); } catch { return; }
    if (outcome === 'engaged' && state.in === 'magma') {
      // Crouching is all it takes; the body is not taken from what it is doing.
      log.warn('🟧 マグマの上: しゃがんで（しゃがめば焼けない）マグマの無い所まで');
    } else if (outcome === 'engaged') {
      log.warn(state.in === 'fire' ? '🔥 火の中に立っている: 火の無い足場へ出る' : '🌋 溶岩の中: 泳ぎ上がって、溶岩の無い足場へ出る');
      // The keys are set every tick here; the body is also taken, so that whatever else was moving it, or
      // an emergency starting up over the damage, does not clear them between two ticks.
      try {
        preemptLowerPriorityActions(bot, LAVA_ESCAPE_PRIORITY, 'lava_escape');
        void executeAction(bot as any, 'lava-escape', 15_000,
          () => new Promise(resolve => { release = () => resolve({ success: true, result: '溶岩・火から出た' }); }),
          { priority: LAVA_ESCAPE_PRIORITY, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true })
          .catch(() => undefined).finally(() => { release = null; });
      } catch { /* the keys are still set each tick */ }
    } else if (outcome === 'released' && state.in === 'magma') {
      log.info('🟧 マグマから離れた');
    } else if (outcome === 'released') {
      log.info(state.in === 'fire' ? '🔥 火から出た' : '🌋 溶岩から出た');
      release?.();
    }
  });
}

// ─── Putting the fire out ───────────────────────────────────────────────────

interface DouseBody extends LavaBody {
  entity?: { position: Vec3; isInLava?: boolean; isInWater?: boolean; metadata?: unknown[] };
  health?: number;
  heldItem?: { name?: string } | null;
  game?: { dimension?: string };
  inventory?: { items(): Array<{ name: string }> };
  pathfinder?: { stop(): void };
  equip?(item: unknown, destination: string): Promise<unknown>;
  lookAt?(position: Vec3, force?: boolean): Promise<unknown>;
  activateItem?(): unknown;
  deactivateItem?(): unknown;
  clearControlStates?(): void;
  on(event: 'physicsTick', listener: () => void): unknown;
  fireDouse?: FireDouseState;
}
export interface FireDouseState { running: boolean; attempts: number; doused: number; lastAt: number }

/** The server's own flag for a body on fire (bit 0 of the entity's shared flags). */
export function isBurning(bot: DouseBody): boolean {
  return (Number(bot.entity?.metadata?.[0] ?? 0) & 0x01) !== 0;
}

const DOUSE_RETRY_MS = 2500;
/** Lava within this many cells of the poured water keeps the water where it is. */
const LAVA_NEAR = 5;
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Whether the body should pour its water over itself now: it is burning, out
 * of the lava, not already in water, carries a bucket of water, and is where
 * water can be poured (not the Nether, where it boils away).
 */
export function shouldDouse(bot: DouseBody, state: FireDouseState, now = Date.now()): boolean {
  if (state.running || now - state.lastAt < DOUSE_RETRY_MS) return false;
  const entity = bot.entity;
  if (!entity || (bot.health ?? 20) <= 0 || !isBurning(bot)) return false;
  if (entity.isInLava === true || entity.isInWater === true) return false;
  if (String(bot.game?.dimension ?? '').includes('nether')) return false;
  return !!bot.inventory?.items().some(item => item.name === 'water_bucket');
}

/**
 * Pours the carried water onto the block the body stands on, and takes it up
 * again once the fire is out. A body that gets out of lava goes on burning
 * for up to fifteen seconds, a point of health each second on top of what the
 * lava took: three of four bodies that the lava reflex got out died of the
 * fire afterwards (lab, `lava-contact`). A person with a bucket of water
 * empties it at their feet.
 */
export async function douseFire(bot: DouseBody, state: FireDouseState): Promise<boolean> {
  const entity = bot.entity;
  const bucket = bot.inventory?.items().find(item => item.name === 'water_bucket');
  if (!entity || !bucket || !bot.equip || !bot.lookAt || !bot.activateItem) return false;
  state.attempts++;
  try { bot.pathfinder?.stop(); } catch { /* nothing was walking */ }
  bot.clearControlStates?.();
  const feet = new Vec3(Math.floor(entity.position.x), Math.floor(entity.position.y + 0.001), Math.floor(entity.position.z));
  await bot.equip(bucket, 'hand');
  // The item is used along the look (the client library's own call sends a level look due south whatever the
  // body looks at: the water went against a wall at head height, or nowhere).
  await activateItemFacing(bot as any, feet.offset(0.5, 0, 0.5));
  bot.deactivateItem?.();
  for (let waited = 0; waited < 1500 && isBurning(bot); waited += 50) await pause(50);
  const out = !isBurning(bot);
  if (out) state.doused++;
  // The water is wanted again: the bucket is filled from where the water lies as poured (a source block; the
  // body may have been carried a cell on by the time it lands, so the cells round its feet are looked at too).
  const held = () => String(bot.heldItem?.name ?? '');
  for (let waited = 0; waited < 800 && held() !== 'bucket'; waited += 50) await pause(50);
  // The water takes a moment to show in the body's picture of the world.
  for (let waited = 0; waited < 500 && held() === 'bucket' && bot.blockAt(feet)?.name !== 'water'; waited += 50) await pause(50);
  // With lava still near, the water stays where it is: it is what stands between the body and the flow.
  // Taken up at once, the lava came on and the body burned again within three seconds (lab; one of three died).
  let lava: Vec3 | null = null;
  for (let dx = -LAVA_NEAR; dx <= LAVA_NEAR && !lava; dx++) for (let dy = -1; dy <= 2 && !lava; dy++) for (let dz = -LAVA_NEAR; dz <= LAVA_NEAR && !lava; dz++) {
    const cell = feet.offset(dx, dy, dz);
    try { if (isLava(bot.blockAt(cell))) lava = cell; } catch { /* unreadable: not counted */ }
  }
  if (lava) {
    log.info(`🔥 溶岩が近い(${lava.x},${lava.y},${lava.z})ので、あけた水(${feet.x},${feet.y},${feet.z})は置いたままにする`);
    return out;
  }
  if (held() === 'bucket') {
    const now = bot.entity?.position ?? entity.position;
    const base = new Vec3(Math.floor(now.x), Math.floor(now.y + 0.001), Math.floor(now.z));
    const isSource = (cell: Vec3) => { try { const block = bot.blockAt(cell); return block?.name === 'water' && Number(block.metadata ?? 0) === 0; } catch { return false; } };
    const source = [feet, base, ...SIDES.map(([dx, , dz]) => base.offset(dx, 0, dz)), ...SIDES.map(([dx, , dz]) => feet.offset(dx, 0, dz))].find(isSource);
    if (source) {
      await activateItemFacing(bot as any, source.offset(0.5, 0.4, 0.5));
      bot.deactivateItem?.();
      for (let waited = 0; waited < 800 && held() !== 'water_bucket'; waited += 50) await pause(50);
    }
    if (held() === 'water_bucket') log.info('🔥 あけた水をバケツに汲み直した');
    else log.warn(`🔥 あけた水を汲み直せなかった（${source ? `水源(${source.x},${source.y},${source.z})に届かない` : '近くに水源が残っていない'}、手: ${held() || 'なし'}、身体: ${now.x.toFixed(1)},${now.y.toFixed(1)},${now.z.toFixed(1)}、あけた所: ${feet.x},${feet.y},${feet.z}=${(() => { try { const b = bot.blockAt(feet); return `${b?.name}:${b?.metadata}`; } catch { return '?'; } })()}）`);
  } else log.warn(`🔥 水をあけた後、手が空のバケツになっていない（手: ${held() || 'なし'}）`);
  return out;
}

export function installFireDouse(bot: DouseBody): void {
  if (bot.fireDouse) return;
  const state: FireDouseState = bot.fireDouse = { running: false, attempts: 0, doused: 0, lastAt: 0 };
  bot.on('physicsTick', () => {
    let due = false;
    try { due = shouldDouse(bot, state); } catch { due = false; }
    if (!due) return;
    state.running = true;
    state.lastAt = Date.now();
    log.warn('🔥 燃えている: 水バケツを足元にあけて消す');
    // The body is taken for the second this needs, as for the lava: an escape or an emergency starting up
    // over the fire damage must not turn the look away between the aim and the pour.
    Promise.resolve().then(() => {
      preemptLowerPriorityActions(bot, LAVA_ESCAPE_PRIORITY, 'douse_fire');
      return executeAction(bot as any, 'douse-fire', 6_000, async () => {
        const out = await douseFire(bot, state);
        return { success: out, result: out ? '火を消した' : '火は消えていない' };
      }, { priority: LAVA_ESCAPE_PRIORITY, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true });
    }).then(result => { log.info(`🔥 ${String((result as { result?: string })?.result ?? '')}`); },
      error => { log.warn(`🔥 消火できず: ${String(error)}`); })
      .finally(() => { state.running = false; state.lastAt = Date.now(); });
  });
}

/** As a mineflayer plugin, loaded after the movement plugins and the other reflexes so its keys win the tick. */
export function lavaReflexPlugin(bot: unknown): void { installLavaReflex(bot as ReflexBody); installFireDouse(bot as DouseBody); }
