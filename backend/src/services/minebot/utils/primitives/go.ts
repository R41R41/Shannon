import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { PROTECTED_UTILITY_BLOCKS } from '../../constants.js';
import { nativeActionHost } from '../../execution/ActionExecution.js';
import { buildMovements } from '../setMovements.js';
import { installGroundSprint } from '../groundSprint.js';
import { airborneGround, buriedSurface, BURIED_FAR_M, FAR_LEG_M, nextLeg } from '../farLegs.js';
import { feetCell, type BlockReader, type Cell } from '../localMap.js';
import { chooseTool, canHarvest, nearlyBroken, handDigForWay } from '../toolChoice.js';
import { installDoorRules, isDoorlike, mapBlockOf, nodeCell, NO_ENTER, standable } from '../walkRules.js';
import { clip } from '../actReport.js';
import { blockAt, cellText, fullPackWatch, inventoryCount, isAirLike, letGo, stopped, StepStopped, wait, waitUntil, type StepContext, type StepOutcome } from './common.js';
import { atGoal, goWith, type GoOutcome, type WayNotes } from './walk.js';
import { dig } from './dig.js';
import { climbBlocker, pillarUp, shortFloor, wholeFloorBeside } from './pillarUp.js';
import { bodyOverlap, placeFacts } from '../placeFacts.js';
import { blackBoxOf } from '../blackbox.js';
import type { Progress } from '../../integration/commonFca/continueContract.js';
import { meterProgress, round1 } from './progressUnits.js';
import { ThreatExposedError } from '../exposureGuard.js';
import { surfaceSwimControls, swimControls, swimPulse } from './swim.js';
import { waterExitWords } from './waterExit.js';
import { stanchStream } from './stanch.js';
import { cloudReaches, cloudZoneAtCell, lyingCloudZones } from '../dragonDanger.js';
import { perchClearance } from '../dragonApproach.js';
import { dragonPhaseOf, endDragonOf, isEnd } from '../dragonState.js';
import { isPerched } from '../dragonParts.js';
import { holeUnderCentreWords, magmaAtFootprint } from '../magmaFootprint.js';
import { airPerchHint } from '../shaftDown.js';
import { framesAround, FRAME_SEARCH_MAX } from '../huntFrameSearch.js';
import { ROOF_KEEP, roofBlocksKeptFromGo } from '../huntEnderman.js';

const waterExitText = (bot: any, feet: Cell) => { const exit = waterExitWords(bot, feet); return exit ? `。${exit}` : ''; };

const { goals } = pathfinder;

const COMPASS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];
/**
 * end1109s11 S9: a go arrived 110 m from the portal room's frames (in the loaded chunks) and said nothing of them; the head went back 130 m to
 * throw an eye again and found the frames only on its next probe, 166 s later. While the body carries ender eyes in the overworld, a go that
 * arrives says the frames in the loaded chunks within 128 m (what `probe kind=frames` would say first): the nearest, its way and its height.
 * Only an observation, nothing is done for the head.
 */
export function framesInSight(bot: any): string {
  if (!/overworld/u.test(String(bot.game?.dimension ?? 'overworld')) || inventoryCount(bot, 'ender_eye') === 0) return '';
  const body = bot.entity?.position;
  if (!body) return '';
  let scan;
  try { scan = framesAround(bot, { x: Math.floor(body.x), z: Math.floor(body.z) }, FRAME_SEARCH_MAX); } catch { return ''; }
  const near = scan.frames[0];
  if (!near) return '';
  try { bot.placeMemory?.remember('stronghold', { x: near.x, y: near.y, z: near.z }, { note: 'end_portal_frame' }); } catch { /* memory is optional */ }
  const dx = near.x - body.x, dz = near.z - body.z, dy = near.y - Math.floor(body.y);
  const way = COMPASS[Math.round(((Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360) / 45) % 8];
  return `エンドポータルの枠が見えている（${scan.frames.length} 個）: いちばん近い (${near.x},${near.y},${near.z}) は ${Math.round(Math.hypot(dx, dz))}m ${way}・高さ ${dy >= 0 ? '+' : ''}${dy}。要塞はここ`;
}

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
  /**
   * true: the sprint is let on all the way; false or left out: never; 'auto' (the act's go when the planner wrote nothing, S8 2026-11-05): on where nothing hurts
   * within two cells (lava, fire, magma) and no fall beyond the allowed drop is beside the feet, off there; no jump that needs the sprint is planned.
   */
  sprint?: boolean | 'auto';
  /**
   * The longest one drawing of the way may search, in the pathfinder's own milliseconds (default 5 s; the search that says why the way is shut, 2.5 s). The tests that
   * run on a faked clock give a search no time limit of its own (a slow machine would run it out and the line would say dead_end instead of the reason).
   */
  searchMs?: number;
}

export const GO_DEFAULTS = { range: 0.5, maxDrop: 3, seconds: 60, maxDig: 40, maxPlace: 24 } as const;
/** Stuck: the position unchanged for this long while nothing is being dug or laid. */
export const GO_STUCK_MS = 3000;
const FACE_REST_MS = 15_000;
/**
 * Run 40 (2026-10-27: 7 stuck stops of 34 to 54 s and 217 to 436 redraws each): the route executor draws the path again every time a step of it fails, and does so for as
 * long as it is given. The most redraws with no headway between them (no new cell entered, nothing dug, nothing laid) before the stop `stuck`.
 */
export const GO_STALLED_REDRAWS = 12;
/** The blocks laid that the world does not show, in a row, before the stop `stuck` (a refused place is drawn past once: the cell costs more and the route goes round or lays elsewhere). */
export const GO_REFUSED_PLACES = 3;
/** ... and the times the server may refuse the same cell before the stop (run 48 hold 2: the first refusal is drawn past, the second at the same cell stops). */
export const GO_REFUSED_SAME_CELL = 2;
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
export const GO_PARTIAL_WALKS = 12;
/** S8: the most times one go cuts its way itself at a point on the straight line, when the same search ran out of its time twice (each must come 2 m nearer). */
export const GO_RELAYS = 6;
/** ... and how far on the line that point is, tried in turn. */
const RELAY_STEPS_M = [24, 12];
/** A search of the road is cut after this long when the caller gave no `searchMs`: the part of the way it found (nearest the goal) is walked and the search goes on from there (S2, 2026-11-03: a Nether walk of 196 m in 11 minutes was 5 s searches each ending as search_timeout; S4's lab: the best part found in the first seconds is as good as the one at five). */
const SEARCH_SLICE_MS = 1500;
/**
 * Run 46 (hold 4, q15 go at the amethyst-side deepslate: 120 s, 50 digs refused, a 3 m box): the exposure guard refuses a dig that would open a way to the body for a
 * hostile behind the rock (a zombie 8 to 16 m off), the route is drawn at the next cell, which the guard refuses too, and so on. A cell refused is closed to the routes for as long as
 * that hostile stays where it was (refusedDigs); this many different cells refused within GO_EXPOSED_WINDOW_MS (45 s), with the body no nearer than GO_EXPOSED_HEADWAY_M to the place
 * than it was at the first of them, stop the go with `threat_exposed` and the reason; and a way not found after a refusal says the refusal. (A go that is refused cells and still
 * comes nearer is let go on: in the lab a wide wall was crossed by another way after eight refusals.)
 */
export const GO_EXPOSED_STOPS = 8;
export const GO_EXPOSED_WINDOW_MS = 45_000;
export const GO_EXPOSED_HEADWAY_M = 2;
/** The most mendings of a stuck body, without any headway between them, before the stop `stuck`. */
export const GO_REPAIRS = 5;
/** The most levels a climb makes before the way is drawn again. */
const CLIMB_CHUNK = 4;
/** A sealed place nearer (flat) than this is never raised to the ground over it; one beyond, with ground at most SEALED_NEAR_DEPTH over it, is (end1109s01b S9). */
const SEALED_NEAR_M = 6;
const SEALED_NEAR_DEPTH = 12;
/** How near (flat, beyond the go's range) the way must end to a place for a climb to begin there (end1109s01b S9). */
const CLIMB_NEAR_M = 6;

// ---- the words the planner writes ------------------------------------------------------------------------------------------------------

const STONE = ['stone', 'cobblestone', 'mossy_cobblestone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'cobbled_deepslate', 'blackstone', 'netherrack',
  'end_stone', 'basalt', 'smooth_basalt', 'calcite', 'dripstone_block', 'sandstone', 'red_sandstone', 'terracotta'];
const DIRT = ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'mycelium', 'mud', 'clay', 'rooted_dirt'];
const SAND = ['sand', 'red_sand', 'gravel', 'soul_sand'];
const WOOD = /(?:_log|_wood|_stem|_hyphae|_planks|_fence)$/u;
/** Blocks the body does not break whatever it is told: nothing mined for itself, nothing that is a village's or a player's. */
const NEVER_DIG = /(?:_ore$|^ancient_debris$|^obsidian$|^crying_obsidian$|^bedrock$|^spawner$|^trial_spawner$|^vault$|_door$|_fence_gate$|_trapdoor$|_bed$|^end_portal|^nether_portal$|^barrier$|^command_block|^structure_block$|^reinforced_deepslate$|^farmland$|^budding_amethyst$)/u;
/** An ore or ancient debris: dug when named by its id in `canDig`, never as part of a category word. */
const ORE_ID = /(?:_ore$|^ancient_debris$)/u;
/** Blocks that fall when what holds them is gone: never laid as a bridge or a step, dug under with care. */
const FALLING = /^(?:sand|red_sand|gravel|suspicious_sand|suspicious_gravel|anvil|chipped_anvil|damaged_anvil|dragon_egg|pointed_dripstone|.*_concrete_powder)$/u;
/** Made by people: left alone near a villager. */
const VILLAGE_MADE = /(?:_planks|_fence|_slab|_stairs|_door|_trapdoor|_bed|glass|glass_pane|bookshelf|hay_block|_wall|bricks|_wool|_carpet|lantern)$/u;
const VILLAGE_REACH = 40;
/** Standing beside these hurts (a step into a cell next to one is not taken). */
const BESIDE_HAZARD = new Set(['lava', 'magma_block', 'cactus', 'fire', 'soul_fire']);
/** A fire beside a place this near the body is walked to and put out (a blaze camp's floor); a farther one is said (it may go out by itself, and a far place has others). */
export const FIRE_WALK_M = 12;
/** Walks to a fire one go makes; and fires one go puts out (a camp under fire relights its cells: the head is told rather than the body dousing forever). */
const FIRE_WALKS = 3;
const FIRE_DOUSE_LIMIT = 8;

export interface DigRule {
  /** The block names that may be dug. */
  names: Set<string>;
  /** Words given that mean nothing (unknown, or never dug): said when a way is not found. */
  ignored: string[];
}

const PICK_TIER = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite'];
/** The pickaxes in the pack, best first: name and uses left (Infinity when the item does not say). */
export function pickaxesOf(bot: any): Array<{ name: string; left: number }> {
  const items = (bot.inventory?.items?.() ?? []) as Array<{ name: string; maxDurability?: number; durabilityUsed?: number }>;
  const tier = (name: string) => PICK_TIER.indexOf(name.replace(/_pickaxe$/u, ''));
  return items.filter(item => /_pickaxe$/u.test(item.name))
    .map(item => ({ name: item.name, left: typeof item.maxDurability === 'number' && item.maxDurability > 0 ? Math.max(0, item.maxDurability - (item.durabilityUsed ?? 0)) : Infinity }))
    .sort((a, b) => tier(b.name) - tier(a.name) || a.left - b.left);
}
/** Uses left at or under this: the go line says the pickaxe is near breaking. */
export const PICK_LOW = 20;
/**
 * 1107b (Haiku, a random world): about 40 go hops with canDig stone dug through both pickaxes (the wooden one, then the stone one, tool_broke)
 * with nothing said in the go lines; the head learnt of it only when no pickaxe was left and the iron 16 below was out of reach.
 * A go that dug, or after which a pickaxe it began with is gone, says the pickaxe left, and says it plainly when it is near breaking or gone.
 */
export function pickaxeWords(bot: any, atStart: Array<{ name: string }>, dug: number): string {
  const now = pickaxesOf(bot);
  const lost = atStart.filter(pick => !now.some(left => left.name === pick.name)).map(pick => pick.name);
  if (!dug && !lost.length) return '';
  const broke = lost.length ? `・${lost.join('・')} が壊れた` : '';
  if (!now.length) return `${broke}・ツルハシ無し（石・鉄を掘るには作り直す）`;
  const best = now[0];
  if (best.left === Infinity) return broke;
  return `${broke}・${best.name} 残り ${best.left}${best.left <= PICK_LOW ? '（もうすぐ壊れる。canDig を減らすか予備を作る）' : ''}`;
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
    // Run 48 (hold 1): an ore the planner names by its id is one it asked to have dug (a stair that meets copper_ore); no category word (stone, dirt, sand, wood) ever includes one.
    else if (known(word) && (!NEVER_DIG.test(word) || ORE_ID.test(word)) && !PROTECTED_UTILITY_BLOCKS.has(word) && word !== 'water' && word !== 'lava') names.add(word);
    else ignored.push(word);
  }
  return { names, ignored };
}

/** Cheap building blocks: what a pack that dug through a mountain or the Nether holds in numbers, and may be told to lay (never ores, obsidian, planks or a crafting block). */
const BRIDGE_BLOCKS = /^(?:cobblestone|stone|cobbled_deepslate|deepslate|dirt|coarse_dirt|netherrack|basalt|smooth_basalt|blackstone|andesite|diorite|granite|tuff|calcite|end_stone|sandstone|red_sandstone|terracotta|nether_bricks|stone_bricks)$/u;
/**
 * The cheap blocks the pack holds that `canPlace` does not name, most first ("netherrack×99・basalt×7"), or '' when there are none (at least 4 of a kind).
 * S2 lab (c4, 244 m): a go with 64 stones stopped on `no_blocks` with 99 netherrack, dug on the way, in the pack; the stop said only "canPlace に足す".
 */
export function bridgeBlocksHeld(bot: any, given: readonly string[] | undefined): string {
  const named = new Set((given ?? []).map(name => String(name).replace(/^minecraft:/u, '').toLowerCase()));
  const counts = new Map<string, number>();
  for (const item of (bot.inventory?.items?.() ?? []) as any[]) {
    const name = String(item?.name ?? '');
    if (BRIDGE_BLOCKS.test(name) && !named.has(name)) counts.set(name, (counts.get(name) ?? 0) + Number(item.count ?? 0));
  }
  return [...counts.entries()].filter(([, count]) => count >= 4).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name, count]) => `${name}×${count}`).join('・');
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
/**
 * The fire that makes a place unsafe, or null: in the cell of the feet or the head, or beside them (a blaze's fireball leaves one on the floor of its spawner's room).
 * The dig hand puts a fire out in 0.2 s (S2 lab, 2026-11-02: `dig` at the fire's cell, the block was air after), so the line says where it is.
 */
