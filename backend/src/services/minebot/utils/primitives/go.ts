import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { PROTECTED_UTILITY_BLOCKS } from '../../constants.js';
import { nativeActionHost } from '../../execution/ActionExecution.js';
import { buildMovements } from '../setMovements.js';
import { FAR_LEG_M, nextLeg } from '../farLegs.js';
import { feetCell, type BlockReader, type Cell } from '../localMap.js';
import { chooseTool, canHarvest, nearlyBroken } from '../toolChoice.js';
import { installDoorRules, isDoorlike, mapBlockOf, nodeCell, NO_ENTER, standable } from '../walkRules.js';
import { clip } from '../actReport.js';
import { blockAt, cellText, inventoryCount, isAirLike, letGo, stopped, StepStopped, wait, waitUntil, type StepContext, type StepOutcome } from './common.js';
import { atGoal, goWith, type GoOutcome, type WayNotes } from './walk.js';
import { dig } from './dig.js';
import { pillarUp, shortFloor, wholeFloorBeside } from './pillarUp.js';
import { bodyOverlap, placeFacts } from '../placeFacts.js';
import { blackBoxOf } from '../blackbox.js';

const { goals } = pathfinder;

/**
 * go: to a place (or to the nearest of a few), by a way the body finds itself (the contract of the hand `go`, 2026-10-26, run 39: ninety stops of
 * walks that were drawn cell by cell by the planner and did not match the ground). The planner decides WHERE (the cell or the cells), WHAT MAY BE
 * DUG (`canDig`), WHAT MAY BE LAID (`canPlace`, only what the pack holds), how far a fall may be, whether water may be entered, and the limits
 * (`seconds`, `maxDig`, `maxPlace`). The body decides only the details of the way: which cells to tread, dig or fill, the new drawing when the way is
 * shut, the mending when it stands still. It never looks for a thing to go to (no ore, no tree): the place is always the planner's.
 *
 * The route search is mineflayer-pathfinder's, given movements that dig only the allowed kinds, lay only the allowed blocks the pack holds, never
 * enter lava, fire, a magma block, a cactus, a berry bush or a wither rose nor stand beside lava, a magma block or a cactus, and fall no further
 * than allowed. Its own one-block towers are off (it places the block while the jump is still low); a climb is made with `pillarUp` (the block laid at
 * the top of the jump), a cell at a time. A way that cannot be found is looked at again with each rule lifted in turn (hazards, the tool, the
 * blocks, the permissions), and the first that opens it names the stop: `lava`, `no_tool`, `no_blocks`, `dead_end`.
 */
export interface GoArgs {
  /** The places (feet cells) the body may end at: the nearest by the way found. One or more. */
  goals: Cell[];
  /** Within this many metres of a place counts as there (0 to 4, default 0.5: the cell itself). */
  range?: number;
  canDig?: string[];
  canPlace?: string[];
  /** The most cells fallen at once (0 to 10, default 3); onto water more is allowed. */
  maxDrop?: number;
  waterOk?: boolean;
  /** Seconds the hand may take (5 to 120, default 60). */
  seconds?: number;
  maxDig?: number;
  maxPlace?: number;
  sprint?: boolean;
  /**
   * The longest one drawing of the way may search, in the pathfinder's own milliseconds (default 5 s; the search that says why the way is shut, 2.5 s). The tests that
   * run on a faked clock give a search no time limit of its own (a slow machine would run it out and the line would say dead_end instead of the reason).
   */
  searchMs?: number;
}

export const GO_DEFAULTS = { range: 0.5, maxDrop: 3, seconds: 60, maxDig: 40, maxPlace: 24 } as const;
/** Stuck: the position unchanged for this long while nothing is being dug or laid. */
export const GO_STUCK_MS = 3000;
/**
 * Run 40 (2026-10-27: 7 stuck stops of 34 to 54 s and 217 to 436 redraws each): the route executor draws the path again every time a step of it fails, and does so for as
 * long as it is given. The most redraws with no headway between them (no new cell entered, nothing dug, nothing laid) before the stop `stuck`.
 */
export const GO_STALLED_REDRAWS = 12;
/** The blocks laid that the world does not show before the stop `stuck` (the server refuses the place: one is enough, the next step would be onto it). */
export const GO_REFUSED_PLACES = 1;
/**
 * Run 45 (hold 2, q78 go 9 up out of a dip: 34 s pushed back by flowing water at the same step, five drawings of the same way): a cell the body
 * could not get into (stuck before it) costs this much more to step into or lay in for the rest of the go, so the next drawing goes another way
 * when there is one. (A refused place still stops the go at once: drawn again past it, the run 40 bench's body fell five cells.)
 */
export const GO_AVOID_COST = 20;
/**
 * Run 45 (hold 3, q12 go 40 down from y=60): the executor walks each part of a way while its search is still going, and the parts turned from the
 * way down (dig the floor) to the way round over the top (lay a floor) and back: it dug (191,59,188), laid a cobblestone there, dug it again,
 * fell into the cell, and laid there again with the body in it (refused, the go stopped). A cell this go dug costs this much more to lay again,
 * and one it laid this much more to dig again, for the rest of the go: the way goes on as it began, not back over its own work. (Under the 100 at
 * which the route search never breaks a block: still the way when there is no other.)
 */
export const GO_REDO_COST = 60;
/** The most times one go walks the part of a way a search found before its time ran out (each must come 2 m nearer). */
export const GO_PARTIAL_WALKS = 6;
/** The most mendings of a stuck body, without any headway between them, before the stop `stuck`. */
export const GO_REPAIRS = 5;
/** The most levels a climb makes before the way is drawn again. */
const CLIMB_CHUNK = 4;

// ---- the words the planner writes ------------------------------------------------------------------------------------------------------

const STONE = ['stone', 'cobblestone', 'mossy_cobblestone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'cobbled_deepslate', 'blackstone', 'netherrack',
  'end_stone', 'basalt', 'smooth_basalt', 'calcite', 'dripstone_block', 'sandstone', 'red_sandstone', 'terracotta'];
const DIRT = ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'mycelium', 'mud', 'clay', 'rooted_dirt'];
const SAND = ['sand', 'red_sand', 'gravel', 'soul_sand'];
const WOOD = /(?:_log|_wood|_stem|_hyphae|_planks|_fence)$/u;
/** Blocks the body does not break whatever it is told: nothing mined for itself, nothing that is a village's or a player's. */
const NEVER_DIG = /(?:_ore$|^ancient_debris$|^obsidian$|^crying_obsidian$|^bedrock$|^spawner$|^trial_spawner$|^vault$|_door$|_fence_gate$|_trapdoor$|_bed$|^end_portal|^nether_portal$|^barrier$|^command_block|^structure_block$|^reinforced_deepslate$|^farmland$|^budding_amethyst$)/u;
/** Blocks that fall when what holds them is gone: never laid as a bridge or a step, dug under with care. */
const FALLING = /^(?:sand|red_sand|gravel|suspicious_sand|suspicious_gravel|anvil|chipped_anvil|damaged_anvil|dragon_egg|pointed_dripstone|.*_concrete_powder)$/u;
/** Made by people: left alone near a villager. */
const VILLAGE_MADE = /(?:_planks|_fence|_slab|_stairs|_door|_trapdoor|_bed|glass|glass_pane|bookshelf|hay_block|_wall|bricks|_wool|_carpet|lantern)$/u;
const VILLAGE_REACH = 40;
/** Standing beside these hurts (a step into a cell next to one is not taken). */
const BESIDE_HAZARD = new Set(['lava', 'magma_block', 'cactus', 'fire', 'soul_fire']);

export interface DigRule {
  /** The block names that may be dug. */
  names: Set<string>;
  /** Words given that mean nothing (unknown, or never dug): said when a way is not found. */
  ignored: string[];
}

/** The kinds `canDig` allows: the words stone, dirt, sand and wood, and block ids; never the blocks that are never dug. */
export function digRuleOf(registry: any, words: string[] | undefined): DigRule {
  const names = new Set<string>();
  const ignored: string[] = [];
  const known = (name: string) => !!registry?.blocksByName?.[name];
  const add = (name: string) => { if (known(name) && !NEVER_DIG.test(name) && !PROTECTED_UTILITY_BLOCKS.has(name)) names.add(name); };
  for (const raw of words ?? []) {
    const word = String(raw).replace(/^minecraft:/u, '').toLowerCase();
    if (word === 'stone') STONE.forEach(add);
    else if (word === 'dirt') DIRT.forEach(add);
    else if (word === 'sand') SAND.forEach(add);
    else if (word === 'wood') Object.keys(registry?.blocksByName ?? {}).filter(name => WOOD.test(name)).forEach(add);
    else if (known(word) && !NEVER_DIG.test(word) && !PROTECTED_UTILITY_BLOCKS.has(word) && word !== 'water' && word !== 'lava') names.add(word);
    else ignored.push(word);
  }
  return { names, ignored };
}

