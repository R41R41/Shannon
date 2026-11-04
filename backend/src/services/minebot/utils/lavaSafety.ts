import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { executeAction, preemptLowerPriorityActions } from '../execution/ActionExecution.js';
import { activateItemFacing } from './activateItemFacing.js';
import { digRefusedAt, noteRefusedDig } from './refusedDigs.js';
import { fallIsDangerous, stepOffDrop } from './edgeGuard.js';

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

/**
 * The fall that breaking `target` would drop the body into, when the body stands on it and nothing else holds it up: the drop (blocks,
 * Infinity onto lava or nothing) when it is a dangerous one (edgeGuard's measure: three points of damage or more, or what the health
 * cannot take), else null. A block the footprint does not rest on, or one with another block still under a corner of the footprint, is no fall.
 * The lab (S5, c1, 2026-11-04, the Nether at y=110): the path executor broke the netherrack the body stood on while a reset path still held it as
 * the next step's cell; there was air for 58 blocks under it and the body fell to its death.
 */
export function supportDropIfDug(body: LavaBody & { health?: number }, target: Vec3): number | null {
  const position = body.entity?.position;
  if (!position || !target) return null;
  const floorY = Math.floor(position.y - 0.01);
  if (target.y !== floorY) return null;
  const rests = [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]].some(([dx, dz]) => Math.floor(position.x + dx) === target.x && Math.floor(position.z + dz) === target.z);
  if (!rests) return null;
  const without = { blockAt: (cell: Vec3) => (Math.floor(cell.x) === target.x && Math.floor(cell.y) === target.y && Math.floor(cell.z) === target.z
    ? { name: 'air', boundingBox: 'empty' } : body.blockAt(cell)) };
  let drop = 0;
  try { drop = stepOffDrop(without, position.x, position.y, position.z); } catch { return null; }
  return fallIsDangerous(drop, body.health ?? 20) ? drop : null;
}