export function fireNear(bot: any, x: number, y: number, z: number): Cell | null {
  return firesNear(bot, x, y, z)[0] ?? null;
}
function firesNear(bot: any, x: number, y: number, z: number): Cell[] {
  const fires: Cell[] = [];
  for (const [dx, dy, dz] of [[0, 0, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]) {
    const name = nameAt(bot, x + dx, y + dy, z + dz);
    if (name === 'fire' || name === 'soul_fire') fires.push({ x: x + dx, y: y + dy, z: z + dz });
  }
  return fires;
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

// ---- the Nether's pace (S8, 2026-11-05) --------------------------------------------------------------------------------------------------

/**
 * S8 (2026-11-05, the lab's Nether walks: 0.6 to 0.7 m a second, 460 digs on 233 m, a tunnel nearly all the way): in the Nether a dig is priced at this many times
 * its time. A tunnel step through netherrack (two blocks) then costs about as much, in the route search's steps, as the seconds it takes against a walk on the open
 * ground beside it (a dig and its look cost ~0.3 s, a step walked ~0.2 s), so the way goes over the open netherrack and round the hills, and through them only where
 * going round is much longer. A person runs on the netherrack and digs only what is in the way.
 */
export const NETHER_DIG_COST = 2.5;
/** S8: what laying a floor over lava (lava within two under the cell laid) costs more, in steps: the way round or through the rock beside is taken when there is one. */
export const LAVA_FLOOR_PLACE_COST = 4;
const isNether = (bot: any) => String(bot.game?.dimension ?? '').includes('nether');

/** The kinds that turn the sprint off within two cells of the feet (a slip at a run's pace ends in them). */
const SPRINT_HAZARD = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'powder_snow', 'wither_rose']);
/** Cells a body falls through (no box to stand on). */
const OPEN_NAME = /^(?:air|cave_air|void_air|short_grass|tall_grass|grass|fern|large_fern|[a-z_]*_roots|nether_sprouts|[a-z_]*vines(?:_plant)?|vine|snow|[a-z_]*_flower|dandelion|poppy|[a-z_]*_tulip|[a-z_]*_mushroom|dead_bush|[a-z_]*torch|fire|soul_fire|light)$/u;
/**
 * Why the sprint is off with the feet at (x, y, z), or null (S8, 2026-11-05): a hazard of SPRINT_HAZARD within two cells across, two down and one up; or, beside the
 * feet (the eight cells round), an open cell with no floor within `maxDrop` under it (a cliff, the void, or lava under it); or a cell not loaded there. `read` gives a
 * block's name or null when it is not loaded.
 */
export function sprintHazardAt(read: (x: number, y: number, z: number) => string | null, x: number, y: number, z: number, maxDrop: number): string | null {
  for (let dy = -2; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    const name = read(x + dx, y + dy, z + dz);
    if (name && SPRINT_HAZARD.has(name)) return `${name} が近い`;
  }
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (!dx && !dz) continue;
    const beside = read(x + dx, y, z + dz);
    if (beside === null) return '読み込まれていない所が隣';
    if (!OPEN_NAME.test(beside) && beside !== 'water') continue;
    let floor = false;
    for (let down = 1; down <= maxDrop + 1 && !floor; down++) {
      const name = read(x + dx, y - down, z + dz);
      if (name === null) return '読み込まれていない所が隣';
      if (name === 'lava') return '隣の下が溶岩';
      if (name === 'water' || !OPEN_NAME.test(name)) floor = true;
    }
    if (!floor) return '隣が崖';
  }
  return null;
}

/**
 * mineflayer-pathfinder's landing search reads down through the air until it meets a floor, however far below that is, and only then sees that the fall is too
 * long (search-timeout-causes-20261103.md, the second cause: 69 reads down a shaft for each move; over the Nether's lava sea, 30 to 60 cells of air under every
 * edge). With the liquid's fall bounded as any other (`infiniteLiquidDropdownDistance` false, the go's rule unless water is allowed), the reading stops at the
 * deepest landing allowed: what is found is the same, the search reads less.
 */
export function installBoundedLanding(movements: any): void {
  if (movements.__boundedLanding || typeof movements.getLandingBlock !== 'function') return;
  movements.__boundedLanding = true;
  const original = movements.getLandingBlock.bind(movements);
  movements.getLandingBlock = (node: any, dir: { x: number; z: number }) => {
    if (movements.infiniteLiquidDropdownDistance) return original(node, dir);
    const lowest = node.y - movements.maxDropDown;
    const minY = Number(movements.bot?.game?.minY ?? -64);
    let block = movements.getBlock(node, dir.x, -2, dir.z);
    while (block?.position && block.position.y > minY && block.position.y >= lowest) {
      if (block.liquid && block.safe) return block;
      if (block.physical) return movements.getBlock(block.position, 0, 1, 0);
      if (!block.safe) return null;
      block = movements.getBlock(block.position, 0, -1, 0);
    }
    return null;
  };
}

/** Whether lava lies within two cells under `cell` (the cell itself included): a floor laid there is a bridge over lava. */
/**
 * end1109 S9 (h32b, 17:10 and 17:12): the head gave a far place at y 80, the body raised it to the hilltop over it (y 106, about 90 m on), and the
 * route search, which priced a laid block at 2 steps, drew a staircase 16 high into the open air rather than the hill's own slope (16 laid for 16
 * steps, then limit_place on a column with nothing round it). A player walks up the hill; a block laid with AIR_LAY_DROP or more cells of air under
 * it (a stair or a bridge in the open air, not over water or lava) costs AIR_LAY_COST more in the overworld, so the ground's way comes first and the
 * laid one stays for a real gap.
 */
export const AIR_LAY_DROP = 4;
export const AIR_LAY_COST = 8;
const OPEN_AIR = /^(?:air|cave_air|void_air)$/;
/** The cells of air straight under `cell`, counted to AIR_LAY_DROP (unloaded and anything not air ends the count). */
export function airUnder(read: (x: number, y: number, z: number) => string | null, cell: Cell): number {
  let open = 0;
  while (open < AIR_LAY_DROP && OPEN_AIR.test(read(cell.x, cell.y - open - 1, cell.z) ?? '')) open++;
  return open;
}

export function overLava(read: (x: number, y: number, z: number) => string | null, cell: Cell): boolean {
  for (let down = 0; down <= 2; down++) if (read(cell.x, cell.y - down, cell.z) === 'lava') return true;
  return false;
}

/**
 * The cells that make a floor just laid over lava a bridge with walls (S8, 2026-11-05; the head's knowledge has said "a bridge with walls, never one a block wide"
 * since run 59, and go laid only the floor): on each side across the way (from the feet to the floor laid), a floor beside it and a wall over that at the feet's
 * height. A cell the route walks (its feet or head cells), or one that is not open, is left; a wall over a side floor that is not there is left too. The way is the
 * route's (the step over the floor laid and the one after or before it), else from the body (`from`, its position: it leans over the edge as it lays).
 */
export function bridgeSideCells(read: (x: number, y: number, z: number) => string | null, laid: Cell, from: { x: number; z: number }, route: readonly Cell[]): Array<{ floor: Cell | null; wall: Cell }> {
  let dx = 0, dz = 0;
  const index = route.findIndex(node => node.x === laid.x && node.y === laid.y + 1 && node.z === laid.z);
  const other = index >= 0 ? route[index + 1] ?? route[index - 1] : undefined;
  if (other) { dx = Math.sign(other.x - laid.x); dz = Math.sign(other.z - laid.z); if (!route[index + 1]) { dx = -dx; dz = -dz; } }
  if ((dx === 0) === (dz === 0)) {
    const ax = laid.x + 0.5 - from.x, az = laid.z + 0.5 - from.z;
    if (Math.max(Math.abs(ax), Math.abs(az)) < 0.05) return [];
    dx = Math.abs(ax) >= Math.abs(az) ? Math.sign(ax) : 0; dz = dx === 0 ? Math.sign(az) : 0;
  }
  const sides = dx !== 0 ? [{ x: 0, z: 1 }, { x: 0, z: -1 }] : [{ x: 1, z: 0 }, { x: -1, z: 0 }];
  const walked = new Set<string>();
  for (const node of route) { walked.add(`${node.x},${node.y},${node.z}`); walked.add(`${node.x},${node.y + 1},${node.z}`); }
  const open = (cell: Cell) => { const name = read(cell.x, cell.y, cell.z); return name !== null && (OPEN_NAME.test(name) || name === 'lava'); };
  const out: Array<{ floor: Cell | null; wall: Cell }> = [];
  for (const side of sides) {
    const floor = { x: laid.x + side.x, y: laid.y, z: laid.z + side.z };
    const wall = { x: floor.x, y: floor.y + 1, z: floor.z };
    if (walked.has(keyOf(wall)) || walked.has(keyOf(floor)) || !open(wall) || read(floor.x, floor.y, floor.z) === null) continue;
    out.push({ floor: open(floor) ? floor : null, wall });
  }
  return out;
}

// ---- no way back (run 62, S8 2026-11-05) -----------------------------------------------------------------------------------------------

/**
 * Run 62 (03:46:34, the synthesis's #21): with no pickaxe and no block left, a go with maxDrop 3 took the body down by drops of three into a Nether valley 16 below
 * its gate, and nothing brought it back up (a fall of two or more is climbed only by laying a block or digging a stair). Whether the body holds neither: no pickaxe,
 * and no block it could lay to climb (the cheap building blocks, or the ones the go may lay).
 */
export function strandedPack(bot: any, placeHeld: readonly string[] = []): boolean {
  const items = (bot.inventory?.items?.() ?? []) as Array<{ name?: string; count?: number }>;
  if (items.some(item => /_pickaxe$/u.test(String(item.name ?? '')) && Number(item.count ?? 0) > 0)) return false;
  return !items.some(item => Number(item.count ?? 0) > 0 && (BRIDGE_BLOCKS.test(String(item.name ?? '')) || placeHeld.includes(String(item.name ?? ''))));
}
/** A fall a body climbs back with nothing in its hands: one (a jump). */
export const STRANDED_MAX_DROP = 1;
/** With nothing to climb back with, a step onto a cell this body has not stood in (in this dimension) costs this much more: the way it came is the first way back. */
export const UNWALKED_COST = 0.5;
const WALKED_MAX = 6000;
const walkedCells = new WeakMap<object, Map<string, Set<string>>>();
/** The feet cells this body has stood in during its gos, by dimension (the last WALKED_MAX of each). */
export function walkedOf(host: object, dimension: string): Set<string> {
  let byDimension = walkedCells.get(host);
  if (!byDimension) { byDimension = new Map(); walkedCells.set(host, byDimension); }
  let cells = byDimension.get(dimension);
  if (!cells) { cells = new Set(); byDimension.set(dimension, cells); }
  return cells;
}
function noteWalked(host: object, dimension: string, key: string): void {
  const cells = walkedOf(host, dimension);
  cells.delete(key); cells.add(key);
  if (cells.size > WALKED_MAX) cells.delete(cells.values().next().value as string);
}

// ---- inside a Nether fortress (run 62, the synthesis's #22) ----------------------------------------------------------------------------

/** The blocks a Nether fortress's floors are made of. */
const FORTRESS_FLOOR = /^(?:nether_bricks|cracked_nether_bricks|chiseled_nether_bricks|nether_brick_slab|nether_brick_stairs)$/u;
/**
 * Run 62 (five deaths to wither skeletons in a fortress corridor three wide): a step onto a fortress's floor (nether bricks under the feet) with three or more of the
 * four sides open at the feet's height (a corridor, a bridge, a room) costs this much more. A person goes a level under the floor in a 1x2 tunnel, where a wither
 * skeleton (2.4 tall) does not follow and a blaze cannot shoot; a go that may dig (netherrack, nether_bricks) takes that way when it is not much longer. A cost, not a
 * ban: a go that may not dig walks the corridor still.
 */
export const FORTRESS_OPEN_COST = 6;
export function fortressOpenAt(read: (x: number, y: number, z: number) => string | null, x: number, y: number, z: number): boolean {
  const floor = read(x, y - 1, z);
  if (!floor || !FORTRESS_FLOOR.test(floor)) return false;
  let open = 0;
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const name = read(x + dx, y, z + dz);
    if (name !== null && (OPEN_NAME.test(name) || name === 'lava')) open++;
  }
  return open >= 3;
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

interface Relax { hazards?: boolean; tool?: boolean; blocks?: boolean; permissions?: boolean; limits?: boolean; upstream?: boolean; dragon?: boolean; /** the drop as asked (a stranded body's is cut to one) */ drops?: boolean }
export interface GoState {
  steps: number; dug: number; placed: number; redraws: number;
  veto: { code: string; text: string; hint?: string } | null;
  /** The blocks laid in a row that the world did not show. */
  refused: number;
  /** Run 46: the cells whose dig the exposure guard refused in this go ("x,y,z"): the hostile that the dig would have let at the body, and when. */
  exposed: Map<string, { name: string; distance: number; at: number }>;
  /** Run 45: the cells this go could not get into or lay in ("x,y,z"), avoided by the next drawings (`GO_AVOID_COST`). */
  avoid: Set<string>;
  /** Run 45 (hold 3): the cells this go dug, and those it laid ("x,y,z"): not laid again, not dug again (`GO_REDO_COST`). */
  dugCells: Set<string>;
  laidCells: Set<string>;
}

// ---- the movements ---------------------------------------------------------------------------------------------------------------------