/** The blocks of `canPlace` that are whole blocks, are held, and stay where they are put (sand and gravel fall), in the order given. */
export function placeNamesOf(bot: any, words: string[] | undefined): { held: string[]; missing: string[]; refused: string[] } {
  const held: string[] = [], missing: string[] = [], refused: string[] = [];
  for (const raw of words ?? []) {
    const name = String(raw).replace(/^minecraft:/u, '').toLowerCase();
    const block = bot.registry?.blocksByName?.[name];
    if (!block || block.boundingBox !== 'block' || FALLING.test(name) || PROTECTED_UTILITY_BLOCKS.has(name) || /(?:tnt|_bed|_door|chest|furnace|spawner)$/u.test(name)) { refused.push(name); continue; }
    if (inventoryCount(bot, name) > 0) { if (!held.includes(name)) held.push(name); } else missing.push(name);
  }
  return { held, missing, refused };
}

// ---- the hand's arguments (the contract's checks, the same as the head's `actProblem` for go) ------------------------------------------

/** What is wrong with a go hand's fields (the head checks the same before the body sees it), or null. */
export function goProblem(hand: Record<string, unknown>, cellOk: (spec: unknown) => boolean = () => true): string | null {
  const to = hand.to, goalList = hand.goals;
  if ((to === undefined) === (goalList === undefined)) return 'to か goals のどちらか 1 つが要る（両方・無しは断る）';
  if (goalList !== undefined && (!Array.isArray(goalList) || goalList.length < 2 || goalList.length > 8)) return 'goals は 2〜8 個';
  if (to !== undefined && !cellOk(to)) return 'to のマスが読めない';
  if (Array.isArray(goalList) && !goalList.every(cellOk)) return 'goals のマスが読めない';
  const num = (key: string, min: number, max: number, integer = false) => {
    const value = hand[key];
    if (value === undefined) return null;
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)) ? null : `${key} は ${min}〜${max}${integer ? ' の整数' : ''}`;
  };
  const names = (key: string, max: number) => {
    const value = hand[key];
    if (value === undefined) return null;
    if (!Array.isArray(value) || value.length < 1 || value.length > max) return `${key} は 1〜${max} 個（書かなければ「しない」）`;
    return value.every(name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,39}$/u.test(name)) ? null : `${key} の名前は小文字のブロック id`;
  };
  return num('range', 0, 4) ?? num('seconds', 5, 120) ?? num('maxDrop', 0, 10, true) ?? num('maxDig', 0, 200, true) ?? num('maxPlace', 0, 100, true)
    ?? names('canDig', 12) ?? names('canPlace', 6);
}

// ---- the ground (hazards, water, what may be dug) ----------------------------------------------------------------------------------------

const nameAt = (bot: any, x: number, y: number, z: number): string | null => {
  try { return bot.blockAt?.(new Vec3(x, y, z), false)?.name ?? null; } catch { return null; }
};
const isWaterName = (name: string | null) => name === 'water' || name === 'bubble_column' || name === 'kelp' || name === 'seagrass' || name === 'tall_seagrass' || name === 'kelp_plant';

/** Why a body must not stand with its feet at this cell (the contract's hazards that cannot be lifted), or null. */
export function hazardAtFeet(bot: any, x: number, y: number, z: number): string | null {
  return hazardAtFeetWith((cx, cy, cz) => nameAt(bot, cx, cy, cz), x, y, z);
}
/** The same, reading the cells through `read` (the route search's own reader, which keeps what it has read during a search). */
export function hazardAtFeetWith(read: (x: number, y: number, z: number) => string | null, x: number, y: number, z: number): string | null {
  const feet = read(x, y, z), head = read(x, y + 1, z), floor = read(x, y - 1, z);
  for (const name of [feet, head]) if (name && NO_ENTER.has(name)) return `${name} の中`;
  if (floor === 'magma_block') return '足元が magma_block';
  if (read(x, y + 2, z) === 'lava') return '頭の上が溶岩';
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) {
    const beside = read(x + dx, y + dy, z + dz);
    if (beside && BESIDE_HAZARD.has(beside)) return `${beside} の隣`;
  }
  return null;
}

// ---- what the route search has read (run 41) -------------------------------------------------------------------------------------------

/**
 * Run 41 (2026-10-27, replayed on its own ground in the lab): 8 of 13 "no way" stops were the search running out of its 5 s, not a shut way
 * (given 30 s it found the way: 8,326 and 18,232 nodes). A node cost about 1.5 ms, 96 % of it making the moves round it, most of that reading
 * the same cells again and again (`bot.blockAt` builds a new Block at every call, and the hazard and water rules read twelve more cells per move).
 * Keeping what was read for as long as the world does not change there made the same search 3.4 times quicker (662 -> 2,653 nodes a second).
 * A cell is read again once the server has changed it (`blockUpdate`), and everything is read again when chunks come or go.
 */
interface WorldWatch { epoch: number; tick: number; changed: Map<string, number> }
const worldWatches = new WeakMap<object, WorldWatch>();
const WATCH_MAX_CHANGED = 20_000;
const READ_CACHE_MAX = 250_000;
export function worldWatchOf(host: any): WorldWatch {
  let watch = worldWatches.get(host);
  if (!watch) {
    const made: WorldWatch = { epoch: 0, tick: 0, changed: new Map() };
    worldWatches.set(host, made);
    host.on?.('blockUpdate', (before: any, after: any) => {
      const p = after?.position ?? before?.position;
      if (!p) return;
      made.tick++;
      made.changed.set(`${p.x},${p.y},${p.z}`, made.tick);
      if (made.changed.size > WATCH_MAX_CHANGED) { made.changed.clear(); made.epoch++; }
    });
    for (const event of ['chunkColumnLoad', 'chunkColumnUnload']) host.on?.(event, () => { made.epoch++; made.changed.clear(); });
    watch = made;
  }
  return watch;
}
/**
 * Makes a movement profile keep the blocks it reads (its body's `blockAt`) until the world changes at that cell. The profile's own `getBlock`
 * still runs at every read: it sets the block's walking properties afresh each time (and a move may change them for its own sum, as the jump up
 * does to the height), so only the reading of the world is kept, never what was made of it. Returns a name reader over the same keep.
 */
export function keepReads(movements: any, watch: WorldWatch): (x: number, y: number, z: number) => string | null {
  const body = movements.bot;
  const kept = new Map<string, { block: any; tick: number }>();
  let epoch = watch.epoch;
  const blockAt = (position: any, extraInfos?: boolean) => {
    if (!position) return body.blockAt(position, extraInfos);
    if (watch.epoch !== epoch || kept.size > READ_CACHE_MAX) { kept.clear(); epoch = watch.epoch; }
    const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z), key = `${x},${y},${z}`;
    const hit = kept.get(key);
    if (hit && (watch.changed.get(key) ?? 0) <= hit.tick) return hit.block;
    const block = body.blockAt(position, extraInfos);
    // A cell not loaded is not kept: it may arrive at any moment.
    if (block) kept.set(key, { block, tick: watch.tick });
    return block;
  };
  movements.bot = new Proxy(body, { get: (target, key) => (key === 'blockAt' ? blockAt : Reflect.get(target, key)) });
  return (x, y, z) => blockAt(new Vec3(x, y, z), false)?.name ?? null;
}

/** A route drawn without walking it: the search's status, its nodes, and the cells it breaks (by block name) and fills. */
interface Plan { status: string; path: any[]; digs: Map<string, number>; places: number; visited: number }
const yieldNow = () => new Promise<void>(resolve => setImmediate(resolve));

interface Relax { hazards?: boolean; tool?: boolean; blocks?: boolean; permissions?: boolean; limits?: boolean }
export interface GoState {
  steps: number; dug: number; placed: number; redraws: number;
  veto: { code: string; text: string } | null;
  /** The blocks laid in a row that the world did not show. */
  refused: number;
  /** Run 45: the cells this go could not get into or lay in ("x,y,z"), avoided by the next drawings (`GO_AVOID_COST`). */
  avoid: Set<string>;
  /** Run 45 (hold 3): the cells this go dug, and those it laid ("x,y,z"): not laid again, not dug again (`GO_REDO_COST`). */
  dugCells: Set<string>;
  laidCells: Set<string>;
}

