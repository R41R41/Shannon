import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { PROTECTED_UTILITY_BLOCKS } from '../../constants.js';
import { nativeActionHost } from '../../execution/ActionExecution.js';
import { buildMovements } from '../setMovements.js';
import { FAR_LEG_M, nextLeg } from '../farLegs.js';
import { feetCell, type Cell } from '../localMap.js';
import { chooseTool, canHarvest, nearlyBroken } from '../toolChoice.js';
import { installDoorRules, NO_ENTER } from '../walkRules.js';
import { clip } from '../actReport.js';
import { blockAt, cellText, inventoryCount, isAirLike, letGo, stopped, StepStopped, wait, type StepContext, type StepOutcome } from './common.js';
import { atGoal, goWith, type GoOutcome, type WayNotes } from './walk.js';
import { dig } from './dig.js';
import { pillarUp } from './pillarUp.js';

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
  const feet = nameAt(bot, x, y, z), head = nameAt(bot, x, y + 1, z), floor = nameAt(bot, x, y - 1, z);
  for (const name of [feet, head]) if (name && NO_ENTER.has(name)) return `${name} の中`;
  if (floor === 'magma_block') return '足元が magma_block';
  if (nameAt(bot, x, y + 2, z) === 'lava') return '頭の上が溶岩';
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, 1]) {
    const beside = nameAt(bot, x + dx, y + dy, z + dz);
    if (beside && BESIDE_HAZARD.has(beside)) return `${beside} の隣`;
  }
  return null;
}

/** A route drawn without walking it: the search's status, its nodes, and the cells it breaks (by block name) and fills. */
interface Plan { status: string; path: any[]; digs: Map<string, number>; places: number }
const yieldNow = () => new Promise<void>(resolve => setImmediate(resolve));

interface Relax { hazards?: boolean; tool?: boolean; blocks?: boolean; permissions?: boolean; limits?: boolean }
interface State {
  steps: number; dug: number; placed: number; redraws: number;
  veto: { code: string; text: string } | null;
  /** The blocks laid in a row that the world did not show. */
  refused: number;
}

// ---- the movements ---------------------------------------------------------------------------------------------------------------------

function goMovements(bot: any, args: Required<Pick<GoArgs, 'maxDrop' | 'waterOk' | 'maxDig' | 'maxPlace'>> & { sprint: boolean }, rule: DigRule, placeHeld: string[], state: State, relax: Relax = {}): any {
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
  // Moves that end in a hazard (beside lava, on magma...), or in water when it is not allowed, are not moves.
  const getNeighbors = movements.getNeighbors.bind(movements);
  const hazards = new Map<string, string | null>();
  let hazardsAt = 0;
  const hazardOf = (x: number, y: number, z: number) => {
    if (Date.now() - hazardsAt > 1500) { hazards.clear(); hazardsAt = Date.now(); }
    const key = `${x},${y},${z}`;
    if (!hazards.has(key)) hazards.set(key, hazardAtFeet(bot, x, y, z));
    return hazards.get(key)!;
  };
  const inWater = isWaterName(nameAt(bot, Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z)));
  movements.getNeighbors = (node: any) => (getNeighbors(node) as any[]).filter(move => {
    if (!relax.hazards && hazardOf(move.x, move.y, move.z)) return false;
    if (!args.waterOk && !inWater && (isWaterName(nameAt(bot, move.x, move.y, move.z)) || isWaterName(nameAt(bot, move.x, move.y + 1, move.z)))) return false;
    return true;
  });
  return movements;
}

// ---- the work ----------------------------------------------------------------------------------------------------------------------------