export function goMovements(bot: any, args: Required<Pick<GoArgs, 'maxDrop' | 'waterOk' | 'maxDig' | 'maxPlace'>> & { sprint: boolean | 'auto'; stranded?: boolean }, rule: DigRule, placeHeld: string[], state: GoState, relax: Relax = {}): any {
  const mayDigAny = rule.names.size > 0 || !!relax.permissions;
  const mayPlaceAny = placeHeld.length > 0 || !!relax.blocks || !!relax.permissions;
  // (the library's exclusion lists are typed as one-element tuples; the rules below append to them)
  const nether = isNether(bot);
  // end1108h32 S9: with waterOk a step in water cost 1 + 4 and a laid step 1 + 2, so the search bridged a lake 13 m up (39 laid, about a block a
  // second) instead of dropping in and swimming (about 3 m/s). With leave to swim, a laid step costs more than a swum one.
  const movements: any = buildMovements(bot, false, args.sprint !== false, true, true, mayDigAny, true, nether ? NETHER_DIG_COST : 1, false, args.waterOk, args.maxDrop, args.waterOk ? 4 : 10, mayPlaceAny, args.waterOk ? 5 : 2);
  movements.maxDropDown = args.maxDrop + 1;
  movements.infiniteLiquidDropdownDistance = args.waterOk;
  movements.__allowMagma = !!relax.hazards;
  installBoundedLanding(movements);
  (movements as any).__sprintBase = !!movements.allowSprinting;
  // S8: with the sprint left to the body, no jump that only a sprint makes is planned (the sprint is let go of near a hazard, and such a jump would then fall short).
  if (args.sprint === 'auto' && typeof movements.getMoveParkourForward === 'function') {
    const parkour = movements.getMoveParkourForward.bind(movements);
    movements.getMoveParkourForward = (node: any, dir: { x: number; z: number }, neighbors: any[]) => {
      const found: any[] = [];
      parkour(node, dir, found);
      for (const move of found) if (Math.max(Math.abs(move.x - node.x), Math.abs(move.z - node.z)) <= 2) neighbors.push(move);
    };
  }
  installDoorRules(movements);
  installGroundSprint(movements, state.avoid);
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
    // Run 62 (#19): a stranded body (no pickaxe, no block) may dig the soft ones by hand: the stair up out of a valley is carved, not laid.
    if (!relax.tool && block.harvestTools && !items().some(item => canHarvest(block, item)) && !(args.stranded && handDigForWay(block, items()))) return false;
    return true;
  };
  // Run 47 (hold 10-11): when the walk may dig a block that falls (gravel, sand), the cell under one may be dug (what falls is dug in its turn); else it stays a wall of the search.
  if ([...rule.names].some(name => FALLING.test(name))) movements.dontMineUnderFallingBlock = false;
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
  // Run 62 (#22): the open floor of a fortress costs more than a tunnel a level under it.
  if (nether && !relax.hazards) {
    const kept = new Map<string, number>();
    (movements as any).exclusionAreasStep = [...((movements as any).exclusionAreasStep ?? []), (block: any) => {
      const p = block?.position;
      if (!p) return 0;
      const key = `${p.x},${p.y},${p.z}`;
      let cost = kept.get(key);
      if (cost === undefined) { cost = fortressOpenAt(read, p.x, p.y, p.z) ? FORTRESS_OPEN_COST : 0; kept.set(key, cost); }
      return cost;
    }];
  }
  // Run 62 (#21): with nothing to climb back with, the cells walked before are the first way (the way the body came is one it can go back by).
  if (args.stranded) {
    const walked = walkedOf(nativeActionHost(bot), String(bot.game?.dimension ?? ''));
    if (walked.size) (movements as any).exclusionAreasStep = [...((movements as any).exclusionAreasStep ?? []), (block: any) => {
      const p = block?.position;
      return p && !walked.has(`${p.x},${p.y},${p.z}`) ? UNWALKED_COST : 0;
    }];
  }
  // S8: in the Nether a floor laid over lava costs more (a bridge over the lava sea is where a ghast's blast or a push ends the run): the way round first.
  if (nether && !relax.hazards) {
    (movements as any).exclusionAreasPlace = [...((movements as any).exclusionAreasPlace ?? []), (block: any) => (block?.position && overLava(read, block.position) ? LAVA_FLOOR_PLACE_COST : 0)];
  }
  // end1109 S9: a block laid in the open air (a stair or bridge over AIR_LAY_DROP of air) costs more in the overworld than one on the ground.
  if (!nether && !isEnd(bot) && !relax.hazards) {
    const kept = new Map<string, number>();
    (movements as any).exclusionAreasPlace = [...((movements as any).exclusionAreasPlace ?? []), (block: any) => {
      const p = block?.position;
      if (!p) return 0;
      const key = `${p.x},${p.y},${p.z}`;
      let cost = kept.get(key);
      if (cost === undefined) { cost = airUnder(read, p) >= AIR_LAY_DROP ? AIR_LAY_COST : 0; kept.set(key, cost); }
      return cost;
    }];
  }
  // Run 45 (hold 3): what this go dug is not laid again, what it laid is not dug again (the way does not undo its own work).
  movements.exclusionAreasBreak = [...(movements.exclusionAreasBreak ?? []), (block: any) => redoCost(state.laidCells, block)];
  // (mineflayer-pathfinder's walk forward onto a laid floor asks the place's exclusion of the cell above the one it lays: both are asked.)
  movements.exclusionAreasPlace = [...(movements.exclusionAreasPlace ?? []), (block: any) => redoCost(state.dugCells, block, true)];
  // The End: the dragon's breath that lies in the world is not stepped into (a cell of it is no move: it hurts 6 a second and pushes the body off a bridge), unless the body stands in it now (the way out is then the first thing to find).
  // A body one block up (on a laid floor) is over the cloud's slab and is not in it.
  let clouds = relax.hazards || relax.dragon ? [] : lyingCloudZones(bot);
  if (clouds.length && bot.entity?.position && clouds.some(zone => cloudReaches(zone.centre, zone.radius, bot.entity.position, 0))) clouds = [];
  const perched = isEnd(bot) ? endDragonOf(bot) : null;
  // r105 windows 4/5: wing push was observed with HP 20 throughout the basin kill. Only the walking exclusion changes;
  // head/neck contact and existing/forecast breath stay excluded, and the floor reflex still interrupts this go.
  let clearPerch = !relax.hazards && !relax.dragon && perched && isPerched(dragonPhaseOf(bot, perched)) ? perchClearance(bot, perched, 0, false) : null;
  // Preserve the existing way OUT when already inside a danger; the floor reflex keeps ownership of urgent retreat.
  if (clearPerch && bot.entity?.position && !clearPerch(bot.entity.position)) clearPerch = null;
  // Moves that end in a hazard (beside lava, on magma...), or in water when it is not allowed, are not moves.
  if (relax.upstream) (movements as { __upstream?: boolean }).__upstream = true;
  const getNeighbors = movements.getNeighbors.bind(movements);
  const inWater = isWaterName(nameAt(bot, Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z)));
  movements.getNeighbors = (node: any) => {
    const body = bodyCellKeys(bot);
    return (getNeighbors(node) as any[]).filter(move => {
      // A diagonal ascent sweeps both orthogonal corners before reaching its landing.
      // Upstream clears the cheaper corner but does not check its footing: a failed
      // jump can then walk into a shaft (run 54). Keep supported diagonal stairs,
      // but make an exposed ascent approach cardinally or build its floor first.
      const dx = move.x - node.x, dz = move.z - node.z;
      if (move.y > node.y && Math.abs(dx) === 1 && Math.abs(dz) === 1) {
        const supported = (x: number, z: number) => movements.getBlock(node, x, 0, z).physical || movements.getBlock(node, x, -1, z).physical;
        if (!supported(dx, 0) || !supported(0, dz)) return false;
      }
      if (move.y <= node.y && Math.abs(dx) === 1 && Math.abs(dz) === 1 && !diagonalFooting(movements, node, dx, dz, move.toBreak)) return false;
      if (body && laysIn(move, body)) return false;
      if (!relax.hazards && hazardAtFeetWith(read, move.x, move.y, move.z)) return false;
      if (clouds.length && cloudZoneAtCell(clouds, move.x, move.y, move.z)) return false;
      if (clearPerch && !clearPerch({ x: move.x + 0.5, y: move.y, z: move.z + 0.5 })) return false;
      if (!args.waterOk && !inWater && (isWaterName(read(move.x, move.y, move.z)) || isWaterName(read(move.x, move.y + 1, move.z)))) return false;
      return true;
    });
  };
  return movements;
}

/**
 * Run 59 (leg 2, task 4 holds 2 and 3, the Nether at (25,65,4)): whether a level or falling diagonal from `node` by (dx, dz) keeps the body over ground. A corner that is a wall
 * (a block at the feet or the head that the move does not break) turns the body aside, and it goes through the other corner: that corner needs a floor. In the run the wall was
 * basalt and the other corner the edge of the lava sea (33 down): the body slid to the edge and stopped there, the executor's 3.5 s ran out and the way was drawn again. With both
 * corners open the body is over its own floor or its landing all the way, and the diagonal stays.
 */
export function diagonalFooting(movements: any, node: any, dx: number, dz: number, toBreak: readonly any[] = []): boolean {
  const broken = (x: number, y: number, z: number) => toBreak.some((p: any) => p && p.x === node.x + x && p.y === node.y + y && p.z === node.z + z);
  const wall = (x: number, z: number) => [0, 1].some(y => movements.getBlock(node, x, y, z).physical && !broken(x, y, z));
  const wallX = wall(dx, 0), wallZ = wall(0, dz);
  if (wallX === wallZ) return true;
  return wallX ? movements.getBlock(node, 0, -1, dz).physical : movements.getBlock(node, dx, -1, 0).physical;
}

/** "x,y,z" of the cells the body is in now by its middle (its feet and its head), or null. */
function bodyCellKeys(bot: any): string[] | null {
  const p = bot.entity?.position;
  if (!p) return null;
  const x = Math.floor(p.x), y = Math.floor(p.y + 1e-3), z = Math.floor(p.z);
  return [`${x},${y},${z}`, `${x},${y + 1},${z}`];
}

/**
 * Run 59 (leg 2, the same holds): the way stepped back out of the body's cell, laid a block in it and climbed onto it ((25,65,3), a block in (25,65,4), up to (25,66,4)). The
 * executor counts the step back as made when the body is nearer the cell after it (it trims the path from the player), so the block was sent with the body still in the cell: the
 * place guard held it back (`mayLayAt`), the same way was drawn again, 12 times, and the go stopped. A move that lays a block in one of `cells` is not a move.
 */
export function laysIn(move: any, cells: readonly string[]): boolean {
  return (move?.toPlace ?? []).some((p: any) => !p.useOne && cells.includes(`${p.x + p.dx},${p.y + p.dy},${p.z + p.dz}`));
}

// ---- the work ----------------------------------------------------------------------------------------------------------------------------
/** Verify a proposed route with go's real rules, without moving, digging or placing. */
export function goWalkRouteChecker(bot: any, deadline = Infinity): (route: Cell[]) => boolean {
  const state: GoState = { steps: 0, dug: 0, placed: 0, redraws: 0, veto: null, refused: 0,
    exposed: new Map(), avoid: new Set(), dugCells: new Set(), laidCells: new Set() };
  const movements = goMovements(bot, { maxDrop: 1, waterOk: false, maxDig: 0, maxPlace: 0, sprint: false }, digRuleOf(bot.registry, []), [], state);
  return route => {
    for (let i = 1; i < route.length; i++) {
      if (performance.now() >= deadline) return false;
      const from = route[i - 1], to = route[i];
      const moves = movements.getNeighbors({ ...from, remainingBlocks: 0 }) as any[];
      if (!moves.some(m => m.x === to.x && m.y === to.y && m.z === to.z && !(m.toBreak?.length) && !(m.toPlace?.length))) return false;
    }
    return route.length > 0;
  };
}


const distanceTo = (bot: any, cell: Cell) => Math.hypot(bot.entity.position.x - (cell.x + 0.5), bot.entity.position.y - cell.y, bot.entity.position.z - (cell.z + 0.5));
const goalOf = (cell: Cell, range: number) => range > 0 ? new goals.GoalNear(cell.x + 0.5, cell.y, cell.z + 0.5, range) : new goals.GoalBlock(cell.x, cell.y, cell.z);
const compositeOf = (cells: Cell[], range: number) => cells.length === 1 ? goalOf(cells[0], range) : new goals.GoalCompositeAny(cells.map(cell => goalOf(cell, range)));
const keyOf = (cell: Cell) => `${cell.x},${cell.y},${cell.z}`;
/**
 * Run 45 (hold 9, go 12 up to the gravel: the box 20261028T065719-act-jgr1d): the route was drawn again while the body was in the middle of a jump
 * (feet 8.2 over its floor at 7); the search started as if the body stood in the cell its feet were in, on the air it was jumping through, and the
 * first move laid (177,7,199) against that air. The server laid nothing there (the cobblestone came out in the clicked air cell 1.1 s later) and the
 * go stopped as refused. Whether the block clicked for a place is one a block can be laid against: a block of the world with a box (not air, not a
 * liquid, not a plant). Asked when the place is sent, not when the route is drawn: a bridge's next block is laid against the one before it, which
 * is not there yet when the route is drawn.
 */
export function hasFace(block: any): boolean {
  if (!block) return false;
  const name = String(block.name ?? '');
  if (/^(?:air|cave_air|void_air|water|lava)$/u.test(name)) return false;
  return block.boundingBox === undefined ? true : block.boundingBox === 'block';
}
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
/**
 * Run 45 (hold 8): whether a block may be laid in `cell` with the body where it is. Not when the body is in the air with its middle over the
 * cell's own column and the cell at or under its feet: that lays the block under the body, which a go's route never plans (it builds no tower), and which the server
 * refused in the run and in the lab with the body in the air over the cell, its feet 63.1 over a cell whose top is 63 (its own view of the body
 * is a tick behind). Nor when the body is in the cell (the box overlaps it): the server never takes a block in the body.
 */
export function mayLayAt(bot: any, cell: Cell): boolean {
  const p = bot.entity?.position;
  if (!p) return true;
  // In the air over the cell's own column (a body on the ground at the edge of a bridge leans its middle over the gap and lays the floor there,
  // which the server takes: the body is on its own floor, above the cell).
  const airborne = bot.entity?.onGround === false;
  if (airborne && Math.floor(p.x) === cell.x && Math.floor(p.z) === cell.z && cell.y <= Math.floor(p.y + 1e-3)) return false;
  return bodyOverlap(p, cell) <= 0;
}
/**
 * Run 45 (hold 8, the lab): a block of `allowed` in the hand before a place is sent, when what the hand holds is not one (a dig's tool took it).
 * True when one is held (or was put there); the place goes on either way, and a hand that cannot be filled says so in the box.
 */
export async function blockInHand(bot: any, allowed: readonly string[]): Promise<boolean> {
  const held = String(bot.heldItem?.name ?? '');
  if (!allowed.length || allowed.includes(held)) return true;
  const item = ((bot.inventory?.items?.() ?? []) as any[]).find(stack => allowed.includes(String(stack?.name ?? '')));
  if (!item) return false;
  try { await bot.equip(item, 'hand'); } catch { /* the place goes on, and is refused as before */ }
  const now = String(bot.heldItem?.name ?? '');
  blackBoxOf(bot)?.note('place_hand_fixed', { from: held || 'empty', to: now || 'empty' });
  return allowed.includes(now);
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
const THROUGH = /^(air|cave_air|void_air|water|lava|bubble_column|ladder|vine|scaffolding|cave_vines(_plant)?|twisting_vines(_plant)?|weeping_vines(_plant)?|kelp(_plant)?|seagrass|tall_seagrass)$/u;
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
  // Run 52 hold 4: waterOk lets the body swim in water, but no search node stands above a water floor.
  // Keep water-filled or climbable destination cells, and a permitted scaffold, for the search to decide.
  if (!placing && name === 'water') {
    const occupying = [cell, { x: cell.x, y: cell.y + 1, z: cell.z }].map(at => String(blockAt(bot, at)?.name ?? ''));
    if (occupying.every(Boolean) && !occupying.some(there => /^(water|bubble_column|ladder|vine|scaffolding|cave_vines(_plant)?|twisting_vines(_plant)?|weeping_vines(_plant)?)$/u.test(there))) {
      return `行き先 ${cellText(cell)} の足元 ${cellText(under)} は water で床にならない（水面の上には立てない）。足場を置くか、水中なら水のある高さを指定して`;
    }
  }
  if (THROUGH.test(name) || rule.names.has(name)) return null;
  const lower = blockAt(bot, { x: cell.x, y: cell.y - 2, z: cell.z });
  const stand = lower && lower.boundingBox === 'block' && !isDoorlike(String(lower.name));
  return `行き先 ${cellText(cell)} の足元 ${cellText(under)} は ${name} で床にならない（立てない・置けない）`
    + (stand ? `。${cellText(under)} なら ${String(lower.name).replace(/^minecraft:/u, '')} の上に立てる` : '');
}

/**
 * Run 47 (hold 6, a go to (190,-13,180), a clay cell with a clay cell over it, canDig stone and deepslate): the place itself is a block the go may not dig, and no search can end in
 * it: every one ran its 5 s out, six times. A place whose feet cell (or whose head's height, 1.8 over the feet) is a whole block that is not on the list of what may be dug is said at once,
 * with the nearest cell round it a body stands in. A slab, a carpet or a chest under the feet is stood on, a block the go may dig is dug.
 */
