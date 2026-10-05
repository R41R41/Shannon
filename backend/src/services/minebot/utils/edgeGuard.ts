import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { activeActionCapabilities } from '../execution/ActionExecution.js';
import { createLogger } from '../../../utils/logger.js';
import { holdsWater } from './waterBlocks.js';

const log = createLogger('Minebot:EdgeGuard');
const { Physics, PlayerState } = createRequire(import.meta.url)('prismarine-physics');

/** Half-width of the player hitbox: a player stays up while any part of it overlaps a block. */
const HALF_WIDTH = 0.3;
const SCAN_DEPTH = 64;
const HORIZONTAL_CONTROLS = ['forward', 'back', 'left', 'right', 'sprint'] as const;

export interface EdgeGuardBlock { name: string; boundingBox: string }
export interface EdgeGuardBot {
  entity?: { position: Vec3; velocity: Vec3; onGround: boolean; isInWater?: boolean; isInLava?: boolean };
  health?: number;
  blockAt(position: Vec3): EdgeGuardBlock | null;
  getControlState(control: string): boolean;
  setControlState(control: string, state: boolean): void;
}

function isWater(block: EdgeGuardBlock): boolean { return holdsWater(block); }

/**
 * Where a fall down one column ends, starting below `floorY` from feet height
 * `y`: the top of the first solid block and the height fallen onto it. Water
 * breaks a fall only while the body is in it, so the count restarts at the
 * bottom of each stretch of water: water resting on a block is a safe landing,
 * a sheet of water with air beneath it is not. A paid run (L19) followed
 * water down a cave and came out of it 35 blocks above a lava lake. Lava or no
 * landing within reach is Infinity; unknown (unloaded) blocks count as safe,
 * so the guard never acts on missing data.
 */
function columnFall(bot: Pick<EdgeGuardBot, 'blockAt'>, cx: number, cz: number, y: number, floorY: number): { top: number; drop: number } {
  let from = y;
  for (let depth = 1; depth <= SCAN_DEPTH; depth++) {
    const blockY = floorY - depth;
    const block = bot.blockAt(new Vec3(cx, blockY, cz));
    if (!block) return { top: blockY + 1, drop: 0 };
    if (block.name === 'lava') return { top: blockY + 1, drop: Infinity };
    if (isWater(block)) { from = blockY; continue; }
    if (block.boundingBox === 'block') return { top: blockY + 1, drop: Math.max(0, from - (blockY + 1)) };
  }
  return { top: -Infinity, drop: Infinity };
}

/**
 * Blocks the player would fall if its feet were at (x, y, z): 0 while any part
 * of the footprint still rests on a block or the fall ends in water that rests
 * on something, Infinity for lava or no landing within reach.
 */
export function stepOffDrop(bot: Pick<EdgeGuardBot, 'blockAt'>, x: number, y: number, z: number): number {
  const floorY = Math.floor(y - 0.01);
  const corners = [[x - HALF_WIDTH, z - HALF_WIDTH], [x + HALF_WIDTH, z - HALF_WIDTH], [x - HALF_WIDTH, z + HALF_WIDTH], [x + HALF_WIDTH, z + HALF_WIDTH]];
  for (const [cx, cz] of corners) {
    const below = bot.blockAt(new Vec3(cx, floorY, cz));
    if (!below || below.boundingBox === 'block') return 0;
  }
  // The body comes down on the highest landing under any part of its footprint.
  let landing: { top: number; drop: number } | null = null;
  for (const [cx, cz] of [...corners, [x, z]]) {
    const fall = columnFall(bot, cx, cz, y, floorY);
    if (!landing || fall.top > landing.top || (fall.top === landing.top && fall.drop > landing.drop)) landing = fall;
  }
  return landing!.drop;
}

/**
 * The dangerous drop under the body's centre at (x, y, z), or null when the
 * centre is over a block or over a fall it would survive. Keeping the centre
 * on the safe side leaves at least half the footprint on the ledge, so a
 * small shove does not finish what the stop prevented. Asking the same of
 * every corner refused the diagonal steps a path takes along a cliff, where a
 * corner sweeps over the drop while the body stays supported, and left a paid
 * run (L17) pushing at a rim until its move timed out.
 */