// ---- the movements ---------------------------------------------------------------------------------------------------------------------

export function goMovements(bot: any, args: Required<Pick<GoArgs, 'maxDrop' | 'waterOk' | 'maxDig' | 'maxPlace'>> & { sprint: boolean }, rule: DigRule, placeHeld: string[], state: GoState, relax: Relax = {}): any {
  const mayDigAny = rule.names.size > 0 || !!relax.permissions;
  const mayPlaceAny = placeHeld.length > 0 || !!relax.blocks || !!relax.permissions;
  const movements = buildMovements(bot, false, args.sprint, true, true, mayDigAny, true, 1, false, args.waterOk, args.maxDrop, args.waterOk ? 4 : 10, mayPlaceAny, 2);
  movements.maxDropDown = args.maxDrop + 1;
  movements.infiniteLiquidDropdownDistance = args.waterOk;
  installDoorRules(movements);
  const registry = bot.registry;
  // Hazards: never entered, never dug into, whatever else is allowed.
  // (The route search avoids lava and fire of itself; lifting the hazards, to find out whether they are what shuts the way, lifts that too.)
  for (const name of NO_ENTER) {
    const id = registry.blocksByName[name]?.id;
    if (typeof id === 'number') { if (relax.hazards) movements.blocksToAvoid.delete(id); else movements.blocksToAvoid.add(id); }
  }
  // What may be dug: the allowed kinds, as far as the limit allows, with a tool that breaks them, away from the village.
  const villagers = Object.values(bot.entities ?? {}).filter((entity: any) => entity?.name === 'villager' && entity.position) as any[];
  const nearVillage = (position: Vec3) => villagers.some(entity => entity.position.distanceTo(position) <= VILLAGE_REACH);
  const items = () => (bot.inventory?.items?.() ?? []) as any[];
  const permitted = (block: any): boolean => {
    const name = String(block?.name ?? '');
    if (!name) return false;
    if (relax.permissions) { if (NEVER_DIG.test(name) || PROTECTED_UTILITY_BLOCKS.has(name) || NO_ENTER.has(name) || name === 'water' || name === 'lava') return false; }
    else if (!rule.names.has(name)) return false;
    if (VILLAGE_MADE.test(name) && block.position && nearVillage(block.position)) return false;
    if (!relax.tool && block.harvestTools && !items().some(item => canHarvest(block, item))) return false;
    return true;
  };
  const safeToBreak = movements.safeToBreak.bind(movements);
  movements.safeToBreak = (block: any) => permitted(block) && (relax.limits || state.dug < args.maxDig) && safeToBreak(block);
  // What may be laid: the allowed blocks the pack holds, in the order the planner gave.
  if (relax.blocks || relax.permissions) {
    movements.countScaffoldingItems = () => 64;
    movements.getScaffoldingItem = () => null;
  } else {
    const ids = placeHeld.map(name => registry.itemsByName?.[name]?.id).filter((id): id is number => typeof id === 'number');
    movements.scafoldingBlocks = state.placed >= args.maxPlace && !relax.limits ? [] : ids;
  }
  // Every read of the search, the movements' own and the rules' below, goes through one keep (run 41: 3.4 times the nodes a second).
  const read = keepReads(movements, worldWatchOf(nativeActionHost(bot)));
  // Run 45 (hold 2): the cells this go could not get into or lay in cost more (another way first, this one still when there is no other).
  if (state.avoid.size) {
    const avoided = (block: any) => (block?.position && state.avoid.has(`${block.position.x},${block.position.y},${block.position.z}`) ? GO_AVOID_COST : 0);
    movements.exclusionAreasStep = [...(movements.exclusionAreasStep ?? []), avoided];
    movements.exclusionAreasPlace = [...(movements.exclusionAreasPlace ?? []), avoided];
  }
  // Run 45 (hold 3): what this go dug is not laid again, what it laid is not dug again (the way does not undo its own work).
  movements.exclusionAreasBreak = [...(movements.exclusionAreasBreak ?? []), (block: any) => redoCost(state.laidCells, block)];
  // (mineflayer-pathfinder's walk forward onto a laid floor asks the place's exclusion of the cell above the one it lays: both are asked.)
  movements.exclusionAreasPlace = [...(movements.exclusionAreasPlace ?? []), (block: any) => redoCost(state.dugCells, block, true)];
  // Moves that end in a hazard (beside lava, on magma...), or in water when it is not allowed, are not moves.
  const getNeighbors = movements.getNeighbors.bind(movements);
  const inWater = isWaterName(nameAt(bot, Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z)));
  movements.getNeighbors = (node: any) => (getNeighbors(node) as any[]).filter(move => {
    if (!relax.hazards && hazardAtFeetWith(read, move.x, move.y, move.z)) return false;
    if (!args.waterOk && !inWater && (isWaterName(read(move.x, move.y, move.z)) || isWaterName(read(move.x, move.y + 1, move.z)))) return false;
    return true;
  });
  return movements;
}

// ---- the work ----------------------------------------------------------------------------------------------------------------------------

const distanceTo = (bot: any, cell: Cell) => Math.hypot(bot.entity.position.x - (cell.x + 0.5), bot.entity.position.y - cell.y, bot.entity.position.z - (cell.z + 0.5));
const goalOf = (cell: Cell, range: number) => range > 0 ? new goals.GoalNear(cell.x + 0.5, cell.y, cell.z + 0.5, range) : new goals.GoalBlock(cell.x, cell.y, cell.z);
const compositeOf = (cells: Cell[], range: number) => cells.length === 1 ? goalOf(cells[0], range) : new goals.GoalCompositeAny(cells.map(cell => goalOf(cell, range)));
const keyOf = (cell: Cell) => `${cell.x},${cell.y},${cell.z}`;
/** GO_REDO_COST for a block in `cells` (the cells this go dug, or laid), or with `below` for the one under it too, else 0. */
export function redoCost(cells: ReadonlySet<string>, block: any, below = false): number {
  const p = block?.position;
  if (!p || !cells.size) return 0;
  return cells.has(`${p.x},${p.y},${p.z}`) || (below && cells.has(`${p.x},${p.y - 1},${p.z}`)) ? GO_REDO_COST : 0;
}
/** How far a body steps back out of a cell a block is to be laid in (it never steps back more: a body far in is not moved). */
const CLEAR_MAX_M = 0.35;
/**
 * The body moved out of `cell` (it stands a little into it across: a block laid there is refused), straight away from the cell's middle, for at
 * most 300 ms, and only when that is at most CLEAR_MAX_M; the walk's own keys are left as they were. True when it is clear (or was).
 */
export async function clearOfCell(bot: any, cell: Cell): Promise<boolean> {
  const p = bot.entity?.position;
  if (!p || bodyOverlap(p, cell) <= 0) return true;
  const dx = p.x - (cell.x + 0.5), dz = p.z - (cell.z + 0.5);
  // The box is 0.6 across: out of the cell along x when |dx| >= 0.8, or along z when |dz| >= 0.8; the shorter way.
  const needX = Math.max(0, 0.8 - Math.abs(dx)), needZ = Math.max(0, 0.8 - Math.abs(dz));
  const alongX = needX <= needZ;
  if (Math.min(needX, needZ) > CLEAR_MAX_M) return false;
  const away = alongX ? { x: Math.sign(dx) || 1, z: 0 } : { x: 0, z: Math.sign(dz) || 1 };
  const keys = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
  const before = Object.fromEntries(keys.map(key => [key, !!bot.controlState?.[key]]));
  try {
    for (const key of keys) bot.setControlState?.(key, false);
    await bot.look?.(Math.atan2(-away.x, -away.z), 0, true);
    bot.setControlState?.('sneak', true);
    bot.setControlState?.('forward', true);
    const until = Date.now() + 300;
    while (Date.now() < until && bot.entity?.position && bodyOverlap(bot.entity.position, cell) > 0) await new Promise(resolve => setTimeout(resolve, 25));
  } catch { /* the place goes on as it was */ }
  finally {
    for (const key of keys) { try { bot.setControlState?.(key, before[key]); } catch { /* released */ } }
  }
  return !bot.entity?.position || bodyOverlap(bot.entity.position, cell) <= 0;
}
/** The cell of a route after the one nearest the body (where it was going), or null. */
export function aheadOf(route: readonly Cell[], at: { x: number; y: number; z: number } | undefined): Cell | null {
  if (!route.length || !at) return null;
  let nearest = 0, best = Infinity;
  route.forEach((cell, index) => {
    const d = Math.hypot(cell.x + 0.5 - at.x, cell.y - at.y, cell.z + 0.5 - at.z);
    if (d < best) { best = d; nearest = index; }
  });
  const here = { x: Math.floor(at.x), y: Math.floor(at.y + 1e-3), z: Math.floor(at.z) };
  const next = route[nearest]!.x === here.x && route[nearest]!.y === here.y && route[nearest]!.z === here.z ? route[nearest + 1] : route[nearest];
  return next ?? null;
}
/** The plain no-collision blocks a body is in, not on: a floor is never one, and the walk goes through them (air, liquids, climbing plants). */
const THROUGH = /^(air|cave_air|void_air|water|lava|bubble_column|ladder|vine|scaffolding|cave_vines(_plant)?|twisting_vines(_plant)?|weeping_vines(_plant)?)$/u;
/**
 * Run 44 (hold 1, q51 「畑へ上る」 go to (216,66,206)): a place whose floor is a plant with no box (a pumpkin stem on farmland, a crop, a flower,
 * grass) that the go may not dig: nobody stands on it and no block goes into its cell. The search ran its 5 s out on it, the walk went for a cell
 * one too low (the farmland's own), jumped 5 s in a trapdoor's cell, and the stop blamed a pillar's level. Said at once instead, with the cell
 * under it when that one is where a body stands. Null when the floor is a block, air (a bridge or a pillar lays it), a liquid or a climbable, or
 * may be dug.
 */