export function sealedAtWords(bot: any, cell: Cell, rule: Pick<DigRule, 'names'>, suggestNearby = true, allowWater = true): string | null {
  for (const dy of [0, 1]) {
    const at = { x: cell.x, y: cell.y + dy, z: cell.z };
    const block = blockAt(bot, at);
    if (!allowWater && block && isWaterName(String(block.name).replace(/^minecraft:/u, ''))) {
      return `行き先 ${cellText(cell)} の${dy ? '頭' : '足'} ${cellText(at)} は水中だが waterOk の許可が無い`
        + '|乾いた到着位置へ。入水が必要なら安全を確認して waterOk を指定';
    }
    if (!block || block.boundingBox !== 'block' || isDoorlike(String(block.name))) continue;
    const shapes: number[][] = Array.isArray(block.shapes) ? block.shapes : [];
    const tops = shapes.map(shape => Number(shape[4] ?? 1)), bottoms = shapes.map(shape => Number(shape[1] ?? 0));
    if (dy === 0 && tops.length && Math.max(...tops) < 0.99) continue;
    if (dy === 1 && bottoms.length && Math.min(...bottoms) >= 0.8) continue;
    const name = String(block.name).replace(/^minecraft:/u, '');
    if (rule.names.has(name)) {
      // Run 47 (hold 10-11): a block the walk may dig but the search does not break: lava beside it (the flow would come in; water beside it is let in: the body's footing and dam hold it), or a block that falls over it that may not be dug.
      const wet = ([[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]] as const).map(d => ({ x: at.x + d[0], y: at.y + d[1], z: at.z + d[2] }))
        .find(next => /^lava$/u.test(String(blockAt(bot, next)?.name ?? '')));
      const over = blockAt(bot, { x: at.x, y: at.y + 1, z: at.z });
      const falls = over && FALLING.test(String(over.name).replace(/^minecraft:/u, '')) && !rule.names.has(String(over.name).replace(/^minecraft:/u, ''));
      if (!wet && !falls) continue;
      const read2: BlockReader = (x, y, z) => { const found = blockAt(bot, { x, y, z }); return found ? mapBlockOf(found) : null; };
      let near2: Cell | null = null;
      if (suggestNearby) for (const d of NEAR_OFFSETS) { const around = { x: cell.x + d[0], y: cell.y + d[1], z: cell.z + d[2] }; if (standable(read2, around.x, around.y, around.z)) { near2 = around; break; } }
      const because = wet ? `隣の ${cellText(wet)} が ${String(blockAt(bot, wet)?.name)} で掘ると流れ込む` : `上の ${cellText({ x: at.x, y: at.y + 1, z: at.z })} が ${String(over.name)} で掘ると落ちてくる`;
      return `行き先 ${cellText(cell)}${dy ? `の頭 ${cellText(at)}` : ''} の ${name} は${because}`
        + `|${wet ? '溶岩を塞ぐか' : `canDig に ${String(over.name)} を足すか`}、${near2 ? `隣の立てる所 ${cellText(near2)} へ` : '別の行き先を'}`;
    }
    const read: BlockReader = (x, y, z) => { const found = blockAt(bot, { x, y, z }); return found ? mapBlockOf(found) : null; };
    let near: Cell | null = null;
    if (suggestNearby) for (const d of NEAR_OFFSETS) {
      const around = { x: cell.x + d[0], y: cell.y + d[1], z: cell.z + d[2] };
      if (standable(read, around.x, around.y, around.z)) { near = around; break; }
    }
    return `行き先 ${cellText(cell)}${dy ? `（頭の高さの ${cellText(at)}）` : ''} は ${name} で canDig に無い${near ? `。隣の立てる所 ${cellText(near)}` : ''}`
      + `|${near ? `隣の立てる所 ${cellText(near)} へ` : '立てる所（地表の高さ）を行き先に'}。掘り進むなら canDig に ${name}（遅い）`;
  }
  return null;
}

/**
 * Run 52 hold 1: a radius-1 goal one level inside a dirt hill, without canDig. Every acceptable feet cell was blocked, but only
 * exact-cell goals were checked, so two searches spent 5 s each and the second became a heavy search_timeout. Prove only the
 * bounded arrival space closed, using the route's own predicate; one open, diggable or unreadable cell leaves the search to decide.
 */
export function sealedGoalWords(bot: any, cell: Cell, range: number, rule: Pick<DigRule, 'names'>, allowWater = true): string | null {
  if (range < 1) return sealedAtWords(bot, cell, rule, true, allowWater);
  const goal = goalOf(cell, range), radius = Math.floor(range);
  let count = 0;
  for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) for (let dz = -radius; dz <= radius; dz++) {
    const candidate = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz };
    if (!goal.isEnd(new Vec3(candidate.x, candidate.y, candidate.z) as any)) continue;
    if (!sealedAtWords(bot, candidate, rule, false, allowWater)) return null;
    count++;
  }
  const words = sealedAtWords(bot, cell, rule, true, allowWater);
  return count && words ? `${range}m以内の到着候補${count}マス全てが塞がっている。${words}` : null;
}

/** What the water in a cell is when it flows ("水の流れ 2", "落ちる水"), or null: no water, a source or no block. */
export function flowingWaterAt(bot: any, cell: Cell | null): string | null {
  if (!cell) return null;
  const block = blockAt(bot, cell);
  if (!block || block.name !== 'water') return null;
  let level = 0;
  try { level = Number(block.getProperties?.()?.level ?? block.metadata ?? 0); } catch { level = Number(block.metadata ?? 0); }
  if (!Number.isFinite(level) || level === 0) return null;
  return level >= 8 ? '落ちる水' : `水の流れ ${level}`;
}

const AIR = /^(air|cave_air|void_air)$/u;
/**
 * end1109s02 S9 (the sea, 127-142 s): with waterOk the head named places on the sea's face (open air over water or kelp), and each was
 * refused as no_floor ("水面の上には立てない") three times running, a minute of a swim lost. A swimmer's place there is the water cell
 * under it. Its y, or null when the place and the cell over it are not both open air, or the cell under it holds no water.
 */