export function edgeRisk(bot: Pick<EdgeGuardBot, 'blockAt'>, x: number, y: number, z: number, health: number): number | null {
  const floorY = Math.floor(y - 0.01);
  const below = bot.blockAt(new Vec3(x, floorY, z));
  if (!below || below.boundingBox === 'block') return null;
  const { drop } = columnFall(bot, x, z, y, floorY);
  return fallIsDangerous(drop, health) ? drop : null;
}

/** Vanilla fall damage is one point per block beyond three. */
export function fallIsDangerous(drop: number, health: number): boolean {
  if (!Number.isFinite(drop)) return drop > 0;
  const damage = Math.max(0, Math.ceil(drop - 3));
  return damage >= 3 || damage >= health;
}

/** Exposed on the bot as `bot.edgeGuard`; `enabled` can be cleared by a mover that means to drop. */
export interface EdgeGuardState { enabled: boolean; stops: number; refusedCells: Map<string, number> }

/** Extra path cost, per step, of a cell the guard recently refused, and how long the memory lasts. */
export const REFUSED_CELL_COST = 20;
const REFUSED_CELL_MS = 120_000;
const cellKey = (x: number, y: number, z: number) => `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;

/**
 * Path cost the planner should add for stepping into a cell the guard
 * recently stopped the body at. Clipping alone left the path executor
 * re-running the same rim route for a minute while chasing a cow past a
 * 7-block ledge (paid run L15); a cost, not a ban, lets it route around and
 * still use the rim when nothing else leads there.
 */
export function refusedCellCost(state: Pick<EdgeGuardState, 'refusedCells'>, block: { position?: { x: number; y: number; z: number } } | null, now = Date.now()): number {
  const p = block?.position;
  if (!p) return 0;
  const until = state.refusedCells.get(cellKey(p.x, p.y, p.z));
  if (until === undefined) return 0;
  if (until <= now) { state.refusedCells.delete(cellKey(p.x, p.y, p.z)); return 0; }
  return REFUSED_CELL_COST;
}

interface SimulatedState {
  pos: Vec3; vel: Vec3; onGround: boolean; isInWater: boolean; isInLava: boolean;
  apply(bot: unknown): void;
}
interface PhysicsEngine { simulatePlayer(state: any, world: unknown): SimulatedState }

const JUMP_HORIZON_TICKS = 30;
const CLIP_STEPS = 20;

/**
 * Where a jump taking off from the bot's current state comes down, following
 * the arc with the keys still held: the fall in blocks from the arc's peak
 * (0 into water, Infinity onto lava or nothing), or the drop beside a landing
 * that leaves part of the footprint over a dangerous edge. A jump cannot be steered back
 * once airborne, so the whole arc is judged at take-off.
 */
export function predictJumpFall(engine: PhysicsEngine, world: unknown, bot: EdgeGuardBot,
  controls: Record<string, boolean>, startY: number, health = bot.health ?? 20): number {
  const state = new PlayerState(bot, controls) as SimulatedState;
  let peak = Math.max(startY, state.pos.y);
  for (let tick = 0; tick < JUMP_HORIZON_TICKS; tick++) {
    engine.simulatePlayer(state, world);
    if (state.isInWater) return 0;
    if (state.isInLava) return Infinity;
    peak = Math.max(peak, state.pos.y);
    // The engine resolves the vertical move at the old footprint first, so a
    // descending arc can report ground while the body has already passed the
    // rim; judge the landing by what is under the footprint, with margin.
    if (state.onGround) return edgeRisk(bot, state.pos.x, state.pos.y, state.pos.z, health) ?? Math.max(0, peak - state.pos.y);
  }
  const below = stepOffDrop(bot, state.pos.x, state.pos.y, state.pos.z);
  return Number.isFinite(below) ? peak - state.pos.y + below : Infinity;
}

function releaseHorizontal(bot: EdgeGuardBot): void {
  for (const control of HORIZONTAL_CONTROLS) if (bot.getControlState(control)) bot.setControlState(control, false);
}

/**
 * Judge the tick the physics engine has just applied, before its position is
 * sent to the server. A self-propelled tick that carried a standing bot's
 * centre over a dangerous fall is clipped back to the last point along its
 * path where the centre is still on the safe side, the way a careful player
 * stops at a ledge; a crouched one may lean out as far as its footprint still
 * rests on the ledge; a jump taking off toward a dangerous landing is undone as if the key
 * had not been pressed. A launch the bot did not make itself (knockback, an
 * explosion) is left alone, and so is a drop the movement planner takes
 * deliberately (at most a point of damage). Returns the refused drop, or null.
 */
export function judgeAppliedTick(bot: EdgeGuardBot, before: { position: Vec3; onGround: boolean; inLava?: boolean },
  jumpFall: (() => number) | null): number | null {
  const entity = bot.entity;
  // A swimming body is left to the swimming reflexes. One standing in a shallow stream is not: the current
  // carries it with no key pressed, and a stream running over a ravine rim took a body over a 24-block drop
  // while it stood in it (paid run L90, eight minutes in). Standing, the same edge holds in water as on land.
  if (!entity || !before.onGround) return null;
  if (entity.isInLava) {
    // A step of its own that took the body from dry ground into lava at its own level (a flow beside the
    // path, the edge of a pool) is taken back like a step over a cliff: the drop the guard knew of was the
    // one under the feet, and a body walked into the side of a lava fall (paid run L77b). Lava that came to
    // the body, or a body already in it, is the lava reflex's business.
    if (before.inLava !== false || !HORIZONTAL_CONTROLS.some(control => control !== 'sprint' && bot.getControlState(control))) return null;
    entity.position.set(before.position.x, before.position.y, before.position.z);
    entity.velocity.set(0, 0, 0);
    entity.onGround = true;
    entity.isInLava = false;
    releaseHorizontal(bot);
    return Infinity;
  }
  if (stepOffDrop(bot, before.position.x, before.position.y, before.position.z) !== 0) return null;
  const health = bot.health ?? 20;
  if (entity.velocity.y > 0) {
    if (!bot.getControlState('jump') || !jumpFall) return null;
    const fall = jumpFall();
    if (!fallIsDangerous(fall, health)) return null;
    entity.position.set(before.position.x, before.position.y, before.position.z);
    entity.velocity.set(0, 0, 0);
    entity.onGround = true;
    bot.setControlState('jump', false);
    releaseHorizontal(bot);
    return fall;
  }
  const after = entity.position;
  // From a footing already at the brink (a teleport, a block broken under a
  // foot) only a step off is refused, so the bot can still walk back inland.
  // A crouched body is judged the same way. The engine holds a sneaking player
  // on its footing, as the game does, and leaning out past the rim is how a
  // block is placed over a gap: the path executor crouches and backs out until
  // its centre is over the cell it is about to fill. Kept inland of an 8-block
  // drop it never got there, and held the pose for the whole move with the
  // bridge not begun (paid run L50).
  const atBrink = bot.getControlState('sneak')
    || edgeRisk(bot, before.position.x, before.position.y, before.position.z, health) !== null;
  const unsafe = (x: number, z: number): number | null => {
    if (!atBrink) return edgeRisk(bot, x, after.y, z, health);
    const drop = stepOffDrop(bot, x, after.y, z);
    return fallIsDangerous(drop, health) ? drop : null;
  };
  const drop = unsafe(after.x, after.z);
  if (drop === null) return null;
  const dx = after.x - before.position.x, dz = after.z - before.position.z;
  let t = 1;
  while (t > 0 && unsafe(before.position.x + dx * t, before.position.z + dz * t) !== null) t = Math.max(0, t - 1 / CLIP_STEPS);
  entity.position.set(before.position.x + dx * t, after.y, before.position.z + dz * t);
  entity.velocity.x = 0;
  entity.velocity.z = 0;
  entity.onGround = true;
  return drop;
}

/**
 * Wrap the bot's physics engine so every real tick, whoever pressed the keys
 * and from whatever timer, is judged after it is applied and before it is
 * sent. Path simulations reuse the same engine but never apply their states,
 * so they are not judged. Every mover (pathfinder goals, skills, reflexes)
 * shares this one invariant instead of each re-checking terrain: a paid run
 * walked off a 32-block ravine rim while fleeing.
 */
interface PathfinderLike { movements?: { exclusionAreasStep?: Array<(block: any) => number> }; setMovements?(movements: any): void }

export function installEdgeGuard(bot: EdgeGuardBot & { physics?: PhysicsEngine; registry?: unknown; controlState?: Record<string, boolean>; pathfinder?: PathfinderLike }): void {
  const marked = bot as typeof bot & { edgeGuard?: EdgeGuardState };
  if (marked.edgeGuard || !bot.physics?.simulatePlayer) return;
  const state: EdgeGuardState = marked.edgeGuard = { enabled: true, stops: 0, refusedCells: new Map() };
  // Every movement profile any skill installs carries the refusals as path cost.
  const exclusion = (block: any) => refusedCellCost(state, block);
  const attach = (movements: PathfinderLike['movements']) => {
    if (Array.isArray(movements?.exclusionAreasStep) && !movements.exclusionAreasStep.includes(exclusion)) movements.exclusionAreasStep.push(exclusion);
  };
  const pathfinder = bot.pathfinder;
  if (pathfinder?.setMovements) {
    attach(pathfinder.movements);
    const setMovements = pathfinder.setMovements.bind(pathfinder);
    pathfinder.setMovements = (movements: any) => { attach(movements); return setMovements(movements); };
  }
  const world = { getBlock: (pos: Vec3) => (bot.blockAt as (pos: Vec3, extra?: boolean) => unknown)(pos, false) };
  // A separate engine for look-ahead, so predictions never re-enter the wrapper.
  const lookahead: PhysicsEngine = Physics(bot.registry, world);
  const engine = bot.physics;
  const simulate = engine.simulatePlayer.bind(engine);
  let lastLogAt = 0;
  engine.simulatePlayer = (simulated: any, simulatedWorld: unknown) => {
    const result = simulate(simulated, simulatedWorld);
    const apply = result.apply.bind(result);
    result.apply = (target: unknown) => {
      if (target !== bot || !state.enabled || !bot.entity) return apply(target);
      const before = { position: bot.entity.position.clone(), onGround: bot.entity.onGround, inLava: bot.entity.isInLava === true };
      apply(target);
      const attempted = bot.entity.position.clone();
      let drop: number | null = null;
      try {
        drop = judgeAppliedTick(bot, before, bot.controlState
          ? () => predictJumpFall(lookahead, world, bot, bot.controlState!, before.position.y) : null);
      } catch { /* never break the physics tick */ }
      if (drop === null) return;
      state.stops++;
      const now = Date.now();
      for (const p of [bot.entity.position, attempted]) state.refusedCells.set(cellKey(p.x, p.y, p.z), now + REFUSED_CELL_MS);
      if (state.refusedCells.size > 256) for (const [key, until] of state.refusedCells) if (until <= now) state.refusedCells.delete(key);
      if (now - lastLogAt < 3000) return;
      lastLogAt = now;
      const actions = activeActionCapabilities(bot);
      log.warn(`🧗 崖際で停止: 前方の落差${Number.isFinite(drop) ? `${drop.toFixed(1)}ブロック` : '（溶岩/底なし）'}`
        + ` (行動=${actions.join(',') || 'なし'})`);
    };
    return result;
  };
}

/** As a mineflayer plugin, loaded after the physics plugin has exposed `bot.physics`. */
export function edgeGuardPlugin(bot: unknown): void { installEdgeGuard(bot as Parameters<typeof installEdgeGuard>[0]); }