/** A dig refused because the block is what holds the body up over a dangerous fall. */
export class SupportDigError extends Error {
  readonly failureType = 'support_dig';
  constructor(block: { name?: string; position: Vec3 }, readonly drop: number) {
    super(`掘削中止: ${block.name ?? 'ブロック'}(${block.position.x}, ${block.position.y}, ${block.position.z})は今立っている床で、掘ると${Number.isFinite(drop) ? `${Math.round(drop)} ブロック下へ落ちる` : '溶岩か底の無い所へ落ちる'}。`
      + '先に横の固い床へ移るか、足元を残して別の向きから掘ってください');
    this.name = 'SupportDigError';
  }
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
    try {
      assertNoLavaRelease(bot, block);
      const drop = block?.position ? supportDropIfDug(bot as DigBody & { health?: number }, block.position) : null;
      if (drop !== null) throw new SupportDigError(block, drop);
    }
    catch (error) {
      state.refused++;
      state.last = (error as Error).message;
      // Lava stays where it is (and a floor over a fall stays a floor): the route planner leaves this block alone for a minute.
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
  return magmaUnderFeet(body) !== null;
}

/** The magma block under the body's width (its centre's cell first), or null. */
export function magmaUnderFeet(body: LavaBody): Vec3 | null {
  const position = body.entity?.position;
  if (!position) return null;
  const y = Math.floor(position.y - 0.01);
  for (const [dx, dz] of [[0, 0], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) {
    const cell = new Vec3(Math.floor(position.x + dx), y, Math.floor(position.z + dz));
    try { if (body.blockAt(cell)?.name === 'magma_block') return cell; } catch { /* unloaded */ }
  }
  return null;
}

/**
 * The way out of lava: the cells the body's feet pass through to the nearest
 * place it can stand clear of it (both its cells free of lava, something
 * solid or water under them that is not lava). Null when the body is not in
 * lava's reach of such a place.
 */
export function routeOutOfLava(world: LavaWorld, position: Vec3, options: { offMagma?: boolean } = {}): Vec3[] | null {
  const start = new Vec3(Math.floor(position.x), Math.floor(position.y + 0.2), Math.floor(position.z));
  const at = (cell: Vec3) => world.blockAt(cell);
  const fits = (feet: Vec3) => passable(at(feet)) && passable(at(feet.offset(0, 1, 0)));
  const clear = (feet: Vec3) => {
    if (burnsBody(at(feet)) || burnsBody(at(feet.offset(0, 1, 0)))) return false;
    const under = at(feet.offset(0, -1, 0));
    // Off magma: a cell over magma is no place to stand either.
    if (options.offMagma && under?.name === 'magma_block') return false;
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
  /** Puts out the fire in the cells the body stands in (a quick dig); installed with the reflex. False: nothing was put out. */
  punchOutFire?: () => Promise<boolean>;
  /** Puts a block where the body's centre rests (or rises a block on one), so that it stands on no magma; installed with the reflex. */
  coverMagma?: () => Promise<boolean>;
}
export interface LavaReflexState {
  /** Lava or fire only: the body is taken (a lease, the keys each tick). Magma never sets it (MagmaState). */
  engaged: boolean; engagements: number; clearTicks: number; in?: 'lava' | 'fire';
  /** The putting out of fire: one at a time, and given up on after PUNCH_FAILURES_MAX failures or PUNCH_EPISODE_MS of the same fire. */
  punch?: { running: boolean; startedAt: number; failures: number; episodeStart: number; lastFireAt: number };
  magma?: MagmaState;
}
/**
 * The magma reflex, apart from lava's: it takes no lease and is no held reflex, so the act's hand goes on (run62: magma set `engaged`, the act's wait
 * for the reflex ran out, every hand of a dig on the broken portal's rim came back not_run while the body stood on the magma's edge and burnt).
 */
export interface MagmaState {
  on: boolean; engagements: number; clearTicks: number;
  /** Where the body stood still from, and since which tick on magma. */
  anchor?: { x: number; z: number; tick: number };
  ticks: number;
  /** Walking the body off, from the tick it began (sticky until it is off). */
  steeringSince?: number;
  covering: boolean; covers: number; coverFailures: number;
}

/** Ticks still on magma before the body is walked off (it is not moving itself), and before a block is put down instead. */
export const MAGMA_STILL_TICKS = 6, MAGMA_COVER_TICKS = 30, MAGMA_COVER_FAILURES_MAX = 3;
/**
 * S2 (2026-11-02, the c1 blaze camp): a blaze's fireball leaves fire in the cells round the body, the body stands in it, and the reflex took the body out of its place and the act
 * out of its hands ('lava_escape' stops, one every few seconds). A body in fire that is not lava is first given a quick dig at the fire it stands in; only when that does not
 * put it out (it failed twice, or the fire stood for PUNCH_EPISODE_MS) is it walked out as before. Lava is never punched at.
 */
export const PUNCH_GRACE_MS = 700, PUNCH_FAILURES_MAX = 2, PUNCH_EPISODE_MS = 2000;

/** Ticks out of lava before the reflex lets go of the keys. */
const RELEASE_TICKS = 6;

/**
 * One tick of the magma reflex. On magma the body crouches; a body that stands still on it (an act digging, waiting) is walked to the nearest
 * cell off it, uncrouched for a step down (a crouch does not step off an edge), and with no such cell in reach, or still on it after
 * MAGMA_COVER_TICKS, a block is put where its centre rests. Run62 (c1, a broken portal's rim): the centre was over the hole and only the
 * body's width on magma; the head's digs went on, the body stood there and burnt.
 */
function magmaTick(bot: ReflexBody, state: LavaReflexState, onMagma: boolean): 'magma' | 'magma-off' | null {
  const magma = state.magma ??= { on: false, engagements: 0, clearTicks: 0, ticks: 0, covering: false, covers: 0, coverFailures: 0 };
  const position = bot.entity!.position;
  if (!onMagma) {
    if (!magma.on || magma.covering) return null;
    // Off it, the walk stops at once: the next cell may be the edge of something worse.
    if (magma.steeringSince !== undefined) { for (const control of ['forward', 'jump']) bot.setControlState(control, false); magma.steeringSince = undefined; }
    if (++magma.clearTicks < RELEASE_TICKS) return null;
    magma.on = false; magma.anchor = undefined; magma.ticks = 0;
    bot.setControlState('sneak', false);
    return 'magma-off';
  }
  magma.clearTicks = 0;
  magma.ticks++;
  let outcome: 'magma' | null = null;
  if (!magma.on) { magma.on = true; magma.engagements++; magma.coverFailures = 0; outcome = 'magma'; }
  if (!magma.anchor || Math.hypot(position.x - magma.anchor.x, position.z - magma.anchor.z) > 0.3) magma.anchor = { x: position.x, z: position.z, tick: magma.ticks };
  if (magma.steeringSince === undefined && magma.ticks - magma.anchor.tick >= MAGMA_STILL_TICKS) magma.steeringSince = magma.ticks;
  let sneak = true;
  if (magma.steeringSince !== undefined && !magma.covering) {
    let route: Vec3[] | null = null;
    try { route = routeOutOfLava(bot, position, { offMagma: true }); } catch { route = null; }
    const next = route?.[0];
    const canCover = !!bot.coverMagma && magma.coverFailures < MAGMA_COVER_FAILURES_MAX;
    if (next && (magma.ticks - magma.steeringSince < MAGMA_COVER_TICKS || !canCover)) {
      const feetY = Math.floor(position.y + 0.2), down = next.y < feetY;
      const dx = next.x - position.x, dz = next.z - position.z, far = Math.hypot(dx, dz) > (down ? 0.1 : 0.2);
      if (far) bot.look?.(Math.atan2(-dx, -dz), 0, true);
      bot.setControlState('forward', far);
      bot.setControlState('sprint', false);
      bot.setControlState('jump', next.y > feetY);
      sneak = !down;
    } else if (canCover) {
      magma.covering = true;
      bot.setControlState('forward', false);
      void bot.coverMagma!().then(ok => { if (ok) magma.covers++; else magma.coverFailures++; }, () => { magma.coverFailures++; })
        .finally(() => { magma.covering = false; if (magma.on) magma.steeringSince = magma.ticks; });
    }
  }
  bot.setControlState('sneak', sneak);
  return outcome;
}

/**
 * One physics tick of the lava reflex, run after every other mover has set
 * its keys. Lava takes a fifth of the body's health every half second:
 * nothing that waits for a plan is in time. In lava the body swims (jump)
 * and heads for the nearest place clear of it; with no such place in reach
 * it still swims up. A body stood still in a lava flow for the two seconds
 * it took to die, its emergency plan not yet begun (paid run L63).
 */
export function lavaReflexTick(bot: ReflexBody, state: LavaReflexState): 'engaged' | 'released' | 'magma' | 'magma-off' | null {
  const entity = bot.entity;
  if (!entity || (bot.health ?? 20) <= 0) {
    if (state.magma) state.magma.on = false;
    if (!state.engaged) return null;
    state.engaged = false;
    return 'released';
  }
  const inLava = entity.isInLava === true;
  // A block of fire is left the same way, on foot: there is nothing to swim up through.
  const inFire = !inLava && standsInFire(bot);
  // Magma is its own reflex: it holds no lease and stops no act (MagmaState).
  if (!state.engaged) {
    const magma = magmaTick(bot, state, !inLava && !inFire && standsOnMagma(bot));
    if (!inLava && !inFire) return magma;
  } else if (state.magma) state.magma.on = false;
  if (!inLava && !inFire) {
    if (!state.engaged) return null;
    if (++state.clearTicks < RELEASE_TICKS) return null;
    state.engaged = false;
    for (const control of ['forward', 'jump', 'sprint']) bot.setControlState(control, false);
    return 'released';
  }
  state.clearTicks = 0;
  state.in = inLava ? 'lava' : 'fire';
  if (inFire && !state.engaged && bot.punchOutFire) {
    const now = Date.now();
    const punch = state.punch ??= { running: false, startedAt: 0, failures: 0, episodeStart: now, lastFireAt: now };
    if (now - punch.lastFireAt > 1500) { punch.episodeStart = now; punch.failures = 0; }
    punch.lastFireAt = now;
    if (punch.failures < PUNCH_FAILURES_MAX && now - punch.episodeStart < PUNCH_EPISODE_MS) {
      if (!punch.running) {
        punch.running = true; punch.startedAt = now;
        void bot.punchOutFire().then(ok => { punch.failures = ok ? 0 : punch.failures + 1; }, () => { punch.failures++; }).finally(() => { punch.running = false; });
      }
      // The body is left where it is while the dig has its moment.
      if (now - punch.startedAt < PUNCH_GRACE_MS) return null;
    }
  }
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

/** What is put over magma: common blocks, never what a later step needs (obsidian, planks, the table). */
export const MAGMA_COVER_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'blackstone', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'end_stone'];
interface CoverBody extends ReflexBody {
  heldItem?: { name?: string } | null;
  inventory?: { items(): Array<{ name: string }> };
  equip?(item: unknown, destination: string): Promise<unknown>;
  placeBlock?(reference: unknown, face: Vec3): Promise<unknown>;
}
const settle = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Puts a block so that the body stands on no magma. The game burns a body through the block its centre rests on: with the centre over a hole
 * (a rim of magma round it) the hole's cell under the centre is filled; on magma all round, the body rises one block on the magma under it.
 * The held item is put back. False when there is no such block to put, no face to put it against, or no room to rise.
 */
export async function coverMagmaUnder(bot: CoverBody): Promise<boolean> {
  const at = bot.entity?.position;
  if (!at || !bot.equip || !bot.placeBlock) return false;
  const items = bot.inventory?.items() ?? [];
  const block = MAGMA_COVER_BLOCKS.map(name => items.find(item => item.name === name)).find(Boolean);
  if (!block) return false;
  const centre = new Vec3(Math.floor(at.x), Math.floor(at.y - 0.01), Math.floor(at.z));
  const under = bot.blockAt(centre);
  const solid = (cell: Vec3) => { try { return bot.blockAt(cell)?.boundingBox === 'block'; } catch { return false; } };
  let reference: Vec3 | null = null, face: Vec3 | null = null, rise = false;
  if (under && under.boundingBox !== 'block' && !isLava(under)) {
    for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      if (solid(centre.offset(dx, dy, dz))) { reference = centre.offset(dx, dy, dz); face = new Vec3(0 - dx, 0 - dy, 0 - dz); break; }
    }
  } else if (under?.name === 'magma_block' && !solid(centre.offset(0, 3, 0))) {
    reference = centre; face = new Vec3(0, 1, 0); rise = true;
  }
  if (!reference || !face) return false;
  const held = bot.heldItem;
  await bot.equip(block, 'hand');
  try {
    if (rise) {
      bot.setControlState('jump', true);
      for (let waited = 0; waited < 600 && (bot.entity?.position.y ?? 0) < centre.y + 2; waited += 50) await settle(50);
      bot.setControlState('jump', false);
      if ((bot.entity?.position.y ?? 0) < centre.y + 2) return false;
    }
    await bot.placeBlock(bot.blockAt(reference), face);
    return true;
  } finally {
    if (held && held.name !== (block as { name: string }).name) await bot.equip(held, 'hand').catch(() => undefined);
  }
}

export function installLavaReflex(bot: ReflexBody): void {
  if (bot.lavaReflex) return;
  const state: LavaReflexState = bot.lavaReflex = { engaged: false, engagements: 0, clearTicks: 0 };
  let release: (() => void) | null = null;
  // The fire the body stands in, put out by a dig at it (looked at, instant: a fire has no hardness). The body's own dig is the guarded one.
  const digger = bot as unknown as { dig?: (block: unknown, forceLook?: boolean) => Promise<unknown> };
  if (!bot.punchOutFire && typeof digger.dig === 'function') {
    bot.punchOutFire = async () => {
      const at = bot.entity?.position;
      if (!at) return false;
      const y = Math.floor(at.y + 0.01), done = new Set<string>();
      let dug = 0;
      for (const dy of [0, 1]) for (const [dx, dz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) {
        const cell = new Vec3(Math.floor(at.x + dx), y + dy, Math.floor(at.z + dz)), id = `${cell.x},${cell.y},${cell.z}`;
        if (done.has(id)) continue;
        done.add(id);
        let block: any = null;
        try { block = bot.blockAt(cell); } catch { block = null; }
        if (!isFire(block)) continue;
        // (review 2026-11-03: the punch holds no lease; once this reflex (a wall escape, the lava climb) has taken the body, or the body is gone, no further dig is sent over its work)
        if (state.engaged || !bot.entity) break;
        let timer: NodeJS.Timeout | undefined;
        try { await Promise.race([digger.dig!(block, true), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('punch timeout')), PUNCH_GRACE_MS); })]); }
        finally { if (timer) clearTimeout(timer); }
        dug++;
      }
      return dug > 0;
    };
  }
  if (!bot.coverMagma) bot.coverMagma = () => coverMagmaUnder(bot as unknown as CoverBody);
  bot.on('physicsTick', () => {
    let outcome: ReturnType<typeof lavaReflexTick> = null;
    try { outcome = lavaReflexTick(bot, state); } catch { return; }
    if (outcome === 'magma') {
      // No lease and no held reflex: the act's hand goes on while the body crouches and, standing still, steps off.
      log.warn('🟧 マグマの上: しゃがんで、止まっていれば一番近いマグマの無い足場へ降りる（無ければ丸石・土で覆う）');
    } else if (outcome === 'magma-off') {
      log.info(`🟧 マグマから離れた${state.magma?.covers ? `（覆った ${state.magma.covers} 回）` : ''}`);
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