export function waterFaceBelow(bot: any, cell: Cell): number | null {
  const name = (y: number) => String(blockAt(bot, { x: cell.x, y, z: cell.z })?.name ?? '').replace(/^minecraft:/u, '');
  if (!AIR.test(name(cell.y)) || !AIR.test(name(cell.y + 1))) return null;
  return isWaterName(name(cell.y - 1)) ? cell.y - 1 : null;
}
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
/** How long a place whose answer is overdue (promptPlace gives up at 1.5 s) is waited for before it is called refused (S2 lab: a server 2.2 s late with the block). */
const LATE_ANSWER_MS = 3500;
/** The block the hand held shows in the cell a place was made for within LATE_ANSWER_MS: the server was only slow. False when the cell is still not it, or the act is stopped. */
async function laidLate(host: any, cell: Cell | null, blockName: string, stopped: () => boolean): Promise<boolean> {
  if (!cell || !blockName) return false;
  const at = new Vec3(cell.x, cell.y, cell.z);
  const until = Date.now() + LATE_ANSWER_MS;
  while (Date.now() < until && !stopped()) {
    if (String(host.blockAt?.(at, false)?.name ?? '') === blockName) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return String(host.blockAt?.(at, false)?.name ?? '') === blockName;
}

/**
 * Continue contracts (1, 12 decision on go): the cells round a place that shut the way, for the stop's `lastSearch.blockedAround`. The cells the body would stand in or pass
 * (the place's feet cell and the one over it, and the eight round each: 18), those that are solid and not on the list of what may be dug (`canDig`), nearest the place first, 8 at most.
 * A fact read from the world, never a choice: nothing is dug or laid for it.
 */
export function blockedAroundPlace(bot: any, aim: Cell, rule: Pick<DigRule, 'names'>): NonNullable<NonNullable<Progress['lastSearch']>['blockedAround']> {
  const found: Array<{ at: Cell; block: string; diggable: boolean; order: number }> = [];
  for (let dy = 0; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const at = { x: aim.x + dx, y: aim.y + dy, z: aim.z + dz };
    const block = blockAt(bot, at);
    if (!block || block.boundingBox !== 'block') continue;
    const name = String(block.name);
    const diggable = rule.names.has(name);
    if (diggable) continue;
    found.push({ at, block: name, diggable, order: Math.abs(dx) + Math.abs(dz) + dy * 0.5 });
  }
  return found.sort((a, b) => a.order - b.order).slice(0, 8).map(({ at, block, diggable }) => ({ at, block, diggable }));
}

/**
 * Where one go's seconds went (S8, 2026-11-05: the Nether walks ran 0.6 to 0.7 m a second and nobody knew whether the digging, the road searches or
 * the walking took the time). `searchMs`: this hand's own road searches (the route executor's searches while it walks are in `walkMs`); `walkMs`:
 * the route executor walking (its digs and places included); `digMs`, `placeMs`: the digs and places of the go (executor's and the hand's own);
 * `sprintMs`: the time the sprint key was down; `metres`: straight from where it began to where it ended.
 */
export interface GoTiming { totalMs: number; searchMs: number; walkMs: number; digMs: number; placeMs: number; climbMs: number; mendMs: number; sprintMs: number; digs: number; places: number; searches: number; metres: number; relays: number; walls: number }
const goTimings = new WeakMap<object, GoTiming>();
/** The timing of the last go this body made (for the lab's measures), or null. */
export function lastGoTiming(host: object): GoTiming | null { return goTimings.get(host) ?? null; }

/**
 * end1109f22: the drop the go was given (maxDrop above the default) is let past the edge guard while the go runs, so the route the
 * search drew down a rim is not held back at it (the guard still refuses lava, the void, and any landing that leaves under 8 points).
 * Not for a body that could not climb back (strandedPack), whose drops the go itself keeps to one.
 */
export async function go(ctx: StepContext, args: GoArgs): Promise<StepOutcome> {
  const edge = (ctx.bot as { edgeGuard?: { allowedDrop?: number } }).edgeGuard;
  const asked = Math.min(10, Math.max(0, Math.floor(args.maxDrop ?? GO_DEFAULTS.maxDrop)));
  if (!edge || asked <= GO_DEFAULTS.maxDrop || strandedPack(ctx.bot, placeNamesOf(ctx.bot, args.canPlace).held)) return goWalk(ctx, args);
  const was = edge.allowedDrop;
  edge.allowedDrop = asked + 1; // the route search drops maxDrop + 1 (goMovements)
  try { return await goWalk(ctx, args); } finally { edge.allowedDrop = was; }
}

async function goWalk(ctx: StepContext, args: GoArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const timing: GoTiming = { totalMs: 0, searchMs: 0, walkMs: 0, digMs: 0, placeMs: 0, climbMs: 0, mendMs: 0, sprintMs: 0, digs: 0, places: 0, searches: 0, metres: 0, relays: 0, walls: 0 };
  const timed = async <T>(key: 'searchMs' | 'walkMs' | 'climbMs' | 'mendMs', work: () => Promise<T>): Promise<T> => {
    const began = Date.now();
    try { return await work(); } finally { timing[key] += Date.now() - began; }
  };
  const nav = bot.pathfinder as any;
  if (!nav) return stopped(bot, 'no_pathfinder', '経路探索が無い体');
  const cells = (args.goals ?? []).slice(0, 8);
  if (!cells.length) return stopped(bot, 'invalid_input', 'go には to か goals が要る');
  const limits = {
    range: args.range ?? GO_DEFAULTS.range, maxDrop: args.maxDrop ?? GO_DEFAULTS.maxDrop, waterOk: args.waterOk === true, maxDig: args.maxDig ?? GO_DEFAULTS.maxDig,
    maxPlace: args.maxPlace ?? GO_DEFAULTS.maxPlace, sprint: args.sprint ?? bot.game?.dimension === 'overworld',
  };
  const startedAt = Date.now();
  const deadline = Math.min(ctx.deadline, startedAt + (args.seconds ?? GO_DEFAULTS.seconds) * 1000);
  const rule = digRuleOf(bot.registry, args.canDig);
  const searchCap = args.searchMs ?? 5000;
  /** What one search of the road is given (the stop says this long). */
  const searchSlice = args.searchMs === undefined ? Math.min(searchCap, SEARCH_SLICE_MS) : searchCap;
  const place = placeNamesOf(bot, args.canPlace);
  // end1109p11: in a roof hunt with ROOF_KEEP or fewer roof blocks, they are kept for the roof (huntEnderman's roofBlocksKeptFromGo); the stops name them.
  const keptForRoof = roofBlocksKeptFromGo(nativeActionHost(bot), bot, place.held);
  if (keptForRoof.length) {
    place.held = place.held.filter(name => !keptForRoof.includes(name));
    place.refused.push(...keptForRoof.map(name => `${name}（屋根用に ${ROOF_KEEP} 個以下なので取っておく）`));
  }
  // Run 62 (#21): no pickaxe and no block to climb with: no fall the body cannot climb back (a jump), the way it came first; the drop as asked is only for the stop's reason.
  const requestedDrop = limits.maxDrop;
  const stranded = strandedPack(bot, place.held);
  if (stranded && limits.maxDrop > STRANDED_MAX_DROP) limits.maxDrop = STRANDED_MAX_DROP;
  const state: GoState = { steps: 0, dug: 0, placed: 0, redraws: 0, veto: null, refused: 0, exposed: new Map(), avoid: new Set(), dugCells: new Set(), laidCells: new Set() };
  const start = feetCell(bot)!;
  const picksAtStart = pickaxesOf(bot);
  /** S8: the times this go cut its way itself at a point on the line (relay). */
  let relays = 0;
  // Continue contracts (1): the stop's progress in metres, from where the body began to where it stopped, and the last route search the go made.
  const startPosition = bot.entity?.position ? { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z } : null;
  let aims: Cell[] = cells;
  let lastSearch: NonNullable<Progress['lastSearch']> | undefined;
  const progressNow = (arrived = false): Progress => {
    const meters = meterProgress(bot, startPosition, aims);
    const search = lastSearch ? { ...lastSearch } : undefined;
    // A search that found no cell of a way and gave up: what shuts the place in, when it can be read (the place itself, not a guess).
    if (search && search.len === 0 && (search.status === 'timeout' || search.status === 'no_path') && bot.entity?.position) {
      try {
        const near = aims.reduce((best, cell) => (distanceTo(bot, cell) < distanceTo(bot, best) ? cell : best), aims[0]);
        const blocked = blockedAroundPlace(bot, near, rule);
        if (blocked.length) search.blockedAround = blocked;
      } catch { /* the stop stands without it */ }
    }
    return { ...meters, ...(arrived ? { left: 0 } : {}), work: { dug: state.dug, placed: state.placed },
      ...(search?.endM !== undefined ? { searchEndM: search.endM } : {}), ...(search ? { lastSearch: search } : {}) };
  };

  // ---- how a line ends (the contract's result lines) ----
  const packNote = fullPackWatch(bot);
  /** Fires this go put out beside or in its place or way (a blaze camp's cells burn again and again). */
  let doused = 0, fireRedraws = 0, fireWalks = 0;
  /** The fires that make the place unsafe, when fire is all that does (no lava or other hazard hidden beside it). */
  const placeFires = (cell: Cell): Cell[] => {
    const why = hazardAtFeet(bot, cell.x, cell.y, cell.z);
    if (!why || !/^(?:soul_)?fire /u.test(why)) return [];
    const withoutFire = (x: number, y: number, z: number) => { const name = nameAt(bot, x, y, z); return name === 'fire' || name === 'soul_fire' ? 'air' : name; };
    return hazardAtFeetWith(withoutFire, cell.x, cell.y, cell.z) ? [] : firesNear(bot, cell.x, cell.y, cell.z);
  };
  const fireWalkable = (cell: Cell): boolean => placeFires(cell).some(fire => distanceTo(bot, fire) <= FIRE_WALK_M);
  // end1108g S9: a far place inside the rock is walked to on the ground over it (buriedSurface); said in every line.
  const raised: string[] = [];
  const lowered: string[] = [];
  const raisedAt = new Set<number>();
  // end1109s02 S9: with waterOk a place on the water's face is the water cell under it (waterFaceBelow); said in every line.
  const sunk: string[] = [];
  if (limits.waterOk) {
    cells.forEach((cell, i) => {
      const y = waterFaceBelow(bot, cell);
      if (y === null) return;
      sunk.push(`${cellText(cell)}→y=${y}`);
      cells[i] = { ...cell, y };
    });
  }
  const tail = () => `${cellText(feetCell(bot) ?? start)} 道 ${state.steps} 歩・掘 ${state.dug}・置 ${state.placed}・引き直し ${state.redraws} 回${pickaxeWords(bot, picksAtStart, state.dug)}${raised.length ? `。地中の行き先を地表へ上げた: ${raised.join("、")}` : ""}${lowered.length ? `。宙の行き先を下の地面へ下ろした: ${lowered.join("、")}` : ""}${sunk.length ? `。水面の行き先を水の中へ下ろした: ${sunk.join("、")}` : ""}`;
  const fail = (code: string, reason: string, hint: string): StepOutcome => {
    const at = feetCell(bot) ?? start;
    const head = `go 止まった ${code}: `;
    // S2 lab (a Nether walk of 244 m on 64 stones, 63 of them laid in the leg before): the stop said "not_loaded" while the real reason was the stones being gone.
    // When the go laid blocks and the pack holds none of the kinds it was given to lay, the stop says so (whatever else it says), so the head fetches more.
    const spent = place.held.length > 0 && state.placed > 0 && code !== 'limit_place' && code !== 'no_blocks' && place.held.every(name => inventoryCount(bot, name) === 0);
    const why = spent ? `置く物 ${place.held.join('・')} を ${state.placed} 個置いて使い切った。${reason}` : reason;
    // end1108a S8b: on a Nether bridge the stones ran out with no netherrack in the pack, and the head dug its own bridge back for six stones.
    // The advice names the cheap blocks the pack already holds, and in the Nether the netherrack that lies all around.
    const gather = isNether(bot) ? '周りの netherrack を 30 個ほど掘り canPlace に足す' : '置く物を集めてからもう一度';
    // end1109 S9 (h32b): a go that stopped on a perch in the air says the way down first (the shaft, or back the way laid), and keeps it whole.
    const perch = spent ? null : airPerchHint(bot, new Vec3(at.x, at.y, at.z));
    // Review 11/9 07:40 (s9): the perch's way down took the place of every stop's own hint. It takes it only where the stop is about the
    // way on from the perch (no_floor, dead_end, not_loaded) in the overworld; after any other stop's hint it is added.
    const perchOnly = perch && /^(no_floor|dead_end|not_loaded)$/u.test(code) && !/nether|the_end/u.test(String(bot.game?.dimension ?? ''));
    const advice = spent && (code === 'not_loaded' || code === 'dead_end') ? noBlocksHint(gather) : perch ? (perchOnly || !hint ? perch : `${perch}。${hint}`) : hint;
    const full = packNote();
    const fixed = ` ${tail()}${doused ? `。火を ${doused} 個消した` : ''}${full ? `。${full}` : ''}`;
    // The contract's line: the code, the reason, where and the counts, then the hint; what does not fit of the 160 is cut from the back (the hint first).
    const room = 160 - head.length - fixed.length;
    const withHint = advice ? `。${advice}` : '';
    // With the blocks used up the advice is what moves the head on, so the reason is cut to keep it (the line names the used-up blocks first, so only the reason's tail goes).
    // On a perch the way down goes before the counts (what the act cuts from the back is then the counts, not the way down).
    const text = perch && why.length + withHint.length > room ? clip(`${head}${clip(why, 48)}${withHint}${fixed}`, 160)
      : why.length + withHint.length <= room ? `${head}${why}${fixed}${withHint}`
      : spent && room - withHint.length >= 24 ? `${head}${clip(why, room - withHint.length)}${fixed}${withHint}`
        : `${head}${clip(why, Math.max(24, room))}${fixed}`;
    return { ...stopped(bot, code, text, at, start), progress: progressNow(), data: { work: { dug: state.dug, placed: state.placed, steps: state.steps, redraws: state.redraws } } };
  };
  /** What a stop for want of blocks to lay says to do: name the cheap blocks the pack holds (dug netherrack, stone ...), else gather some. */
  const noBlocksHint = (fallback = '置ける物を集めるか、canPlace を足す'): string => { const held = bridgeBlocksHeld(bot, args.canPlace); return held ? `荷の ${held} を canPlace に足すか、集める` : fallback; };
  /** Run 5: the stream stopped by a block upstream (how many tries, and the last words: what was laid, or why nothing could be). */
  let streamDams = 0, streamWords = '', streamWhy = '';
  const arrived = (): StepOutcome => ({ ok: true, text: `go 着いた ${tail()}${doused ? `。火を ${doused} 個消した` : ''}${streamWords.startsWith('流れを止めた') ? `。${streamWords}` : ''}${(() => { const full = packNote(); return full ? `。${full}` : ''; })()}${(() => { const frames = framesInSight(bot); return frames ? `。${frames}` : ''; })()}`, at: feetCell(bot) ?? start, progress: progressNow(true),
    data: { work: { dug: state.dug, placed: state.placed, steps: state.steps, redraws: state.redraws } } });

  /** The stop at the time limit: when the body is held in flowing water, that is in the line (whatever the length of `seconds`). */
  const limitTime = (left: string): StepOutcome => {
    const wet = flowingWaterAt(bot, feetCell(bot));
    const held = wet ? `。流れる水の中（${cellText(feetCell(bot)!)} は ${wet}）で押し戻された` : '';
    return fail('limit_time', `${args.seconds ?? GO_DEFAULTS.seconds} 秒の上限に着いた（行き先まで あと ${left}m）${held}`, wet ? (streamWhy || '上流の水源を汲むかブロックで塞ぐか、別の道を') : 'seconds を増やすか、行き先を近くに');
  };

  // ---- fire in or beside a place is put out where the body can reach it (S2, S4's c1 camp: a blaze's fireballs light the cells round its camp again and again, each refusal was a dig of the planner's own) ----
  for (const cell of cells) {
    for (let round = 0; round < 4 && doused < FIRE_DOUSE_LIMIT; round++) {
      const why = hazardAtFeet(bot, cell.x, cell.y, cell.z);
      if (!why || !/^(?:soul_)?fire /u.test(why)) break;
      const fire = fireNear(bot, cell.x, cell.y, cell.z);
      if (!fire || distanceTo(bot, fire) > 4.2 || ctx.stop?.aborted) break;
      const out = await dig(ctx, { at: [fire], collect: false });
      if (!out.ok) break;
      doused++;
    }
  }
  // ---- the places: the ones nobody may stand in are dropped; none left is `unsafe` ----
  // S1 lab (2026-11-08, c1 camp beside the spawner): a place made unsafe only by fire a few metres off is kept: the body walks up to the
  // fire and puts it out (`douseAtPlaces` in the walk), as a player does. Before, the go refused it, and a fire lit mid-walk beside the
  // place made every search run out (search_timeout 1 m short, then 'unsafe' each try from 5.3 m, the dig's reach being 5).
  const safeCells = cells.filter(cell => !hazardAtFeet(bot, cell.x, cell.y, cell.z) || fireWalkable(cell));
  if (!safeCells.length) {
    const why = hazardAtFeet(bot, cells[0].x, cells[0].y, cells[0].z) ?? '危ない';
    // A fire is what the dig hand puts out (0.2 s): a spawner room's floor is dotted with them, and the place beside one is the place to fight from.
    const fire = /^(?:soul_)?fire /u.test(why) ? fireNear(bot, cells[0].x, cells[0].y, cells[0].z) : null;
    if (fire) return fail('unsafe', `行き先 ${cellText(cells[0])} は${why}（火の中・隣には行かない）`, `火 ${cellText(fire)} は dig で消せる。または別の行き先を`);
    return fail('unsafe', `行き先 ${cellText(cells[0])} は${why}（溶岩・火・マグマ・サボテン・ベリー・ウィザーローズとその隣には行かない）`, '別の行き先を');
  }
  // Run 44 (hold 1): a place over a plant nobody stands on is said at once (`floorlessAt`); one place of several that is such is dropped.
  // Run 45 (hold 1): a place in the air with nothing to lay under it (no canPlace held) is said at once too.
  const placing = place.held.length > 0;
  const grounded = limits.range < 1 ? safeCells.filter(cell => !floorlessAt(bot, cell, rule, placing)) : safeCells;
  if (!grounded.length) {
    // A portal's cell has no floor to ask for (an End portal is a sheet over lava): it is entered with walk, as its target, not with go.
    const portalCell = safeCells.find(cell => /^(end_portal|nether_portal|end_gateway)$/u.test(String(nameAt(bot, cell.x, cell.y, cell.z) ?? '')));
    if (portalCell) return fail('no_floor', `行き先 ${cellText(portalCell)} は ${nameAt(bot, portalCell.x, portalCell.y, portalCell.z)}（ポータルのマス。足場は要らない）`, 'ポータルは go でなく walk の的にして入る');
    const why = floorlessAt(bot, safeCells[0], rule, placing)!;
    return fail('no_floor', why, /なら .* の上に立てる$/u.test(why) ? 'その 1 つ下を行き先に' : /^行き先 .* は宙/u.test(why) ? '立てる所を行き先に（宙へ渡るなら canPlace）' : '別の行き先を');
  }
  // A whole closed arrival space is said before any search; a blocked centre alone never closes a radius goal.
  // Match goMovements: explicit permission or a body already in water may swim.
  // Reject only when every acceptable arrival cell is known incompatible.
  const waterAllowed = () => limits.waterOk || isWaterName(nameAt(bot, Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z)));
  // end1108h32 S9: a far place inside the rock (stone not in canDig, as the S9 knowledge asks) was refused here as sealed, dead_end twice
  // 199 m off, before the walk's raise to the ground over it (buriedSurface, in the loop below) ever ran. A far sealed place is raised first.
  // end1109s01b S9: legs of 10-47 m were given at the height of the feet while the ground rose (y 64 under a hill at 72). The sealed place
  // was refused, the hint said to add stone to canDig, and the walk tunnelled (16 steps for 29 dug). A near place sealed by the rules, with
  // open ground at most SEALED_NEAR_DEPTH over it, is raised to that ground too (said in the line); a deeper one, or one within
  // SEALED_NEAR_M, is left (an ore room or a cave the head means).
  const lifted = grounded.map(cell => {
    if (!sealedGoalWords(bot, cell, limits.range, rule, waterAllowed())) return cell;
    const far = Math.hypot(cell.x - start.x, cell.z - start.z) > 2 * BURIED_FAR_M;
    const ground = far ? buriedSurface(bot, cell) : buriedSurface(bot, cell, SEALED_NEAR_M, SEALED_NEAR_DEPTH);
    if (ground === null) return cell;
    raised.push(`${cellText(cell)}→y=${ground}`);
    return { ...cell, y: ground };
  });
  const open = lifted.filter(cell => !sealedGoalWords(bot, cell, limits.range, rule, waterAllowed()));
  if (!open.length) {
    const [why, hint] = sealedGoalWords(bot, lifted[0], limits.range, rule, waterAllowed())!.split('|');
    return fail('dead_end', why!, hint!);
  }
  const targets = open;
  aims = targets;
  const near = (): Cell => targets.reduce((best, cell) => (distanceTo(bot, cell) < distanceTo(bot, best) ? cell : best), targets[0]);
  const reached = () => atGoal(bot, compositeOf(targets, limits.range));
  // Continue contracts (1): within range of a place when the go began is the aim already held (nothing was moved, dug or laid).
  if (reached()) return { ...arrived(), goal: 'already', code: 'already_there' };

  // ---- the watchers: cells entered, blocks dug, blocks laid ----
  let lastCell = keyOf(start), manualBusy = false;
  // Run 43: the feet's heights of the last 1.5 s, for the top of a jump said with a refused place.
  const heights: Array<[number, number]> = [];
  const topOfJump = (): number | null => {
    const since = Date.now() - 1500;
    const recent = heights.filter(([at]) => at >= since).map(([, y]) => y);
    return recent.length ? Math.max(...recent) : null;
  };
  let lastTickAt = Date.now();
  // S8: the sprint left to the body is let go of where a slip at a run's pace would hurt (read once a cell); the route executor's own choice runs before this, each tick.
  let sprintCell = '', sprintHazard: string | null = null;
  const sprintGuard = () => {
    const feet = feetCell(bot);
    if (!feet) return;
    const key = keyOf(feet);
    if (key !== sprintCell) { sprintCell = key; sprintHazard = sprintHazardAt((x, y, z) => nameAt(bot, x, y, z), feet.x, feet.y, feet.z, limits.maxDrop); }
    const movements = nav.movements as { allowSprinting?: boolean; __sprintBase?: boolean } | undefined;
    if (movements && movements.__sprintBase !== undefined) movements.allowSprinting = movements.__sprintBase && !sprintHazard;
    if (sprintHazard && bot.controlState?.sprint) bot.setControlState?.('sprint', false);
  };
  /**
   * A route's movements, set with the sprint guard read at once (S1 lab 2026-11-08): a new movements is made with the sprint let on, and
   * left so until the next tick's guard, the executor's run began beside lava (an await more before the walk made the lane test sprint 4 s).
   */
  const useMovements = (movements: any) => { nav.setMovements(movements); if (limits.sprint === 'auto') sprintGuard(); };
  const onTick = () => {
    try {
      const tickAt = Date.now();
      if (bot.controlState?.sprint) timing.sprintMs += Math.min(200, tickAt - lastTickAt);
      lastTickAt = tickAt;
      if (limits.sprint === 'auto') sprintGuard();
      const y = Number(bot.entity?.position?.y);
      if (Number.isFinite(y)) { heights.push([Date.now(), y]); if (heights.length > 40) heights.shift(); }
      const feet = feetCell(bot);
      if (!feet) return;
      const key = keyOf(feet);
      if (key !== lastCell) { lastCell = key; noteWalked(nativeActionHost(bot), String(bot.game?.dimension ?? ''), key); state.steps++; if (state.steps % 4 === 0) ctx.progress?.(`${state.steps}歩・掘${state.dug}・置${state.placed}`); }
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
  /** The exposure guard refused a dig: the cell is written down, and a go that is refused cell after cell stops with the reason. */
  const exposedLog: Array<{ at: number; left: number }> = [];
  const noteExposed = (at: { x: number; y: number; z: number } | undefined, error: ThreatExposedError) => {
    const now = Date.now();
    let left = Infinity; try { left = distanceTo(bot, near()); } catch { /* unknown */ }
    exposedLog.push({ at: now, left });
    if (at) state.exposed.set(`${at.x},${at.y},${at.z}`, { name: error.threat.name, distance: error.threat.distance, at: now });
    blackBoxOf(host)?.note('exposed', { at: at ? [at.x, at.y, at.z] : null, threat: error.threat.name, m: Math.round(error.threat.distance), cells: state.exposed.size });
    const recent = [...state.exposed.values()].filter(entry => now - entry.at <= GO_EXPOSED_WINDOW_MS).length;
    const inWindow = exposedLog.filter(entry => now - entry.at <= GO_EXPOSED_WINDOW_MS);
    const noHeadway = inWindow.length > 0 && inWindow[0]!.left - left < GO_EXPOSED_HEADWAY_M;
    if (recent >= GO_EXPOSED_STOPS && noHeadway && !state.veto) {
      state.veto = { code: 'threat_exposed', text: exposedWords() };
      try { nav.setGoal?.(null); } catch { /* stopped below */ }
    }
  };
  /** In words, for the LLM that decides the next hand: who would see the body, and how many cells the guard held back. */
  const exposedWords = (): string => {
    const nearest = [...state.exposed.values()].sort((a, b) => a.distance - b.distance)[0];
    const first = [...state.exposed.keys()][0];
    return `${nearest?.name ?? '敵'}（約${(nearest?.distance ?? 0).toFixed(0)}m）から見える所を掘らないと進めない（守りが止めた ${state.exposed.size} マス${first ? ` (${first})` : ''}）`;
  };
  const countingDig = async function (this: unknown, ...rest: unknown[]) {
    const at = (rest[0] as { position?: { x: number; y: number; z: number } } | undefined)?.position;
    let result: unknown;
    const digBegan = Date.now();
    try { result = await originalDig.apply(host, rest); }
    catch (error) { if (counting && error instanceof ThreatExposedError) noteExposed(at, error); throw error; }
    finally { if (counting) { timing.digMs += Date.now() - digBegan; timing.digs++; } }
    if (counting) { state.dug++; lastWork = Date.now(); if (at) { state.dugCells.add(`${at.x},${at.y},${at.z}`); lastDugKey = `${at.x},${at.y},${at.z}`; } }
    return result;
  };
  /** A block the server did not take is not a floor: the route executor is not let walk on (run 40 bench: go went on over a refused place and fell four cells). */
  const refusedAt = new Map<string, number>();
  let lastDugKey = '';
  /** Set by a first refusal of a cell: the route is drawn again (the main loop looks at it right after the walk ends). */
  let drawAfterRefusal = false;
  const refusedPlace = (facts = '', cell: Cell | null = null) => {
    const times = cell ? (refusedAt.get(keyOf(cell)) ?? 0) + 1 : GO_REFUSED_SAME_CELL;
    if (cell) refusedAt.set(keyOf(cell), times);
    blackBoxOf(host)?.note('refused_place', { n: state.refused + 1, same: times, facts: facts.slice(0, 200), ...(cell ? { avoid: [cell.x, cell.y, cell.z] } : {}) });
    // The cell is not made dearer for the drawing that follows: a dearer cell sent the route down into the canyon beside it (a fall of six in the lab). The same place is tried again; refused twice, it stops.
    state.refused++;
    // Run 48 (hold 2): one refusal is drawn past (the cell is avoided, the route goes round or lays elsewhere); the same cell refused twice, or three refusals in a row, stops the go with what was seen.
    // Drawn past only where nothing is at stake: the body stands on the ground and the cell is at the level of its feet or above (a step it was to climb); a floor laid below the feet (a bridge over a gap)
    // is a stop at once, as the run 40 bench taught (the body at the edge falls).
    const feetY = Math.floor((bot.entity?.position?.y ?? 0) + 1e-3);
    const safeToDrawAgain = !!cell && cell.y >= feetY && bot.entity?.onGround !== false;
    if ((times >= GO_REFUSED_SAME_CELL || state.refused >= GO_REFUSED_PLACES || !safeToDrawAgain) && !state.veto) {
      const dug = lastDugKey ? `。直前に掘った (${lastDugKey})` : '';
      // The facts of the place (the face, the overlap, the jump) are in the black box's refused_place note; the line keeps to the cell, the count and the way out (160 characters).
      state.veto = { code: 'stuck', text: `置いたブロックが世界に現れない（置きを断られた ${cell ? `${cellText(cell)} に ${times} 回` : `${state.refused} 回`}${dug}）`, hint: '別の道か canPlace の物を変える' };
      try { nav.setGoal?.(null); } catch { /* stopped below */ }
    } else if (!state.veto) {
      drawAfterRefusal = true;
      try { nav.setGoal?.(null); } catch { /* drawn again below */ }
    }
    // The body is stopped where it stands at once: the next step of the route would be onto the block that is not there.
    letGo(bot);
  };
  const countingPlace = async function (this: unknown, ...rest: unknown[]) {
    const placeBegan = Date.now();
    try { return await countingPlaceTimed(...rest); } finally { if (counting) { timing.placeMs += Date.now() - placeBegan; timing.places++; } }
  };
  const countingPlaceTimed = async function (...rest: unknown[]) {
    let result: unknown;
    // Run 45 (hold 2, the lab, three times out of three): the route laid a block to step up onto in the cell before the feet while the body
    // stood 0.1 into that cell (overlap 0.91): the server refused it and the go stopped. The body steps back out of the cell first.
    const target = counting ? placedCell(rest[0], rest[1]) : null;
    if (target) await clearOfCell(host, target);
    // Run 45 (hold 8, q34 go 2 up to the surface): the route laid the floor of its next cell while the body, jumping over that very cell, was
    // straight above it (in the run 0.25 in it; in the lab 0.1 over its top, and refused all the same): the go stopped. Such a place is not sent
    // (it lays the block under the body, which no route of a go plans), and the route is drawn again from where the body really is. The go's
    // own climb (`pillarUp`, the manual work) lays under the body on purpose, at the top of its jump: it is not held back.
    // Run 45 (hold 9): a place against a block that is not there (the route drawn from the middle of a jump) is not sent either.
    // Run 48 (hold 2): the route was drawn again while a place of the old one was being made: a cell the new route walks through is not laid (the old route's floor, not this one's).
    const walked = target && lastRoute.some(cell => cell.x === target.x && cell.y === target.y && cell.z === target.z);
    if (target && walked && !manualBusy) {
      blackBoxOf(host)?.note('place_held_back', { at: [target.x, target.y, target.z], why: 'route_walks_it' });
      throw new Error('The place was not sent: the route draws a step through that cell');
    }
    const noFace = target && !hasFace(rest[0]);
    if (target && (noFace || !manualBusy && !mayLayAt(host, target))) {
      const p = host.entity?.position;
      blackBoxOf(host)?.note('place_held_back', { at: [target.x, target.y, target.z], why: noFace ? `no_face:${String((rest[0] as any)?.name ?? 'none')}` : 'body',
        overlap: p ? Number(bodyOverlap(p, target).toFixed(2)) : null,
        feet: p ? [Number(p.x.toFixed(2)), Number(p.y.toFixed(2)), Number(p.z.toFixed(2))] : null });
      throw new Error('The place was not sent: the body is in the cell');
    }
    // Run 45 (hold 8, the lab: 3 of 8 runs of the act): the place went out with the iron pickaxe in the hand, a dig of the route having taken the
    // hand for its tool between the route's equip and its place; the server laid nothing and the go stopped as refused. The block goes in first.
    if (target) await blockInHand(host, place.held);
    const at = host.entity?.position?.clone?.() ?? null;
    const facts = () => { const cell = placedCell(rest[0], rest[1]); return cell ? placeFacts(host, cell, topOfJump(), at ?? undefined) : ''; };
    const heldName = String(host.heldItem?.name ?? '');
    try { result = await originalPlace.apply(host, rest); }
    catch (error) {
      // The library gives up when the server's update does not come: that too is a place the server did not take (an interruption is not).
      if (counting && !/Action interrupted|Motor owner expired/u.test(String((error as Error)?.message))) {
        // S2 lab (c4, the Nether, a busy machine): the server answered 2.2 s late, the block showed 0.7 s after the 1.5 s wait ended, and the go had already been stopped as refused
        // (three of four such stops in a leg were this). An answer that is only late is waited for, up to LATE_ANSWER_MS; a block that shows is a block laid.
        const lateCell = placedCell(rest[0], rest[1]);
        if (/did not answer within|did not fire within/u.test(String((error as Error)?.message)) && await laidLate(host, lateCell, heldName, () => ctx.stop?.aborted === true)) {
          blackBoxOf(host)?.note('place_late', { at: lateCell ? [lateCell.x, lateCell.y, lateCell.z] : null });
          state.placed++; lastWork = Date.now(); state.refused = 0;
          if (lateCell) state.laidCells.add(keyOf(lateCell));
          return undefined;
        }
        refusedPlace(facts(), placedCell(rest[0], rest[1]));
      }
      throw error;
    }
    if (!counting) return result;
    if (await laidAt(host, rest[0], rest[1])) {
      state.placed++; lastWork = Date.now(); state.refused = 0;
      const laid = placedCell(rest[0], rest[1]);
      if (laid) state.laidCells.add(keyOf(laid));
      if (laid && !manualBusy) await wallTheBridge(laid);
      return result;
    }
    refusedPlace(facts(), placedCell(rest[0], rest[1]));
    throw new Error('The place was not taken');
  };
  /**
   * S8 (2026-11-05): a floor the route laid over lava in the Nether, under the next step, is given its walls: on each side across the way a floor beside it and a block
   * over that at the feet's height (bridgeSideCells), laid at once from where the body stands, before the route walks on. Within maxPlace and what the pack holds;
   * a wall that is not laid is noted and the go goes on (the floor is what the route needs).
   */
  /** Walls laid, walls left, and the places of walls the server refused (two refused: no more walls in this go, each refusal costs the place's wait). */
  let walls = 0, wallsSkipped = 0, wallsRefused = 0;
  const wallTheBridge = async (laid: Cell): Promise<void> => {
    try {
      if (!isNether(host) || wallsRefused >= 2) return;
      const feet = feetCell(host);
      const reader = (x: number, y: number, z: number) => nameAt(host, x, y, z);
      if (!feet || laid.y !== feet.y - 1 || !overLava(reader, { x: laid.x, y: laid.y - 1, z: laid.z })) return;
      for (const side of bridgeSideCells(reader, laid, host.entity.position, lastRoute)) {
        for (const [cell, against, face] of [...(side.floor ? [[side.floor, laid, new Vec3(side.floor.x - laid.x, 0, side.floor.z - laid.z)] as const] : []),
          [side.wall, side.floor ?? { x: side.wall.x, y: side.wall.y - 1, z: side.wall.z }, new Vec3(0, 1, 0)] as const]) {
          if (state.placed >= limits.maxPlace || !place.held.some(name => inventoryCount(host, name) > 0) || ctx.stop?.aborted) { wallsSkipped++; return; }
          if (!mayLayAt(host, cell)) { wallsSkipped++; break; }
          const reference = host.blockAt?.(new Vec3(against.x, against.y, against.z), false);
          if (!hasFace(reference)) { wallsSkipped++; break; }
          await blockInHand(host, place.held);
          const began = Date.now();
          try { await originalPlace.call(host, reference, face); } catch { /* looked at below */ }
          timing.placeMs += Date.now() - began; timing.places++;
          if (isAirLike(host.blockAt?.(new Vec3(cell.x, cell.y, cell.z), false)) || host.blockAt?.(new Vec3(cell.x, cell.y, cell.z), false)?.name === 'lava') { wallsSkipped++; wallsRefused++; break; }
          state.placed++; state.laidCells.add(keyOf(cell)); lastWork = Date.now();
          if (cell === side.wall) walls++;
        }
      }
    } catch (error) {
      blackBoxOf(host)?.note('bridge_wall_failed', { at: [laid.x, laid.y, laid.z], why: String((error as Error)?.message ?? error).slice(0, 80) });
    }
  };
  if (typeof originalDig === 'function') host.dig = countingDig;
  if (typeof originalPlace === 'function') host.placeBlock = countingPlace;
  // A drawing again: the path was reset because something went wrong with it (not for the block it dug itself, nor a chunk arriving).
  const timedOutAt = new Set<string>();
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

  const movementsFor = (relax: Relax = {}) => goMovements(bot, { ...limits, ...(relax.drops ? { maxDrop: requestedDrop } : {}), stranded }, rule, place.held, state, relax);
  const timeLeft = () => deadline - Date.now();
  const limitStop = (): StepOutcome | null => {
    if (timeLeft() <= 0) return limitTime(near() ? distanceTo(bot, near()).toFixed(0) : '?');
    return null;
  };
  /**
   * What a stop at the place limit says to do. Without waterOk the search lays a bridge over any water on the way (end1108h32 S9: 39 laid 13 m
   * over a lake, and the stop said only to raise maxPlace): the swim is named first.
   */
  const placeMore = (hint: string): string => limits.waterOk ? hint : `水・谷を渡るなら waterOk で下りて泳ぐ（橋は 1 秒に 1 個で遅い）。陸なら ${hint}`;
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
  const VETO_HINTS: Record<string, string> = { limit_dig: 'maxDig を増やすか、別の道を', limit_place: placeMore('maxPlace を増やすか、別の道を'), stuck: '別の道か別の行き先を（同じ手の繰り返しは同じ所で止まる）', threat_exposed: '敵が離れるのを待つか、別の道・行き先を' };
  const vetoed = (): StepOutcome | null => state.veto ? fail(state.veto.code, state.veto.text, state.veto.hint ?? VETO_HINTS[state.veto.code] ?? '別の道を') : null;

  const notes: WayNotes = { opened: [], leaves: 0 };
  // Work that holds the body still on purpose: its own dig or climb, or the executor digging or laying, as long as something has been dug or laid in the last 5 s.
  const busy = () => manualBusy || ((!!nav.isMining?.() || !!nav.isBuilding?.()) && Date.now() - lastWork < 5000);

  /** The route found without walking it: its status and the cells it breaks and fills. */
  const plan = async (movements: any, goal: any, ms: number, track = true): Promise<Plan> => {
    toolKept.clear();
    const searchStarted = Date.now();
    timing.searches++;
    const generator = nav.getPathFromTo(movements, bot.entity.position, goal, { timeout: Math.max(300, Math.min(ms, searchSlice)) });
    let result = generator.next().value?.result ?? { status: 'noPath', path: [] };
    // The search answers a tick (40 ms) at a time while it is still going; here it is let finish (its own time bounds it), the body's other work
    // (its packets, its physics, the act's watch) getting its turn between the ticks.
    // A stop (a reflex's, the stopIf's, the end of the command) ends the search at once: a cancelled act that goes on searching holds the body still (lab r54: five seconds of a search
    // for a way nobody wanted any more, a dragon's fireball on the body that stood waiting for the reflex to be let in).
    for (let rounds = 0; result.status === 'partial' && rounds < 2000; rounds++) {
      if (ctx.stop.aborted) throw new StepStopped(String(ctx.stop.reason ?? 'stopped'));
      await yieldNow();
      result = generator.next().value?.result ?? result;
    }
    if (ctx.stop.aborted) throw new StepStopped(String(ctx.stop.reason ?? 'stopped'));
    const digs = new Map<string, number>();
    let places = 0;
    for (const node of result.path ?? []) {
      for (const cell of node?.toBreak ?? []) { const name = nameAt(bot, cell.x, cell.y, cell.z) ?? '?'; digs.set(name, (digs.get(name) ?? 0) + 1); }
      places += node?.toPlace?.length ?? 0;
    }
    timing.searchMs += Date.now() - searchStarted;
    const found: Plan = { status: String(result.status), path: result.path ?? [], digs, places, visited: Number(result.visitedNodes ?? 0) };
    // The route searches that decide the stop are kept (the lifted-rule searches that only name a reason are not): its status, the cells of the way, the nodes, the time, and
    // how far from the places the way's end was (the "あと 10m" of a search that ran out).
    if (track) {
      const tip = found.path.length ? nodeCell(found.path[found.path.length - 1]) : null;
      const endM = tip ? Math.min(...targets.map(cell => Math.hypot(tip.x - cell.x, tip.y - cell.y, tip.z - cell.z))) : undefined;
      lastSearch = { status: found.status === 'success' ? 'success' : found.status === 'partial' ? 'partial' : found.status === 'timeout' ? 'timeout' : 'no_path',
        len: found.path.length, nodes: found.visited, ms: Date.now() - searchStarted, ...(endM !== undefined ? { endM: round1(endM) } : {}) };
    }
    return found;
  };

  /** The way is shut: look again with each rule lifted in turn, and name the first whose lifting opens it. */
  /** The search ran out of its time: no way is known, nor that there is none. What it saw, and the next hands that do not need the search. */
  const searchedOutStop = (found: Plan, aim: Cell): StepOutcome => {
    // Run 47 (hold 10-11): a place the search cannot get into (a cell it may not break) runs every search out; the cell is named instead.
    const sealed = targets.map(cell => sealedGoalWords(bot, cell, limits.range, rule, waterAllowed()));
    if (sealed.every(words => words !== null)) { const [why, hint] = sealed[0]!.split('|'); return fail('dead_end', why!, hint!); }
    const tip = found.path.length ? found.path[found.path.length - 1] : null;
    const tipCell = tip ? nodeCell(tip) : null;
    const reach = tipCell ? `、${cellText(tipCell)} まで・あと ${Math.hypot(tipCell.x - aim.x, tipCell.y - aim.y, tipCell.z - aim.z).toFixed(0)}m` : '';
    return fail('search_timeout', `道探しが ${(searchSlice / 1000).toFixed(searchSlice < 1000 ? 2 : searchSlice % 1000 ? 1 : 0)} 秒で終わらない（道の有無は不明。${found.visited.toLocaleString('en-US')} マス調べた${reach}）`,
      relays ? `体が中継点（${relays} 回）でも進めなかった。別の行き先か、dig と walk の階段・縦穴で` : '同じ方角の 20〜40m 先の立てる所を中継点にして go を出し直すか、dig と walk の階段・縦穴で（1 マスずつ手で掘ると 1 分に数 m しか進まない）');
  };

  /**
   * Every place unsafe for fire beside it (a blaze's fireballs light the camp's cells mid-walk): the fires in reach are put out, else the
   * body walks to within 3 m of the nearest (at most FIRE_WALKS times a go) and puts it out there. A place that stays unsafe is said
   * as before ('unsafe', where the fire is). Null when a place is clear (or unsafe for something else, which the search keeps to).
   */
  const douseAtPlaces = async (): Promise<StepOutcome | null> => {
    for (let round = 0; round < 12; round++) {
      if (ctx.stop?.aborted) throw new StepStopped(String(ctx.stop.reason ?? 'stopped'));
      if (targets.some(cell => !hazardAtFeet(bot, cell.x, cell.y, cell.z))) return null;
      const fires = new Map<string, Cell>();
      for (const cell of targets) for (const fire of placeFires(cell)) fires.set(keyOf(fire), fire);
      if (!fires.size) return null;
      const byDistance = [...fires.values()].sort((a, b) => distanceTo(bot, a) - distanceTo(bot, b));
      const inReach = byDistance.filter(fire => distanceTo(bot, fire) <= 4.2);
      const refused = (why: string) => fail('unsafe', `行き先 ${cellText(targets[0])} は火の隣で、${why}`, `火 ${cellText(byDistance[0]!)} は dig で消せる。または別の行き先を`);
      if (inReach.length) {
        if (doused >= FIRE_DOUSE_LIMIT) return refused(`火を ${doused} 個消してもまた付く`);
        let out = 0;
        manualBusy = true;
        try {
          for (const fire of inReach) { if (doused >= FIRE_DOUSE_LIMIT) break; if ((await dig(ctx, { at: [fire], collect: false })).ok) { doused++; out++; } }
        } finally { manualBusy = false; }
        if (!out) return refused(`火 ${cellText(inReach[0]!)} が消せない`);
        continue;
      }
      const nearest = byDistance[0]!;
      if (distanceTo(bot, nearest) > FIRE_WALK_M) return refused(`火が ${distanceTo(bot, nearest).toFixed(1)}m 先（${FIRE_WALK_M}m より遠くへは消しに行かない）`);
      if (fireWalks >= FIRE_WALKS || timeLeft() < 1500) return refused(`火に ${fireWalks} 回近づいても消しきれない`);
      fireWalks++;
      state.redraws++;
      manualBusy = true;
      try { await timed('walkMs', () => goWith(ctx, new goals.GoalNear(nearest.x, nearest.y, nearest.z, 3), Math.min(8000, timeLeft()), notes, { stuckMs: GO_STUCK_MS, busy, onRoute: watchRoute, onGround: true })); }
      finally { manualBusy = false; letGo(bot); }
      const blocked = vetoed();
      if (blocked) return blocked;
      if (distanceTo(bot, nearest) > 4.2) return refused(`火 ${cellText(nearest)} の近くへ行けない（あと ${distanceTo(bot, nearest).toFixed(1)}m）`);
    }
    return null;
  };

  // Raid4 (2026-11-05): fireballs shut the way to cover. Only fire on the lifted way is put out; the next drawing keeps every hazard rule.
  const douseWay = async (found: Plan): Promise<StepOutcome | null> => {
    const blocked = () => fail('lava', '道の先が溶岩・火・マグマ・サボテンなどで、避けると道が無い', '別の行き先か、別の側から');
    const way = found.path.map(node => nodeCell(node));
    const withoutFire = (x: number, y: number, z: number) => {
      const name = nameAt(bot, x, y, z);
      return name === 'fire' || name === 'soul_fire' ? 'air' : name;
    };
    // Read again with just fire absent: a fire must not hide lava or another hazard in the same cell's surroundings.
    if (way.some(cell => hazardAtFeetWith(withoutFire, cell.x, cell.y, cell.z))) return blocked();
    const clouds = lyingCloudZones(bot);
    if (!clouds.some(zone => cloudReaches(zone.centre, zone.radius, bot.entity.position, 0))
      && way.some(cell => cloudZoneAtCell(clouds, cell.x, cell.y, cell.z))) return blocked();
    const fires = new Map<string, Cell>();
    for (const cell of way) for (const fire of firesNear(bot, cell.x, cell.y, cell.z)) fires.set(keyOf(fire), fire);
    if (!fires.size) return blocked();
    const before = doused;
    if (fireRedraws < 2) {
      for (const fire of fires.values()) {
        if (doused >= 8 || ctx.stop?.aborted) break;
        const name = nameAt(bot, fire.x, fire.y, fire.z);
        if ((name !== 'fire' && name !== 'soul_fire') || distanceTo(bot, fire) > 4.2) continue;
        manualBusy = true;
        try { const out = await dig(ctx, { at: [fire], collect: false }); if (out.ok) doused++; }
        finally { manualBusy = false; }
      }
    }
    if (doused > before) { fireRedraws++; return null; }
    const fire = [...fires.values()].find(cell => distanceTo(bot, cell) > 4.2) ?? [...fires.values()][0]!;
    return fail('lava', `火 ${cellText(fire)} が道を塞いでいる（${distanceTo(bot, fire) > 4.2 ? '届かない' : '消しても道が開かない'}）`, '別の行き先か、別の側から');
  };

  const explain = async (goal: any): Promise<StepOutcome | null> => {
    const ms = Math.min(args.searchMs ?? 2500, Math.max(300, timeLeft() - 500));
    const shown = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, count]) => `${name}×${count}`).join('・');
    const ignored = rule.ignored.length ? `（無視した canDig: ${rule.ignored.slice(0, 3).join('・')}）` : '';
    const lifts: Array<[Relax, (found: Plan) => StepOutcome | Promise<StepOutcome | null>]> = [
      ...(lyingCloudZones(bot).length || (endDragonOf(bot) && isPerched(dragonPhaseOf(bot, endDragonOf(bot)))) ? [[{ dragon: true }, () => fail('dead_end', '道の先が竜の息の雲・止まり木の接触か息の予告の中で、避けると道が無い', '現在の phase・dragonBreath・approach を見て別の行き先か、別の側から')] as [Relax, (found: Plan) => StepOutcome]] : []),
      ...(stranded && requestedDrop > limits.maxDrop ? [[{ drops: true }, () => fail('no_return', `ツルハシもブロックも無いので、登って戻れない降り（${STRANDED_MAX_DROP + 1} 段以上）は取らない。この道は降りると戻れない`,
        '来た道で戻るか、ブロック（丸石・ネザーラック）かツルハシを手に入れてから')] as [Relax, (found: Plan) => StepOutcome]] : []),
      [{ hazards: true }, douseWay],
      ...(state.dug >= limits.maxDig || state.placed >= limits.maxPlace ? [[{ limits: true }, () => state.dug >= limits.maxDig
        ? fail('limit_dig', `掘る数の上限 ${limits.maxDig} に着いた（この先にも掘る所がある）`, 'maxDig を増やすか、別の道を')
        : fail('limit_place', `置く数の上限 ${limits.maxPlace} に着いた（この先にも置く所がある）`, placeMore('maxPlace を増やすか、別の道を'))] as [Relax, (found: Plan) => StepOutcome]] : []),
      [{ upstream: true }, () => fail('dead_end', '道は流れる水を天井の下で上流へ遡る一歩だけ（押し戻されて進めない）', '上流の水源を汲むかブロックで塞ぐか、別の道を')],
      [{ tool: true }, found => fail('no_tool', `${shown(found.digs) || '掘る所'} を掘る道だが、持っている道具では掘れない`, 'ツルハシなどを手に入れるか、別の道を')],
      ...(args.canPlace?.length ? [[{ blocks: true }, (found: Plan) => fail('no_blocks',
        `置く物が足りない（置く所 ${found.places}、持っている ${place.held.map(name => `${name}×${inventoryCount(bot, name)}`).join('・') || '無し'}${place.missing.length ? `、持っていない ${place.missing.join('・')}` : ''}${place.refused.length ? `、置かない ${place.refused.join('・')}` : ''}）`,
        noBlocksHint())] as [Relax, (found: Plan) => StepOutcome]] : []),
      [{ permissions: true }, found => fail('dead_end', `許した手では道が無い。${found.digs.size ? `canDig に ${[...found.digs.keys()].slice(0, 3).join('・')} を許せば掘 ${[...found.digs.values()].reduce((a, b) => a + b, 0)} で` : ''}${found.places ? `canPlace を許せば置 ${found.places} で` : ''}道がある${ignored}`, '許すか、別の行き先を')],
    ];
    // The way with the rules as given was searched to its end and is shut (a search that ran out of time never comes here); a lifted search
    // that runs out only leaves the reason unnamed.
    for (const [relax, outcome] of lifts) {
      if (timeLeft() < 800) break;
      let found: Plan | null = null;
      try { found = await plan(movementsFor(relax), goal, ms, false); } catch { found = null; }
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
      if (!block) return { levels, stop: fail('no_blocks', `登るのに置く物が無い（${place.missing.length ? `持っていない ${place.missing.join('・')}` : 'canPlace に置ける物が無い'}）`, noBlocksHint()) };
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
          : `足元 ${cellText(short.cell)} が ${short.name} で、跳んでも積む土台が無い（隣の丸ごとの床も無い）${short.name === 'water' ? waterExitText(bot, feet) : ''}`, '丸ごとの床の所へ動いてから登る') };
      }
      feet = feetCell(bot)!;
      const roof = { x: feet.x, y: feet.y + 2, z: feet.z };
      const roofBlock = blockAt(bot, roof);
      if (roofBlock && !isAirLike(roofBlock) && roofBlock.name !== 'water' && roofBlock.name !== 'lava') {
        const above = nameAt(bot, roof.x, roof.y + 1, roof.z);
        if (!rule.names.has(roofBlock.name) || state.dug >= limits.maxDig) {
          return { levels, stop: fail(state.dug >= limits.maxDig ? 'limit_dig' : 'dead_end',
            state.dug >= limits.maxDig ? `掘る数の上限 ${limits.maxDig} に着いた（残り 0）。頭の上 ${cellText(roof)} が ${roofBlock.name} で登れない`
              : `頭の上 ${cellText(roof)} が ${roofBlock.name} で登れない（掘ってよい物に無い）`,
            state.dug >= limits.maxDig ? '別の場所から' : 'canDig に足すか、別の場所から') };
        }
        if (above && FALLING.test(above)) return { levels, stop: fail('dead_end', `頭の上 ${cellText(roof)} を掘ると、その上の ${above} が落ちてくる`, '別の場所から') };
        manualBusy = true;
        let dug: StepOutcome;
        try { dug = await dig(ctx, { at: [roof], collect: false }); } finally { manualBusy = false; }
        if (!dug.ok) return { levels, stop: fail(dug.reason === 'lava_behind' ? 'lava' : 'dead_end', dug.text.slice(0, 90), '別の場所から') };
      }
      // Run 59 (hold 3): a rail (or a torch, a flower) in the feet cell takes the level's block: it is dug like the roof when canDig allows,
      // otherwise the climb says which block stops it (it once jumped twice over a mineshaft's rail and said only that the jump fell short).
      const blocker = climbBlocker(bot, feetCell(bot)!);
      if (blocker) {
        if (!rule.names.has(blocker.name) || state.dug >= limits.maxDig) {
          return { levels, stop: fail(state.dug >= limits.maxDig ? 'limit_dig' : 'dead_end',
            state.dug >= limits.maxDig ? `掘る数の上限 ${limits.maxDig} に着いた（残り 0）。${blocker.words}` : `${blocker.words}（掘ってよい物に無い）`,
            state.dug >= limits.maxDig ? '別の場所から' : `canDig に ${blocker.name} を足すか、別の場所から`) };
        }
        manualBusy = true;
        let dug: StepOutcome;
        try { dug = await dig(ctx, { at: [blocker.cell], collect: false }); } finally { manualBusy = false; }
        if (!dug.ok || climbBlocker(bot, feetCell(bot)!)) return { levels, stop: fail('dead_end', dug.ok ? `${blocker.words}（掘っても残った）` : dug.text.slice(0, 90), '別の場所から') };
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
  /**
   * S8 (2026-11-05; S4's c1 lab: 144 m, one of four ended 44 m short on search_timeouts in a row; 249 m, four search_timeouts): the same search from the same place ran
   * out of its time twice, and the part it found comes no nearer. The body cuts the way itself: a point on the straight line 24 m on (then 12 m), any height within
   * 3 across, searched and walked, and the place is searched again from there. At most GO_RELAYS times a go, each must come 2 m nearer the place.
   */
  const relay = async (aim: Cell): Promise<boolean> => {
    if (relays >= GO_RELAYS) return false;
    const p = bot.entity?.position;
    if (!p) return false;
    const across = Math.hypot(aim.x + 0.5 - p.x, aim.z + 0.5 - p.z);
    for (const step of RELAY_STEPS_M) {
      if (across <= step + 3 || timeLeft() < 3000) continue;
      const x = Math.floor(p.x + ((aim.x + 0.5 - p.x) / across) * step), z = Math.floor(p.z + ((aim.z + 0.5 - p.z) / across) * step);
      const relayGoal = new goals.GoalNearXZ(x, z, 3);
      const movements = movementsFor();
      useMovements(movements);
      const found = await plan(movements, relayGoal, Math.min(searchSlice, timeLeft()));
      if (found.status !== 'success') continue;
      if (budgetOf(countOf(found), found.places)) continue;
      const before = distanceTo(bot, aim);
      relays++; state.redraws++;
      blackBoxOf(host)?.note('relay', { to: [x, z], step, before: Math.round(before) });
      await timed('walkMs', () => goWith(ctx, relayGoal, timeLeft(), notes, { stuckMs: GO_STUCK_MS, busy, onRoute: watchRoute, onGround: true }));
      letGo(bot);
      if (before - distanceTo(bot, aim) >= 2) return true;
    }
    return false;
  };
  let swimBest = Infinity, swimBestAt = Date.now(), faceRestUntil = 0;
  // Headway is the nearest the body has come to a place; a body that is mended and walks back to the same wall has made none.
  let nearest = distanceTo(bot, near());
  const nowhere: GoOutcome = { reached: false, timedOut: false, stuck: false, error: new Error('NoPath'), search: { status: 'noPath', nodes: 0 }, opens: [], crossed: false };
  const countOf = (found: Plan) => [...found.digs.values()].reduce((sum, count) => sum + count, 0);
  try {
    for (;;) {
      const stop = vetoed() ?? limitStop();
      if (stop) return stop;
      const magma = magmaAtFootprint((x, y, z) => nameAt(bot, x, y, z), bot.entity?.position);
      if (magma) return fail('unsafe', `足幅が ${cellText(magma)} の magma_block に掛かるため移動を止めた${holeUnderCentreWords((x, y, z) => nameAt(bot, x, y, z), bot.entity?.position)}`, '安全な床へ離れてから');
      if (reached()) return arrived();
      const gated = await douseAtPlaces();
      if (gated) return gated;
      // A long walk (begun more than twice BURIED_FAR_M off) to a place inside the rock goes to the ground over it (end1108g S9).
      for (let i = 0; i < targets.length; i++) {
        const cell = targets[i]!;
        if (raisedAt.has(i) || Math.hypot(cell.x - start.x, cell.z - start.z) <= 2 * BURIED_FAR_M) continue;
        const buried = buriedSurface(bot, cell);
        // end1109s02 S9: a far place in the air (the height of a mountain top, over a valley) is walked to on the ground under it.
        const ground = buried ?? airborneGround(bot, cell);
        if (ground === null) continue;
        raisedAt.add(i);
        (buried === null ? lowered : raised).push(`${cellText(cell)}→y=${ground}`);
        targets[i] = { ...cell, y: ground };
      }
      const aim = near();
      const center = { x: aim.x + 0.5, y: aim.y + 0.2, z: aim.z + 0.5 };
      const safe = (x: number, y: number, z: number) => !hazardAtFeet(bot, x, y, z);
      const close = waterAllowed() ? swimControls(bot, center, safe) : null;
      // end1109s09 S9: a far place over open sea is swum to straight along the face, not drawn 20 m at a time (0.85 m/s).
      const open = !close && waterAllowed() && Date.now() >= faceRestUntil ? surfaceSwimControls(bot, center, safe) : null;
      const swimming = close ?? open;
      if (swimming) {
        const left = distanceTo(bot, aim);
        if (left < swimBest - 0.2) { swimBest = left; swimBestAt = Date.now(); }
        if (Date.now() - swimBestAt > GO_STUCK_MS && !close) {
          // A face swim that makes no headway (a current, a mob in the way) hands the next stretch to the route search.
          faceRestUntil = Date.now() + FACE_REST_MS; swimBest = Infinity; swimBestAt = Date.now();
          continue;
        }
        if (Date.now() - swimBestAt > GO_STUCK_MS) return fail('stuck', '水中の行き先へ泳いでも距離が縮まらない', '水流・通り道・呼吸を調べて別の手を');
        await swimPulse(ctx, swimming, Math.min(100, timeLeft()));
        continue;
      }
      swimBest = Infinity; swimBestAt = Date.now();
      const finalGoal = compositeOf(targets, limits.range);
      // A place far off is walked to a leg at a time; a place not loaded is walked as close to as the ground goes.
      const isUnloaded = () => { try { return !bot.blockAt(new Vec3(aim.x, aim.y, aim.z), false); } catch { return true; } };
      const unloaded = isUnloaded();
      const leg = nextLeg(bot, goalOf(aim, limits.range) as never, attempt, FAR_LEG_M);
      const legGoal = unloaded ? new goals.GoalNearXZ(aim.x, aim.z, 3) : leg.final ? finalGoal : leg.goal;
      const movements = movementsFor();
      useMovements(movements);
      state.veto = null;
      lastWork = Date.now();
      const from = bot.entity.position.clone();
      // The way is drawn before the body moves: a way that is not found is not walked half (the executor walks the closest it found), and a way
      // that breaks or fills more than the limits is not begun.
      const drawn = await plan(movements, legGoal, Math.min(searchCap, timeLeft()));
      // Run 47 (hold 6): the same search from the same place that ran out of its time once runs out again: it is not drawn a second time.
      if (drawn.status === 'timeout') {
        const here = feetCell(bot);
        const again = `${keyOf(aim)}|${leg.final ? 'f' : 'l'}|${here ? keyOf(here) : ''}`;
        if (timedOutAt.has(again)) {
          letGo(bot);
          if (await relay(aim)) { const again2 = vetoed(); if (again2) return again2; noway = 0; continue; }
          return searchedOutStop(drawn, aim);
        }
        timedOutAt.add(again);
      }
      let out: GoOutcome = nowhere;
      if (drawn.status === 'success') {
        const over = budgetOf(countOf(drawn), drawn.places);
        if (over) return fail(over.code, over.text, over.code === 'limit_dig' ? 'maxDig を増やすか、別の道を' : placeMore('maxPlace を増やすか、別の道を'));
        out = await timed('walkMs', () => goWith(ctx, legGoal, timeLeft(), notes, { stuckMs: GO_STUCK_MS, busy, onRoute: watchRoute, onGround: true }));
      }
      const blocked = vetoed();
      if (blocked) { letGo(bot); return blocked; }
      if (out.magma) return fail('unsafe', `足幅が ${cellText(out.magma)} の magma_block に掛かるため移動を止めた${holeUnderCentreWords((x, y, z) => nameAt(bot, x, y, z), bot.entity?.position)}`, '安全な床へ離れてから');
      if (drawAfterRefusal) {
        drawAfterRefusal = false;
        // Drawn again from the ground, at rest (a place refused at the top of a jump leaves the body in the air: a route drawn there starts from air).
        letGo(bot);
        state.redraws++;
        continue;
      }
      if (out.crossed) return arrived();
      if (reached()) return arrived();
      if (out.timedOut) { letGo(bot); return limitTime(distanceTo(bot, aim).toFixed(0)); }
      letGo(bot);
      const moved = bot.entity.position.distanceTo(from);
      if (unloaded && !isUnloaded()) { state.redraws++; continue; }
      if (unloaded && moved < 1.5) {
        // As far as the ground that is loaded goes: to the end of the way the search found toward it; there is no more, it is not loaded.
        const end = drawn.path.length ? drawn.path[drawn.path.length - 1] : null;
        if (end && Math.hypot(end.x - bot.entity.position.x, end.z - bot.entity.position.z) > 1.5) {
          state.redraws++;
          const cell = nodeCell(end);
          await timed('walkMs', () => goWith(ctx, new goals.GoalBlock(cell.x, cell.y, cell.z), timeLeft(), notes, { stuckMs: GO_STUCK_MS, busy, onRoute: watchRoute, onGround: true }));
          letGo(bot);
          continue;
        }
        return fail('not_loaded', `行き先 ${cellText(aim)} は読み込まれていない地図の外で、進める所まで進んだ（あと ${distanceTo(bot, aim).toFixed(0)}m）`, '近くの読み込まれた所まで行ってから');
      }
      const left = distanceTo(bot, near());
      if (left < nearest - 1.5) { nearest = left; mends = 0; noway = 0; attempt = 0; }
      if (moved >= 1.5 && !out.stuck) { mends = 0; noway = 0; attempt = 0; state.redraws++; continue; }
      // Run 5 (308 s held in shallow flowing water; the route search reads water as still and found the same way each time): held in a stream, the stream is stopped
      // with a cheap block laid upstream (the owner's request), then the way is drawn again from the dry cells. Three tries a go.
      // Only when the current is what held it: flagged stuck, or a route drawn and the body did not move off its cell (not a "no way" that has other causes).
      if (streamDams < 2 && flowingWaterAt(bot, feetCell(bot)) && (out.stuck || (drawn.path.length > 0 && moved < 0.5))) {
        streamDams++;
        const dam = await timed('mendMs', () => stanchStream(ctx, { toward: aim, deadline }));
        streamWhy = dam.stopped || !dam.words ? '' : dam.words;
        if (dam.words && (dam.stopped || dam.attempted)) streamWords = dam.words;
        // A block laid on the way closes it: the next drawings go round before they dig it out again.
        if (dam.onRoute && dam.at) state.avoid.add(keyOf(dam.at));
        if (dam.attempted) { state.redraws++; noway = 0; if (dam.stopped) { mends = 0; attempt = 0; } continue; }
      }
      // A search that ran out of its time (run 41: 8 of 13 "no way" stops) says nothing about the way: turning the leg, drawing again at once
      // and the explaining searches would each run out the same (5 + 5 + 4 x 2.5 s). What it found is walked when it comes nearer; else it is said.
      const searchedOut = drawn.status === 'timeout';
      if (!leg.final && !out.stuck && attempt < 4 && !searchedOut) { attempt++; state.redraws++; continue; }
      if (out.stuck) {
        // Run 45 (hold 2): the cell of the route the body was held before is avoided by the next drawings.
        const ahead = aheadOf(lastRoute, bot.entity?.position);
        // Run 47 (hold 1): never the place the go is going to itself (a route of one step was held before it, the avoid made it dearer, and the search ran 5 s): the way in is what is avoided.
        if (ahead && !state.avoid.has(keyOf(ahead)) && !targets.some(cell => keyOf(cell) === keyOf(ahead))) {
          state.avoid.add(keyOf(ahead));
          blackBoxOf(host)?.note('avoid', { at: [ahead.x, ahead.y, ahead.z], why: 'stuck' });
        }
        // Run 47 (hold 7): held in flowing water (swimming upstream, against a wall and under a ceiling) is not mended by drawing again: after two tries it is said, with the way out.
        const wet = flowingWaterAt(bot, feetCell(bot));
        if (wet && mends >= 2) {
          return fail('stuck', `流れる水の中（${cellText(feetCell(bot)!)} は ${wet}）で ${GO_STUCK_MS / 1000}秒ずつ進めない（上流へ泳いでも押し戻される）`, streamWhy || '上流の水源を汲む（use の bucket）かブロックで塞ぐか、別の道を');
        }
        mends++;
        if (mends > GO_REPAIRS) {
          const feet = feetCell(bot)!;
          return fail('stuck', `${GO_STUCK_MS / 1000}秒位置が変わらず、直しを ${GO_REPAIRS} 回しても進まない（今 ${cellText(feet)}）`, 'view で周りを見て別の手を');
        }
        state.redraws++;
        await timed('mendMs', () => mend(mends, aim));
        continue;
      }
      // The way is not found. The first time may be the ground still arriving: a new drawing. Then a climb, then the reason.
      noway++;
      if (noway === 1 && !searchedOut) { state.redraws++; await wait(ctx, 300); continue; }
      // Run 46: the guard held back digs on the way (the cells are closed to the routes while that hostile stays), and now there is none: that is the reason.
      if (state.exposed.size > 0) return fail('threat_exposed', exposedWords(), VETO_HINTS.threat_exposed!);
      const found = leg.final || searchedOut ? drawn : await plan(movements, finalGoal, Math.min(searchCap, timeLeft()));
      const end = found.path.length ? found.path[found.path.length - 1] : null;
      const lowest = Math.min(...targets.map(cell => cell.y));
      // Run 44 (hold 1): the search's cell, not the point the pathfinder put on the top of the floor (64.94 on farmland is the cell 65, not 64).
      const endCell = end ? nodeCell(end) : null;
      const closestY = endCell ? endCell.y : (feetCell(bot)?.y ?? lowest);
      // end1109s01b S9: a place 200 m off over a sea had been raised to the hill over it (y 70); the way stopped in the water (y 60) and the
      // climb began there, 190 m short, and stopped at once (low_floor: water under the feet), three gos in six minutes. A climb is for the
      // foot of the place: it starts only where the way ends within CLIMB_NEAR_M (flat) of a place.
      const climbFrom = endCell ?? feetCell(bot);
      const underPlace = !climbFrom || targets.some(cell => Math.hypot(cell.x - climbFrom.x, cell.z - climbFrom.z) <= CLIMB_NEAR_M + limits.range);
      if (lowest > closestY && underPlace) {
        // The place is higher than the nearest the way goes: a climb. The route search's own towers are off; a block is laid at the top of each jump.
        if (!place.held.length) {
          return args.canPlace?.length
            ? fail('no_blocks', `行き先は ${lowest - closestY} 段上で、登るのに置く物が無い（${place.missing.length ? `持っていない ${place.missing.join('・')}` : '置ける物が無い'}${place.refused.length ? `、置かない ${place.refused.join('・')}` : ''}）`, noBlocksHint())
            : fail('dead_end', `行き先は ${lowest - closestY} 段上で、道は途中までしか無い。登るには canPlace が要る`, noBlocksHint('canPlace に置ける物を足す'));
        }
        // To the foot of the climb along the level: an end the way found high up (a search cut by its time ends where it got to) is not walked to,
        // the executor has no towers (run 41 replay: 12 redraws at a goal 17 up, stuck in 10 s); the climb starts here.
        const here = feetCell(bot);
        if (end && endCell && Math.hypot(end.x - bot.entity.position.x, end.z - bot.entity.position.z) > 1.2 && (!here || endCell.y <= here.y + 1)) {
          state.redraws++;
          await timed('walkMs', () => goWith(ctx, new goals.GoalBlock(endCell.x, endCell.y, endCell.z), timeLeft(), notes, { stuckMs: GO_STUCK_MS, busy, onRoute: watchRoute, onGround: true }));
          letGo(bot);
          const again = vetoed();
          if (again) return again;
        }
        const climbed = await timed('climbMs', () => climb(lowest));
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
          return fail(over.code, `道探しは ${(searchSlice / 1000).toFixed(searchSlice < 1000 ? 2 : searchSlice % 1000 ? 1 : 0)} 秒で終わらず、見つかった途中までの道（${cellText(nodeCell(tip!))} まで）でも${over.text.replace(/^この道は/u, '')}`,
            over.code === 'limit_dig' ? 'maxDig を増やして出し直す（下りは 1 段に 2 前後掘る）' : placeMore('maxPlace を増やして出し直す'));
        }
        if (tip && partialWalks < GO_PARTIAL_WALKS) {
          const cell = nodeCell(tip);
          const gain = distanceTo(bot, aim) - Math.hypot(cell.x - aim.x, cell.y - aim.y, cell.z - aim.z);
          if (gain >= 2) {
            partialWalks++; state.redraws++;
            await timed('walkMs', () => goWith(ctx, new goals.GoalBlock(cell.x, cell.y, cell.z), timeLeft(), notes, { stuckMs: GO_STUCK_MS, busy, onRoute: watchRoute, onGround: true }));
            letGo(bot);
            const again = vetoed();
            if (again) return again;
            noway = 0;
            continue;
          }
        }
        if (await relay(aim)) { const again2 = vetoed(); if (again2) return again2; noway = 0; continue; }
        return searchedOutStop(found, aim);
      }
      const reason = await explain(finalGoal);
      if (reason) return reason;
      state.redraws++;
    }
  } catch (error) {
    // The act's stop, the action's abort, a reflex: the body lets go of everything and the stop goes on.
    if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) letGo(bot);
    // Continue contracts (1): a go that was cut tells how far it had got (the act reads `error.progress`).
    if (error && typeof error === 'object' && !(error as { progress?: unknown }).progress) { try { (error as { progress?: Progress }).progress = progressNow(); } catch { /* the cut stands without it */ } }
    throw error;
  } finally {
    try {
      timing.totalMs = Date.now() - startedAt;
      const p = bot.entity?.position;
      timing.metres = p && startPosition ? round1(Math.hypot(p.x - startPosition.x, p.y - startPosition.y, p.z - startPosition.z)) : 0;
      timing.relays = relays; timing.walls = walls;
      goTimings.set(host, { ...timing });
      blackBoxOf(host)?.note('go_time', { ...timing, wallsSkipped, wallsRefused });
    } catch { /* a measure is never the stop */ }
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