export function floorlessAt(bot: any, cell: Cell, rule: Pick<DigRule, 'names'>, placing = true): string | null {
  const under = { x: cell.x, y: cell.y - 1, z: cell.z };
  const floor = blockAt(bot, under);
  if (!floor || floor.boundingBox !== 'empty') return null;
  const name = String(floor.name).replace(/^minecraft:/u, '');
  if (AIR.test(name)) return placing ? null : midAirWords(bot, cell, under);
  if (THROUGH.test(name) || rule.names.has(name)) return null;
  const lower = blockAt(bot, { x: cell.x, y: cell.y - 2, z: cell.z });
  const stand = lower && lower.boundingBox === 'block' && !isDoorlike(String(lower.name));
  return `行き先 ${cellText(cell)} の足元 ${cellText(under)} は ${name} で床にならない（立てない・置けない）`
    + (stand ? `。${cellText(under)} なら ${String(lower.name).replace(/^minecraft:/u, '')} の上に立てる` : '');
}

const AIR = /^(air|cave_air|void_air)$/u;
/** How far down a place in the air is looked under for its floor. */
const FLOOR_LOOK = 24;
/**
 * Run 45 (hold 1, q15 go to (163,10,229), 56 down from the surface, no canPlace): the place was in the air of a lush cave, its floor more than 12
 * below. Nobody stands there and nothing may be laid under it: the go dug 61 blocks in 85 s toward it, every search to it ran its 5 s out (no way
 * exists: 60,000 nodes in 90 s in the lab), and the stop said search_timeout. Said at once instead: where the floor is under it, and the nearest
 * cell around it a body stands in.
 */
function midAirWords(bot: any, cell: Cell, under: Cell): string {
  let floorY: number | null = null, met = '';
  for (let y = under.y - 1; y >= under.y - FLOOR_LOOK; y--) {
    const block = blockAt(bot, { x: cell.x, y, z: cell.z });
    if (!block) break;
    if (block.boundingBox === 'block') { floorY = y; break; }
    if (/^(water|lava)$/u.test(String(block.name))) { met = String(block.name); break; }
  }
  const read: BlockReader = (x, y, z) => { const block = blockAt(bot, { x, y, z }); return block ? mapBlockOf(block) : null; };
  let near: Cell | null = null;
  for (const d of NEAR_OFFSETS) {
    const at = { x: cell.x + d[0], y: cell.y + d[1], z: cell.z + d[2] };
    if (standable(read, at.x, at.y, at.z)) { near = at; break; }
  }
  const below = floorY !== null ? `床は y=${floorY}（${under.y - floorY} 段下）` : met ? `下は ${met}` : `${FLOOR_LOOK} 段下まで床が無い`;
  return `行き先 ${cellText(cell)} は宙（足元 ${cellText(under)} から下が空気、${below}）。置く物（canPlace）が無いので立てない`
    + (near ? `。近くの立てる所 ${cellText(near)}` : '') + (floorY !== null ? `。床の上なら ${cellText({ x: cell.x, y: floorY + 1, z: cell.z })}` : '');
}
/** The cells around a place, nearest first (within 2 across, 2 up and 3 down). */
const NEAR_OFFSETS: ReadonlyArray<readonly [number, number, number]> = (() => {
  const out: Array<[number, number, number]> = [];
  for (let dx = -2; dx <= 2; dx++) for (let dy = -3; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) if (dx || dy || dz) out.push([dx, dy, dz]);
  return out.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
})();