const distanceTo = (bot: any, cell: Cell) => Math.hypot(bot.entity.position.x - (cell.x + 0.5), bot.entity.position.y - cell.y, bot.entity.position.z - (cell.z + 0.5));
const goalOf = (cell: Cell, range: number) => range > 0 ? new goals.GoalNear(cell.x + 0.5, cell.y, cell.z + 0.5, range) : new goals.GoalBlock(cell.x, cell.y, cell.z);
const compositeOf = (cells: Cell[], range: number) => cells.length === 1 ? goalOf(cells[0], range) : new goals.GoalCompositeAny(cells.map(cell => goalOf(cell, range)));
const keyOf = (cell: Cell) => `${cell.x},${cell.y},${cell.z}`;

/** Whether the block just laid against `reference` on `face` shows in the world (the cell beside it is no longer air), looked at for a moment as the update may come late. */
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
  const place = placeNamesOf(bot, args.canPlace);
  const state: State = { steps: 0, dug: 0, placed: 0, redraws: 0, veto: null, refused: 0 };
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
  const standable = cells.filter(cell => !hazardAtFeet(bot, cell.x, cell.y, cell.z));
  if (!standable.length) {
    const why = hazardAtFeet(bot, cells[0].x, cells[0].y, cells[0].z) ?? '危ない';
    return fail('unsafe', `行き先 ${cellText(cells[0])} は${why}（溶岩・火・マグマ・サボテン・ベリー・ウィザーローズとその隣には行かない）`, '別の行き先を');
  }
  const targets = standable;
  const near = (): Cell => targets.reduce((best, cell) => (distanceTo(bot, cell) < distanceTo(bot, best) ? cell : best), targets[0]);
  const reached = () => atGoal(bot, compositeOf(targets, limits.range));
  if (reached()) return arrived();

  // ---- the watchers: cells entered, blocks dug, blocks laid ----
  let lastCell = keyOf(start), manualBusy = false;
  const onTick = () => {
    try {
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
    const result = await originalDig.apply(host, rest);
    if (counting) { state.dug++; lastWork = Date.now(); }
    return result;
  };
  const countingPlace = async function (this: unknown, ...rest: unknown[]) {
    const result = await originalPlace.apply(host, rest);
    if (!counting) return result;
    // A block the server did not take is not a floor: the route executor is not let walk on (run 40 bench: go went on over a refused place and fell four cells).
    if (await laidAt(host, rest[0], rest[1])) { state.placed++; lastWork = Date.now(); state.refused = 0; return result; }
    if (++state.refused >= GO_REFUSED_PLACES && !state.veto) {
      state.veto = { code: 'stuck', text: `置いたブロックが世界に現れない（サーバーが置きを断った。${state.refused} 回）` };
      try { nav.setGoal?.(null); } catch { /* stopped below */ }
    }
    // The body is stopped where it stands at once: the next step of the route would be onto the block that is not there.
    letGo(bot);
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
  hostNav.bestHarvestTool = (block: any) => {
    const tools = ((bot.inventory?.items?.() ?? []) as any[]);
    const sound = tools.filter(item => !nearlyBroken(item));
    return chooseTool(block, sound.length || !tools.length ? sound : tools, { effects: bot.entity?.effects }) ?? null;
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
  const watchRoute = (route: any[]) => {
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
    const generator = nav.getPathFromTo(movements, bot.entity.position, goal, { timeout: Math.max(300, Math.min(ms, 5000)) });
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
    return { status: String(result.status), path: result.path ?? [], digs, places };
  };

  /** The way is shut: look again with each rule lifted in turn, and name the first whose lifting opens it. */
  const explain = async (goal: any): Promise<StepOutcome> => {
    const ms = Math.min(2500, Math.max(300, timeLeft() - 500));
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
    let levels = 0;
    while (levels < CLIMB_CHUNK && (feetCell(bot)?.y ?? toY) < toY) {
      if (timeLeft() <= 0) break;
      if (state.placed >= limits.maxPlace) return { levels, stop: fail('limit_place', `置く数の上限 ${limits.maxPlace} に着いた`, 'maxPlace を増やすか、別の道を') };
      const block = place.held.find(name => inventoryCount(bot, name) > 0);
      if (!block) return { levels, stop: fail('no_blocks', `登るのに置く物が無い（${place.missing.length ? `持っていない ${place.missing.join('・')}` : 'canPlace に置ける物が無い'}）`, '置ける物を集めるか、canPlace を足す') };
      const feet = feetCell(bot)!;
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
        return { levels, stop: fail(up.reason === 'ceiling' ? 'dead_end' : 'stuck', up.text.slice(0, 100), '') };
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

  let attempt = 0, noway = 0, mends = 0;
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
      const drawn = await plan(movements, legGoal, Math.min(5000, timeLeft()));
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
          await goWith(ctx, new goals.GoalBlock(Math.floor(end.x), Math.floor(end.y), Math.floor(end.z)), timeLeft(), notes, { stuckMs: GO_STUCK_MS, busy, onRoute: watchRoute, onGround: true });
          letGo(bot);
          continue;
        }
        return fail('not_loaded', `行き先 ${cellText(aim)} は読み込まれていない地図の外で、進める所まで進んだ（あと ${distanceTo(bot, aim).toFixed(0)}m）`, '近くの読み込まれた所まで行ってから');
      }
      const left = distanceTo(bot, near());
      if (left < nearest - 1.5) { nearest = left; mends = 0; noway = 0; attempt = 0; }
      if (moved >= 1.5 && !out.stuck) { mends = 0; noway = 0; attempt = 0; state.redraws++; continue; }
      if (!leg.final && !out.stuck && attempt < 4) { attempt++; state.redraws++; continue; }
      if (out.stuck) {
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
      if (noway === 1) { state.redraws++; await wait(ctx, 300); continue; }
      const found = leg.final ? drawn : await plan(movements, finalGoal, Math.min(5000, timeLeft()));
      const end = found.path.length ? found.path[found.path.length - 1] : null;
      const lowest = Math.min(...targets.map(cell => cell.y));
      const closestY = end ? Math.floor(end.y) : (feetCell(bot)?.y ?? lowest);
      if (lowest > closestY) {
        // The place is higher than the nearest the way goes: a climb. The route search's own towers are off; a block is laid at the top of each jump.
        if (!place.held.length) {
          return args.canPlace?.length
            ? fail('no_blocks', `行き先は ${lowest - closestY} 段上で、登るのに置く物が無い（${place.missing.length ? `持っていない ${place.missing.join('・')}` : '置ける物が無い'}${place.refused.length ? `、置かない ${place.refused.join('・')}` : ''}）`, '置ける物を集めるか、canPlace を足す')
            : fail('dead_end', `行き先は ${lowest - closestY} 段上で、道は途中までしか無い。登るには canPlace が要る`, 'canPlace に置ける物を足す');
        }
        if (end && Math.hypot(end.x - bot.entity.position.x, end.z - bot.entity.position.z) > 1.2) {
          state.redraws++;
          await goWith(ctx, new goals.GoalBlock(Math.floor(end.x), Math.floor(end.y), Math.floor(end.z)), timeLeft(), notes, { stuckMs: GO_STUCK_MS, busy, onRoute: watchRoute, onGround: true });
          letGo(bot);
          const again = vetoed();
          if (again) return again;
        }
        const climbed = await climb(lowest);
        if (climbed.levels > 0) { noway = 0; state.redraws++; continue; }
        if (climbed.stop) return climbed.stop;
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
    try { if (previousMovements) nav.setMovements(previousMovements); } catch { /* the profile stays */ }
    try { bot.setControlState?.('jump', false); bot.setControlState?.('sneak', false); } catch { /* released */ }
  }
}

/** The hand's estimate of itself (the contract's: straight distance / 4 s + dug × 0.7 s + laid × 0.5 s, at most `seconds`), for the head and the tests. */
export function goMilliseconds(distance: number, dug: number, placed: number, seconds: number = GO_DEFAULTS.seconds): number {
  return Math.min(seconds * 1000, Math.round((distance / 4 + dug * 0.7 + placed * 0.5) * 1000));
}