/** Whether the block just laid against `reference` on `face` shows in the world (the cell beside it is no longer air), looked at for a moment as the update may come late. */
/** The cell a place of `reference` on `face` fills. */
function placedCell(reference: any, face: any): Cell | null {
  const base = reference?.position;
  if (!base || !face) return null;
  return { x: Math.floor(base.x + face.x), y: Math.floor(base.y + face.y), z: Math.floor(base.z + face.z) };
}
async function laidAt(host: any, reference: any, face: any): Promise<boolean> {
  const base = reference?.position, dir = face;
  if (!base || !dir) return true;
  const at = new Vec3(Math.floor(base.x + dir.x), Math.floor(base.y + dir.y), Math.floor(base.z + dir.z));
  for (let tries = 0; tries < 4; tries++) {
    const block = host.blockAt?.(at, false);
    if (!block || !isAirLike(block)) return true;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  return false;
}

export async function go(ctx: StepContext, args: GoArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const nav = bot.pathfinder as any;
  if (!nav) return stopped(bot, 'no_pathfinder', '経路探索が無い体');
  const cells = (args.goals ?? []).slice(0, 8);
  if (!cells.length) return stopped(bot, 'invalid_input', 'go には to か goals が要る');
  const limits = {
    range: args.range ?? GO_DEFAULTS.range, maxDrop: args.maxDrop ?? GO_DEFAULTS.maxDrop, waterOk: args.waterOk === true, maxDig: args.maxDig ?? GO_DEFAULTS.maxDig,
    maxPlace: args.maxPlace ?? GO_DEFAULTS.maxPlace, sprint: args.sprint === true,
  };
  const startedAt = Date.now();
  const deadline = Math.min(ctx.deadline, startedAt + (args.seconds ?? GO_DEFAULTS.seconds) * 1000);
  const rule = digRuleOf(bot.registry, args.canDig);
  const searchCap = args.searchMs ?? 5000;
  const place = placeNamesOf(bot, args.canPlace);
  const state: GoState = { steps: 0, dug: 0, placed: 0, redraws: 0, veto: null, refused: 0, avoid: new Set(), dugCells: new Set(), laidCells: new Set() };
  const start = feetCell(bot)!;

  // ---- how a line ends (the contract's result lines) ----
  const tail = () => `${cellText(feetCell(bot) ?? start)} 道 ${state.steps} 歩・掘 ${state.dug}・置 ${state.placed}・引き直し ${state.redraws} 回`;
  const fail = (code: string, why: string, hint: string): StepOutcome => {
    const at = feetCell(bot) ?? start;
    const head = `go 止まった ${code}: `;
    const fixed = ` ${tail()}`;
    // The contract's line: the code, the reason, where and the counts, then the hint; what does not fit of the 160 is cut from the back (the hint first).
    const room = 160 - head.length - fixed.length;
    const withHint = hint ? `。${hint}` : '';
    const text = why.length + withHint.length <= room ? `${head}${why}${fixed}${withHint}` : `${head}${clip(why, Math.max(24, room))}${fixed}`;
    return { ...stopped(bot, code, text, at, start), data: { work: { dug: state.dug, placed: state.placed, steps: state.steps, redraws: state.redraws } } };
  };
  const arrived = (): StepOutcome => ({ ok: true, text: `go 着いた ${tail()}`, at: feetCell(bot) ?? start,
    data: { work: { dug: state.dug, placed: state.placed, steps: state.steps, redraws: state.redraws } } });

  // ---- the places: the ones nobody may stand in are dropped; none left is `unsafe` ----
  const safeCells = cells.filter(cell => !hazardAtFeet(bot, cell.x, cell.y, cell.z));
  if (!safeCells.length) {
    const why = hazardAtFeet(bot, cells[0].x, cells[0].y, cells[0].z) ?? '危ない';
    return fail('unsafe', `行き先 ${cellText(cells[0])} は${why}（溶岩・火・マグマ・サボテン・ベリー・ウィザーローズとその隣には行かない）`, '別の行き先を');
  }
  // Run 44 (hold 1): a place over a plant nobody stands on is said at once (`floorlessAt`); one place of several that is such is dropped.
  // Run 45 (hold 1): a place in the air with nothing to lay under it (no canPlace held) is said at once too.
  const placing = place.held.length > 0;
  const grounded = limits.range < 1 ? safeCells.filter(cell => !floorlessAt(bot, cell, rule, placing)) : safeCells;
  if (!grounded.length) {
    const why = floorlessAt(bot, safeCells[0], rule, placing)!;
    return fail('no_floor', why, /なら .* の上に立てる$/u.test(why) ? 'その 1 つ下を行き先に' : /^行き先 .* は宙/u.test(why) ? '立てる所を行き先に（宙へ渡るなら canPlace）' : '別の行き先を');
  }
  const targets = grounded;
  const near = (): Cell => targets.reduce((best, cell) => (distanceTo(bot, cell) < distanceTo(bot, best) ? cell : best), targets[0]);
  const reached = () => atGoal(bot, compositeOf(targets, limits.range));
  if (reached()) return arrived();

  // ---- the watchers: cells entered, blocks dug, blocks laid ----
  let lastCell = keyOf(start), manualBusy = false;
  // Run 43: the feet's heights of the last 1.5 s, for the top of a jump said with a refused place.
  const heights: Array<[number, number]> = [];
  const topOfJump = (): number | null => {
    const since = Date.now() - 1500;
    const recent = heights.filter(([at]) => at >= since).map(([, y]) => y);
    return recent.length ? Math.max(...recent) : null;
  };
  const onTick = () => {
    try {
      const y = Number(bot.entity?.position?.y);
      if (Number.isFinite(y)) { heights.push([Date.now(), y]); if (heights.length > 40) heights.shift(); }
      const feet = feetCell(bot);
      if (!feet) return;
      const key = keyOf(feet);
      if (key !== lastCell) { lastCell = key; state.steps++; if (state.steps % 4 === 0) ctx.progress?.(`${state.steps}歩・掘${state.dug}・置${state.placed}`); }
    } catch { /* a count is never the stop */ }
  };
  bot.on?.('physicsTick', onTick);
  // Digs and blocks laid are counted at the body's own calls (by whoever makes them: the route executor, or this hand). The 'diggingCompleted'
  // event is not used: the route executor, once it has reset a path while digging, removes every listener of it (removeAllListeners).
  let lastWork = Date.now();
  // Run 40 (2026-10-27, the place that was refused 65 times of 68 with "Motor owner expired"): the counting is put on the HOST body, never on the act's motor port.
  // `bot` is a Proxy that hands out a fresh wrapper for every function it is asked for, so what was read from it was the port's wrapper (checking THIS act's owner),
  // assigned back onto the host, and never put back (`bot.dig === countingDig` is false for a Proxy): every later place and dig of the body ran through a
  // port whose act was long over. The host's own functions are read, counted and put back by identity.
  const host = nativeActionHost(bot) as any;
  const originalDig = host.dig, originalPlace = host.placeBlock;
  let counting = true;
  const countingDig = async function (this: unknown, ...rest: unknown[]) {
    const at = (rest[0] as { position?: { x: number; y: number; z: number } } | undefined)?.position;
    const result = await originalDig.apply(host, rest);
    if (counting) { state.dug++; lastWork = Date.now(); if (at) state.dugCells.add(`${at.x},${at.y},${at.z}`); }
    return result;
  };
  /** A block the server did not take is not a floor: the route executor is not let walk on (run 40 bench: go went on over a refused place and fell four cells). */
  const refusedPlace = (facts = '', cell: Cell | null = null) => {
    blackBoxOf(host)?.note('refused_place', { n: state.refused + 1, facts: facts.slice(0, 200), ...(cell ? { avoid: [cell.x, cell.y, cell.z] } : {}) });
    if (cell) state.avoid.add(keyOf(cell));
    if (++state.refused >= GO_REFUSED_PLACES && !state.veto) {
      state.veto = { code: 'stuck', text: `置いたブロックが世界に現れない（サーバーが置きを断った。${state.refused} 回${facts ? `。${facts}` : ''}）` };
      try { nav.setGoal?.(null); } catch { /* stopped below */ }
    }
    // The body is stopped where it stands at once: the next step of the route would be onto the block that is not there.
    letGo(bot);
  };
  const countingPlace = async function (this: unknown, ...rest: unknown[]) {
    let result: unknown;
    // Run 45 (hold 2, the lab, three times out of three): the route laid a block to step up onto in the cell before the feet while the body
    // stood 0.1 into that cell (overlap 0.91): the server refused it and the go stopped. The body steps back out of the cell first.
    const target = counting ? placedCell(rest[0], rest[1]) : null;
    if (target) await clearOfCell(host, target);
    const at = host.entity?.position?.clone?.() ?? null;
    const facts = () => { const cell = placedCell(rest[0], rest[1]); return cell ? placeFacts(host, cell, topOfJump(), at ?? undefined) : ''; };
    try { result = await originalPlace.apply(host, rest); }
    catch (error) {
      // The library gives up when the server's update does not come: that too is a place the server did not take (an interruption is not).
      if (counting && !/Action interrupted|Motor owner expired/u.test(String((error as Error)?.message))) refusedPlace(facts(), placedCell(rest[0], rest[1]));
      throw error;
    }
    if (!counting) return result;
    if (await laidAt(host, rest[0], rest[1])) {
      state.placed++; lastWork = Date.now(); state.refused = 0;
      const laid = placedCell(rest[0], rest[1]);
      if (laid) state.laidCells.add(keyOf(laid));
      return result;
    }
    refusedPlace(facts(), placedCell(rest[0], rest[1]));
    throw new Error('The place was not taken');
  };
  if (typeof originalDig === 'function') host.dig = countingDig;
  if (typeof originalPlace === 'function') host.placeBlock = countingPlace;
  // A drawing again: the path was reset because something went wrong with it (not for the block it dug itself, nor a chunk arriving).
  let stalledKey = '', stalledResets = 0;
  const onReset = (reason: unknown) => {
    if (/^(?:goal_updated|movements_updated|block_updated|chunk_loaded)$/u.test(String(reason))) return;
    state.redraws++;
    // A redraw with no headway since the last one is counted; past the most the way is given up (the stop comes at the next look, `vetoed`).
    const key = `${state.steps}/${state.dug}/${state.placed}`;
    if (key !== stalledKey) { stalledKey = key; stalledResets = 0; return; }
    if (++stalledResets >= GO_STALLED_REDRAWS && !state.veto) {
      state.veto = { code: 'stuck', text: `道を ${stalledResets} 回引き直しても 1 歩も・1 マスも進まない（経路の実行が断られている）` };
      try { nav.setGoal?.(null); } catch { /* stopped below */ }
    }
  };
  bot.on?.('path_reset', onReset);
  const previousMovements = nav.movements;
  const hostNav = host.pathfinder as any;
  const previousTool = hostNav.bestHarvestTool;
  // The cheapest tool in time and wear (utils/toolChoice), not the fastest in the bag; one that is nearly broken is kept for when nothing else will do.
  // Kept by the block's state for one drawing of the way (run 41: the search asks for every block it may break), and forgotten when the pack changes.
  const toolKept = new Map<string, any>();
  const forgetTools = () => toolKept.clear();
  host.inventory?.on?.('updateSlot', forgetTools);
  hostNav.bestHarvestTool = (block: any) => {
    const key = String(block?.stateId ?? block?.type ?? block?.name);
    if (toolKept.has(key)) return toolKept.get(key);
    const tools = ((bot.inventory?.items?.() ?? []) as any[]);
    const sound = tools.filter(item => !nearlyBroken(item));
    const chosen = chooseTool(block, sound.length || !tools.length ? sound : tools, { effects: bot.entity?.effects }) ?? null;
    toolKept.set(key, chosen);
    return chosen;
  };

  const movementsFor = (relax: Relax = {}) => goMovements(bot, limits, rule, place.held, state, relax);
  const timeLeft = () => deadline - Date.now();
  const limitStop = (): StepOutcome | null => {
    if (timeLeft() <= 0) return fail('limit_time', `${args.seconds ?? GO_DEFAULTS.seconds} 秒の上限に着いた（行き先まで あと ${near() ? distanceTo(bot, near()).toFixed(0) : '?'}m）`, 'seconds を増やすか、行き先を近くに');
    return null;
  };
  /** The cells a route breaks and fills against what is left of the limits: the stop, or null. A route over the limit is not begun. */
  const budgetOf = (digs: number, places: number): { code: string; text: string } | null => {
    if (state.dug + digs > limits.maxDig) return { code: 'limit_dig', text: `この道は掘る所が ${digs} あり、上限 ${limits.maxDig} の残り ${Math.max(0, limits.maxDig - state.dug)} を超える` };
    if (state.placed + places > limits.maxPlace) return { code: 'limit_place', text: `この道は置く所が ${places} あり、上限 ${limits.maxPlace} の残り ${Math.max(0, limits.maxPlace - state.placed)} を超える` };
    return null;
  };
  /** A look at the route the executor is given (its own drawing, not ours): over the limit, it is stopped before it digs. */
  let lastRoute: Cell[] = [];
  const watchRoute = (route: any[]) => {
    lastRoute = route.slice(0, 32).map(node => nodeCell(node));
    let digs = 0, places = 0;
    for (const node of route) { digs += node?.toBreak?.length ?? 0; places += node?.toPlace?.length ?? 0; }
    state.veto = budgetOf(digs, places);
    if (state.veto) { try { nav.setGoal?.(null); } catch { /* stopped below */ } }
  };
  const VETO_HINTS: Record<string, string> = { limit_dig: 'maxDig を増やすか、別の道を', limit_place: 'maxPlace を増やすか、別の道を', stuck: '別の道か別の行き先を（同じ手の繰り返しは同じ所で止まる）' };
  const vetoed = (): StepOutcome | null => state.veto ? fail(state.veto.code, state.veto.text, VETO_HINTS[state.veto.code] ?? '別の道を') : null;

  const notes: WayNotes = { opened: [], leaves: 0 };
  // Work that holds the body still on purpose: its own dig or climb, or the executor digging or laying, as long as something has been dug or laid in the last 5 s.
  const busy = () => manualBusy || ((!!nav.isMining?.() || !!nav.isBuilding?.()) && Date.now() - lastWork < 5000);

  /** The route found without walking it: its status and the cells it breaks and fills. */
  const plan = async (movements: any, goal: any, ms: number): Promise<Plan> => {
    toolKept.clear();
    const generator = nav.getPathFromTo(movements, bot.entity.position, goal, { timeout: Math.max(300, Math.min(ms, searchCap)) });
    let result = generator.next().value?.result ?? { status: 'noPath', path: [] };
    // The search answers a tick (40 ms) at a time while it is still going; here it is let finish (its own time bounds it), the body's other work
    // (its packets, its physics, the act's watch) getting its turn between the ticks.
    for (let rounds = 0; result.status === 'partial' && rounds < 2000; rounds++) { await yieldNow(); result = generator.next().value?.result ?? result; }
    const digs = new Map<string, number>();
    let places = 0;
    for (const node of result.path ?? []) {
      for (const cell of node?.toBreak ?? []) { const name = nameAt(bot, cell.x, cell.y, cell.z) ?? '?'; digs.set(name, (digs.get(name) ?? 0) + 1); }
      places += node?.toPlace?.length ?? 0;
    }
    return { status: String(result.status), path: result.path ?? [], digs, places, visited: Number(result.visitedNodes ?? 0) };
  };

  /** The way is shut: look again with each rule lifted in turn, and name the first whose lifting opens it. */
  /** The search ran out of its time: no way is known, nor that there is none. What it saw, and the next hands that do not need the search. */
  const searchedOutStop = (found: Plan, aim: Cell): StepOutcome => {
    const tip = found.path.length ? found.path[found.path.length - 1] : null;
    const tipCell = tip ? nodeCell(tip) : null;
    const reach = tipCell ? `、${cellText(tipCell)} まで・あと ${Math.hypot(tipCell.x - aim.x, tipCell.y - aim.y, tipCell.z - aim.z).toFixed(0)}m` : '';
    return fail('search_timeout', `道探しが ${(searchCap / 1000).toFixed(searchCap < 1000 ? 2 : 0)} 秒で終わらない（道の有無は不明。${found.visited.toLocaleString('en-US')} マス調べた${reach}）`,
      '10m 以内の中継点へ go か、dig と walk の階段・縦穴で');
  };

  const explain = async (goal: any): Promise<StepOutcome> => {
    const ms = Math.min(args.searchMs ?? 2500, Math.max(300, timeLeft() - 500));
    const shown = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => `${name}×${count}`).join('・');
    const ignored = rule.ignored.length ? `（無視した canDig: ${rule.ignored.slice(0, 3).join('・')}）` : '';
    const lifts: Array<[Relax, (found: Plan) => StepOutcome]> = [
      [{ hazards: true }, () => fail('lava', '道の先が溶岩・火・マグマ・サボテンなどで、避けると道が無い', '別の行き先か、別の側から')],
      ...(state.dug >= limits.maxDig || state.placed >= limits.maxPlace ? [[{ limits: true }, () => state.dug >= limits.maxDig
        ? fail('limit_dig', `掘る数の上限 ${limits.maxDig} に着いた（この先にも掘る所がある）`, 'maxDig を増やすか、別の道を')
        : fail('limit_place', `置く数の上限 ${limits.maxPlace} に着いた（この先にも置く所がある）`, 'maxPlace を増やすか、別の道を')] as [Relax, (found: Plan) => StepOutcome]] : []),
      [{ tool: true }, found => fail('no_tool', `${shown(found.digs) || '掘る所'} を掘る道だが、持っている道具では掘れない`, 'ツルハシなどを手に入れるか、別の道を')],
      ...(args.canPlace?.length ? [[{ blocks: true }, (found: Plan) => fail('no_blocks',
        `置く物が足りない（置く所 ${found.places}、持っている ${place.held.map(name => `${name}×${inventoryCount(bot, name)}`).join('・') || '無し'}${place.missing.length ? `、持っていない ${place.missing.join('・')}` : ''}${place.refused.length ? `、置かない ${place.refused.join('・')}` : ''}）`,
        '置ける物を集めるか、canPlace を足す')] as [Relax, (found: Plan) => StepOutcome]] : []),
      [{ permissions: true }, found => fail('dead_end', `許した手では道が無い。${found.digs.size ? `canDig に ${[...found.digs.keys()].slice(0, 3).join('・')} を許せば掘 ${[...found.digs.values()].reduce((a, b) => a + b, 0)} で` : ''}${found.places ? `canPlace を許せば置 ${found.places} で` : ''}道がある${ignored}`, '許すか、別の行き先を')],
    ];
    // The way with the rules as given was searched to its end and is shut (a search that ran out of time never comes here); a lifted search
    // that runs out only leaves the reason unnamed.
    for (const [relax, outcome] of lifts) {
      if (timeLeft() < 800) break;
      let found: Plan | null = null;
      try { found = await plan(movementsFor(relax), goal, ms); } catch { found = null; }
      if (found && found.status === 'success') return outcome(found);
    }
    return fail('dead_end', `掘っても置いても道が無い（行き止まり）${ignored}`, '別の行き先を');
  };

  /** Climbs where the body stands: dig the roof if it may be, lay a block under the feet at the top of the jump, a level at a time. */
  const climb = async (toY: number): Promise<{ levels: number; stop?: StepOutcome }> => {
    let levels = 0, floorDigs = 0;
    while (levels < CLIMB_CHUNK && (feetCell(bot)?.y ?? toY) < toY) {
      if (timeLeft() <= 0) break;
      if (state.placed >= limits.maxPlace) return { levels, stop: fail('limit_place', `置く数の上限 ${limits.maxPlace} に着いた`, 'maxPlace を増やすか、別の道を') };
      const block = place.held.find(name => inventoryCount(bot, name) > 0);
      if (!block) return { levels, stop: fail('no_blocks', `登るのに置く物が無い（${place.missing.length ? `持っていない ${place.missing.join('・')}` : 'canPlace に置ける物が無い'}）`, '置ける物を集めるか、canPlace を足す') };
      // Run 44 (hold 1): the feet are read standing. The climb began while the walk before it still jumped (its last point was lifted onto a
      // trapdoor), the feet read a cell up at y 65.17, and the level was laid for a cell the body was half in (0.80) and no jump reaches.
      if (bot.entity?.onGround === false) await waitUntil(ctx, () => bot.entity?.onGround !== false, 1500);
      let feet = feetCell(bot)!;
      // Run 41 (+1,472, +1,518): a floor lower than the feet cell (a small amethyst bud, a slab) leaves every jump 0.05 short of the laying
      // height. The body moves onto a whole floor beside it, or digs a floor that breaks at once and climbs from the one under it.
      // A body held up at the edge of the cell beside it (its feet cell's floor is air) has nothing under it to lay on: the same move aside.
      const under = blockAt(bot, { x: feet.x, y: feet.y - 1, z: feet.z });
      const short = shortFloor(bot, feet)
        ?? (!under || under.boundingBox !== 'block' || isDoorlike(String(under.name)) ? { cell: { x: feet.x, y: feet.y - 1, z: feet.z }, name: String(under?.name ?? '未ロード'), top: 0, lowBy: 0 } : null);
      if (short) {
        const aside = wholeFloorBeside(bot, feet, cell => !!hazardAtFeet(bot, cell.x, cell.y, cell.z));
        if (aside) {
          manualBusy = true;
          try { await goWith(ctx, new goals.GoalBlock(aside.x, aside.y, aside.z), Math.min(6000, Math.max(500, timeLeft())), notes, { stuckMs: GO_STUCK_MS, onGround: true }); }
          finally { manualBusy = false; letGo(bot); }
          const now = feetCell(bot)!;
          if (now.x !== aside.x || now.z !== aside.z || shortFloor(bot, now)) {
            return { levels, stop: fail('low_floor', `足元の ${short.name} は高さ ${short.top.toFixed(2)} で跳びが届かず、隣の丸ごとの床 ${cellText(aside)} へも移れなかった`, '別の所から登る') };
          }
          continue;
        }
        const floorBlock = blockAt(bot, short.cell);
        const quick = floorBlock && floorBlock.boundingBox === 'block' && !NEVER_DIG.test(String(floorBlock.name)) && !PROTECTED_UTILITY_BLOCKS.has(String(floorBlock.name)) && Number(floorBlock.hardness ?? 99) <= 1.5;
        // Run 42 (+820 q64, replayed on its own ground): the body stood on a moss carpet (0.06 up its cell). The dig called the carpet "already
        // open" (the walk passes through it), dug nothing and said ok, and the climb tried again every 0.3 s for 115 s until the go's time ran
        // out: 3 steps in 120 s. The carpet is dug as the floor it is (`thin`), and a floor that is still there after its dig stops the climb.
        if (quick && state.dug < limits.maxDig && floorDigs < 2) {
          floorDigs++;
          manualBusy = true;
          let dug: StepOutcome;
          try { dug = await dig(ctx, { at: [short.cell], collect: false, thin: true }); } finally { manualBusy = false; }
          // The body drops onto the floor under the one dug: it is let land (the ground under it is read again) before the next level.
          const gone = dug.ok && blockAt(bot, short.cell)?.name !== floorBlock.name;
          if (gone) { await wait(ctx, 250); await waitUntil(ctx, () => bot.entity?.onGround === true && Math.abs(bot.entity?.velocity?.y ?? 0) < 0.1, 2500); continue; }
        }
        return { levels, stop: fail('low_floor', short.top > 0 ? `足元 ${cellText(short.cell)} の ${short.name} は高さ ${short.top.toFixed(2)} で、跳んでも積む高さに届かない`
          : `足元 ${cellText(short.cell)} が ${short.name} で、跳んでも積む土台が無い（隣の丸ごとの床も無い）`, '丸ごとの床の所へ動いてから登る') };
      }
      feet = feetCell(bot)!;
      const roof = { x: feet.x, y: feet.y + 2, z: feet.z };
      const roofBlock = blockAt(bot, roof);
      if (roofBlock && !isAirLike(roofBlock) && roofBlock.name !== 'water' && roofBlock.name !== 'lava') {
        const above = nameAt(bot, roof.x, roof.y + 1, roof.z);
        if (!rule.names.has(roofBlock.name) || state.dug >= limits.maxDig) {
          return { levels, stop: fail(state.dug >= limits.maxDig ? 'limit_dig' : 'dead_end', `頭の上 ${cellText(roof)} が ${roofBlock.name} で登れない（掘ってよい物に無い）`, 'canDig に足すか、別の場所から') };
        }
        if (above && FALLING.test(above)) return { levels, stop: fail('dead_end', `頭の上 ${cellText(roof)} を掘ると、その上の ${above} が落ちてくる`, '別の場所から') };
        manualBusy = true;
        let dug: StepOutcome;
        try { dug = await dig(ctx, { at: [roof], collect: false }); } finally { manualBusy = false; }
        if (!dug.ok) return { levels, stop: fail(dug.reason === 'lava_behind' ? 'lava' : 'dead_end', dug.text.slice(0, 90), '別の場所から') };
      }
      manualBusy = true;
      let up: StepOutcome;
      try { up = await pillarUp(ctx, { n: 1, block }); } finally { manualBusy = false; }
      if (!up.ok) {
        if (up.reason === 'missing_item') return { levels, stop: fail('no_blocks', up.text.slice(0, 90), '置ける物を集める') };
        // Run 43: a level not laid says what it met first (`placeFacts`), within the line.
        return { levels, stop: fail(up.reason === 'ceiling' ? 'dead_end' : up.reason === 'low_floor' || up.reason === 'no_floor' ? 'low_floor' : 'stuck',
          up.text.slice(0, up.reason === 'not_placed' ? Math.max(100, up.text.indexOf('）: ') + 1) : 100), '') };
      }
      levels++;
    }
    return { levels };
  };

  /** The mending of a body that stands still: the first tries are a jump and a step back; later the cells ahead are cleared or filled. */
  const mend = async (attempt: number, toward: Cell): Promise<void> => {
    const press = async (key: string, ms: number) => { bot.setControlState(key, true); try { await wait(ctx, ms); } finally { bot.setControlState(key, false); } };
    letGo(bot);
    if (attempt === 1) { await press('jump', 250); return; }
    if (attempt === 2 || attempt === 4) { await press('back', 500 + 150 * attempt); await press('jump', 200); return; }
    const feet = feetCell(bot)!;
    const dx = Math.sign(toward.x - feet.x), dz = Math.sign(toward.z - feet.z);
    const ahead = Math.abs(toward.x - feet.x) >= Math.abs(toward.z - feet.z) ? { x: feet.x + dx, z: feet.z } : { x: feet.x, z: feet.z + dz };
    const blocks = [{ ...ahead, y: feet.y }, { ...ahead, y: feet.y + 1 }].filter(cell => { const b = blockAt(bot, cell); return b && b.boundingBox === 'block' && rule.names.has(b.name) && state.dug < limits.maxDig; });
    if (blocks.length) {
      manualBusy = true;
      try { await dig(ctx, { at: blocks, collect: false }); } finally { manualBusy = false; }
    } else {
      await press(attempt === 3 ? 'left' : 'right', 500);
      await press('back', 300);
    }
  };

  let attempt = 0, noway = 0, mends = 0, partialWalks = 0;
  // Headway is the nearest the body has come to a place; a body that is mended and walks back to the same wall has made none.
  let nearest = distanceTo(bot, near());
  const nowhere: GoOutcome = { reached: false, timedOut: false, stuck: false, error: new Error('NoPath'), search: { status: 'noPath', nodes: 0 }, opens: [], crossed: false };
  const countOf = (found: Plan) => [...found.digs.values()].reduce((sum, count) => sum + count, 0);
  try {
    for (;;) {
      const stop = vetoed() ?? limitStop();
      if (stop) return stop;
      if (reached()) return arrived();
      const aim = near();
      const finalGoal = compositeOf(targets, limits.range);
      // A place far off is walked to a leg at a time; a place not loaded is walked as close to as the ground goes.
      const isUnloaded = () => { try { return !bot.blockAt(new Vec3(aim.x, aim.y, aim.z), false); } catch { return true; } };
      const unloaded = isUnloaded();
      const leg = nextLeg(bot, goalOf(aim, limits.range) as never, attempt, FAR_LEG_M);
      const legGoal = unloaded ? new goals.GoalNearXZ(aim.x, aim.z, 3) : leg.final ? finalGoal : leg.goal;
      const movements = movementsFor();
      nav.setMovements(movements);
      state.veto = null;
      lastWork = Date.now();
      const from = bot.entity.position.clone();
      // The way is drawn before the body moves: a way that is not found is not walked half (the executor walks the closest it found), and a way
      // that breaks or fills more than the limits is not begun.
      const drawn = await plan(movements, legGoal, Math.min(searchCap, timeLeft()));
      let out: GoOutcome = nowhere;
      if (drawn.status === 'success') {
        const over = budgetOf(countOf(drawn), drawn.places);
        if (over) return fail(over.code, over.text, over.code === 'limit_dig' ? 'maxDig を増やすか、別の道を' : 'maxPlace を増やすか、別の道を');
        out = await goWith(ctx, legGoal, timeLeft(), notes, { stuckMs: GO_STUCK_MS, busy, onRoute: watchRoute, onGround: true });
      }
      const blocked = vetoed();
      if (blocked) { letGo(bot); return blocked; }
      if (out.crossed) return arrived();
      if (reached()) return arrived();
      if (out.timedOut) { letGo(bot); return fail('limit_time', `${args.seconds ?? GO_DEFAULTS.seconds} 秒の上限に着いた（行き先まで あと ${distanceTo(bot, aim).toFixed(0)}m）`, 'seconds を増やすか、行き先を近くに'); }
      letGo(bot);
      const moved = bot.entity.position.distanceTo(from);
      if (unloaded && !isUnloaded()) { state.redraws++; continue; }
      if (unloaded && moved < 1.5) {
        // As far as the ground that is loaded goes: to the end of the way the search found toward it; there is no more, it is not loaded.
        const end = drawn.path.length ? drawn.path[drawn.path.length - 1] : null;
        if (end && Math.hypot(end.x - bot.entity.position.x, end.z - bot.entity.position.z) > 1.5) {
          state.redraws++;
          const cell = nodeCell(end);
          await goWith(ctx, new goals.GoalBlock(cell.x, cell.y, cell.z), timeLeft(), notes, { stuckMs: GO_STUCK_MS, busy, onRoute: watchRoute, onGround: true });
          letGo(bot);
          continue;
        }
        return fail('not_loaded', `行き先 ${cellText(aim)} は読み込まれていない地図の外で、進める所まで進んだ（あと ${distanceTo(bot, aim).toFixed(0)}m）`, '近くの読み込まれた所まで行ってから');
      }
      const left = distanceTo(bot, near());
      if (left < nearest - 1.5) { nearest = left; mends = 0; noway = 0; attempt = 0; }
      if (moved >= 1.5 && !out.stuck) { mends = 0; noway = 0; attempt = 0; state.redraws++; continue; }
      // A search that ran out of its time (run 41: 8 of 13 "no way" stops) says nothing about the way: turning the leg, drawing again at once
      // and the explaining searches would each run out the same (5 + 5 + 4 x 2.5 s). What it found is walked when it comes nearer; else it is said.
      const searchedOut = drawn.status === 'timeout';
      if (!leg.final && !out.stuck && attempt < 4 && !searchedOut) { attempt++; state.redraws++; continue; }
      if (out.stuck) {
        // Run 45 (hold 2): the cell of the route the body was held before is avoided by the next drawings.
        const ahead = aheadOf(lastRoute, bot.entity?.position);
        if (ahead && !state.avoid.has(keyOf(ahead))) {
          state.avoid.add(keyOf(ahead));
          blackBoxOf(host)?.note('avoid', { at: [ahead.x, ahead.y, ahead.z], why: 'stuck' });
        }
        mends++;
        if (mends > GO_REPAIRS) {
          const feet = feetCell(bot)!;
          return fail('stuck', `${GO_STUCK_MS / 1000}秒位置が変わらず、直しを ${GO_REPAIRS} 回しても進まない（今 ${cellText(feet)}）`, 'view で周りを見て別の手を');
        }
        state.redraws++;
        await mend(mends, aim);
        continue;
      }
      // The way is not found. The first time may be the ground still arriving: a new drawing. Then a climb, then the reason.
      noway++;
      if (noway === 1 && !searchedOut) { state.redraws++; await wait(ctx, 300); continue; }
      const found = leg.final || searchedOut ? drawn : await plan(movements, finalGoal, Math.min(searchCap, timeLeft()));
      const end = found.path.length ? found.path[found.path.length - 1] : null;
      const lowest = Math.min(...targets.map(cell => cell.y));
      // Run 44 (hold 1): the search's cell, not the point the pathfinder put on the top of the floor (64.94 on farmland is the cell 65, not 64).
      const endCell = end ? nodeCell(end) : null;
      const closestY = endCell ? endCell.y : (feetCell(bot)?.y ?? lowest);
      if (lowest > closestY) {
        // The place is higher than the nearest the way goes: a climb. The route search's own towers are off; a block is laid at the top of each jump.
        if (!place.held.length) {
          return args.canPlace?.length
            ? fail('no_blocks', `行き先は ${lowest - closestY} 段上で、登るのに置く物が無い（${place.missing.length ? `持っていない ${place.missing.join('・')}` : '置ける物が無い'}${place.refused.length ? `、置かない ${place.refused.join('・')}` : ''}）`, '置ける物を集めるか、canPlace を足す')
            : fail('dead_end', `行き先は ${lowest - closestY} 段上で、道は途中までしか無い。登るには canPlace が要る`, 'canPlace に置ける物を足す');
        }
        // To the foot of the climb along the level: an end the way found high up (a search cut by its time ends where it got to) is not walked to,
        // the executor has no towers (run 41 replay: 12 redraws at a goal 17 up, stuck in 10 s); the climb starts here.
        const here = feetCell(bot);
        if (end && endCell && Math.hypot(end.x - bot.entity.position.x, end.z - bot.entity.position.z) > 1.2 && (!here || endCell.y <= here.y + 1)) {
          state.redraws++;
          await goWith(ctx, new goals.GoalBlock(endCell.x, endCell.y, endCell.z), timeLeft(), notes, { stuckMs: GO_STUCK_MS, busy, onRoute: watchRoute, onGround: true });
          letGo(bot);
          const again = vetoed();
          if (again) return again;
        }
        const climbed = await climb(lowest);
        if (climbed.levels > 0) { noway = 0; state.redraws++; continue; }
        if (climbed.stop) return climbed.stop;
      }
      if (found.status === 'timeout') {
        // The part of the way the search had found when its time ran out: walked when its end is nearer the place by 2 m or more.
        const tip = found.path.length ? found.path[found.path.length - 1] : null;
        // Run 45 (hold 1, at y=33 with 61 of maxDig 80 dug): the part of the way the search had found broke more than the limit left, so it was
        // not walked, and the stop said search_timeout (道探しが終わらない). It is the limit: said as such, with what is left and what the part needs.
        const over = tip ? budgetOf(countOf(found), found.places) : null;
        if (over && partialWalks < GO_PARTIAL_WALKS) {
          return fail(over.code, `道探しは ${(searchCap / 1000).toFixed(searchCap < 1000 ? 2 : 0)} 秒で終わらず、見つかった途中までの道（${cellText(nodeCell(tip!))} まで）でも${over.text.replace(/^この道は/u, '')}`,
            over.code === 'limit_dig' ? 'maxDig を増やして出し直す（下りは 1 段に 2 前後掘る）' : 'maxPlace を増やして出し直す');
        }
        if (tip && partialWalks < GO_PARTIAL_WALKS) {
          const cell = nodeCell(tip);
          const gain = distanceTo(bot, aim) - Math.hypot(cell.x - aim.x, cell.y - aim.y, cell.z - aim.z);
          if (gain >= 2) {
            partialWalks++; state.redraws++;
            await goWith(ctx, new goals.GoalBlock(cell.x, cell.y, cell.z), timeLeft(), notes, { stuckMs: GO_STUCK_MS, busy, onRoute: watchRoute, onGround: true });
            letGo(bot);
            const again = vetoed();
            if (again) return again;
            noway = 0;
            continue;
          }
        }
        return searchedOutStop(found, aim);
      }
      return await explain(finalGoal);
    }
  } catch (error) {
    // The act's stop, the action's abort, a reflex: the body lets go of everything and the stop goes on.
    if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) letGo(bot);
    throw error;
  } finally {
    bot.removeListener?.('physicsTick', onTick);
    // Put back by identity on the host; a wrapper another module put over ours meanwhile stays (it reaches ours, which then counts nothing).
    counting = false;
    if (host.dig === countingDig) host.dig = originalDig;
    if (host.placeBlock === countingPlace) host.placeBlock = originalPlace;
    bot.removeListener?.('path_reset', onReset);
    hostNav.bestHarvestTool = previousTool;
    host.inventory?.removeListener?.('updateSlot', forgetTools);
    try { if (previousMovements) nav.setMovements(previousMovements); } catch { /* the profile stays */ }
    try { bot.setControlState?.('jump', false); bot.setControlState?.('sneak', false); } catch { /* released */ }
  }
}

/** The hand's estimate of itself (the contract's: straight distance / 4 s + dug × 0.7 s + laid × 0.5 s, at most `seconds`), for the head and the tests. */
export function goMilliseconds(distance: number, dug: number, placed: number, seconds: number = GO_DEFAULTS.seconds): number {
  return Math.min(seconds * 1000, Math.round((distance / 4 + dug * 0.7 + placed * 0.5) * 1000));
}
