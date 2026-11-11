/**
 * planRoute: the shortest route to a cell as a body can make it with four things only: walking, a level cut (horizontal), a stair cut (down or up),
 * a shaft cut (straight down) and blocks laid (a bridge, a step, a pillar). Run 7 (Lai, "目的座標を指定したときにそこに至る最短経路を出力するアルゴリズムを作るのがいい
 * かも。ただし、階段掘りと水平掘り・垂直掘り・ブロック設置のみを組み合わせた経路で、水源・マグマは回避し、出来る限り道があれば掘らずに移動する"). Pure: it reads cells
 * through a BlockReader and returns data, so a test gives it fixed blocks and a body runs the answer (utils/routeFollow).
 *
 * Why not the route search of the walk (mineflayer-pathfinder): its nodes are (x, y, z) only, so the number of blocks dug on the way is not in the search and
 * a limit on it can only refuse the finished way (run 7: "limit_dig" three times at the same coal, the way needed 33 and the limit was 30); it does not know the
 * shapes (a stair digs three blocks a level, a shaft one); and it is slow (1.5 s cut it off at 2,000-4,000 cells). Here the cells are read once into a grid by
 * block state, the search is A* on whole cells with a binary heap, and the dug and laid blocks are counted in the answer and kept in line by weights outside the search.
 *
 * Steps are the shapes of utils/stairLine and utils/tunnelWalk (stepNeeds): the same cells are dug and the same floor stood on, so the tunnel walk runs a plan as it is.
 * The rules for a cell are the walk's own (utils/walkRules): what is open, what is a floor, what is lava. Water and lava are not entered (water only when asked);
 * a block with lava over or beside it, or any liquid over it, is not dug; a block with water at its side is dug only at a price, with one block to seal it.
 */
import type { BlockReader, Cell, MapBlock } from './localMap.js';
import { PROTECTED_UTILITY_BLOCKS } from '../constants.js';
import { cellWay, floorOf, isClimbable, isLava, isWater, MAX_CLIMB, topOf, type CellWay } from './walkRules.js';

// ===== What a block is to the route =====

export type RouteKind = 'open' | 'water' | 'lava' | 'rock' | 'wall' | 'harm' | 'unloaded';
interface Info { kind: RouteKind; name: string; floor: boolean; top: number; ladder: boolean; seconds: number; falling: boolean; ore: boolean; way: CellWay | 'none' }

/** Blocks the body does not break whatever it is told (nothing that is a person's or a village's, nothing that cannot be broken). */
const NEVER_BREAK = /(?:^bedrock$|^obsidian$|^crying_obsidian$|^spawner$|^trial_spawner$|^vault$|_door$|_fence_gate$|_trapdoor$|_bed$|^end_portal|^nether_portal$|^barrier$|^command_block|^structure_block$|^reinforced_deepslate$|^farmland$|^budding_amethyst$|^(?:chest|trapped_chest|ender_chest|barrel|crafting_table|furnace|blast_furnace|smoker|beacon|enchanting_table|anvil|respawn_anchor|lectern|brewing_stand|jukebox|note_block)$|^(?:wheat|carrots|potatoes|beetroots|nether_wart|cocoa|melon_stem|pumpkin_stem|attached_melon_stem|attached_pumpkin_stem|sweet_berry_bush)$)/u;
/** Blocks a village's people made: left alone near a villager (the caller says what is near). */
const VILLAGE_MADE = /(?:_planks|_fence|_slab|_stairs|glass|glass_pane|bookshelf|hay_block|_wall|bricks|_wool|_carpet|lantern)$/u;
/** Blocks that fall when what holds them is gone. */
const FALLING = /^(?:sand|red_sand|gravel|suspicious_sand|suspicious_gravel|anvil|chipped_anvil|damaged_anvil|dragon_egg|.*_concrete_powder)$/u;
const ORE = /(?:_ore$|^ancient_debris$)/u;

/** Seconds one block takes with a pick of iron (the body's real figure is its own tool's; a caller gives `digSeconds` for it). A fair table by the block's kind. */
export function defaultDigSeconds(name: string): number {
  if (/^(?:dirt|grass_block|coarse_dirt|podzol|mycelium|rooted_dirt|mud|clay|sand|red_sand|gravel|soul_sand|soul_soil|snow|snow_block|moss_block|dirt_path)$/u.test(name)) return 0.3;
  if (/^(?:netherrack|basalt|smooth_basalt)$/u.test(name)) return 0.25;
  if (/_log$|_wood$|_stem$|_hyphae$|_planks$|_fence$/u.test(name)) return 0.9;
  if (/^deepslate_.*_ore$/u.test(name)) return 1.6;
  if (/_ore$|^ancient_debris$/u.test(name)) return 1.0;
  if (/deepslate/u.test(name)) return 1.2;
  return 0.75;
}

/** What `digSeconds` of a block may cost in the plan at most: a block that takes longer by hand is priced as this (the hand's labour cap). */
export const DIG_SECONDS_CAP = 30;

export interface RoutePolicy {
  /** Narrows what may be dug to these names (a hand's canDig read as a ceiling); the walls below are never dug whatever it says. */
  diggable?: (name: string) => boolean;
  /** Seconds one block takes with what the body holds. */
  digSeconds?: (name: string) => number;
  /** Whether a cell lies in a village (its made blocks are left alone there). */
  villageNear?: (x: number, y: number, z: number) => boolean;
}

/** Whether the body may break a block of this name at all (the route's policy; true for rock, earth, gravel, sand, ore and wood). */
export function mayBreak(name: string, policy: RoutePolicy = {}, at?: Cell): boolean {
  if (NEVER_BREAK.test(name) || PROTECTED_UTILITY_BLOCKS.has(name) || name === 'water' || name === 'lava') return false;
  if (VILLAGE_MADE.test(name) && at && policy.villageNear?.(at.x, at.y, at.z)) return false;
  return policy.diggable ? policy.diggable(name) : true;
}

const UNLOADED: Info = { kind: 'unloaded', name: '未読み込み', floor: false, top: 0, ladder: false, seconds: Infinity, falling: false, ore: false, way: 'none' };

function classify(block: MapBlock | null, policy: RoutePolicy, at: Cell): Info {
  if (!block) return UNLOADED;
  const name = block.name.replace(/^minecraft:/u, '');
  const base = { name, floor: floorOf(block), top: topOf(block), ladder: isClimbable(block), falling: FALLING.test(name), ore: ORE.test(name), seconds: 0 };
  if (isLava(block) || name === 'flowing_lava') return { ...base, kind: 'lava', floor: false, way: 'harm' };
  if (isWater(block)) return { ...base, kind: 'water', floor: false, way: 'open' };
  const way = cellWay(block);
  if (way === 'harm') return { ...base, kind: 'harm', way };
  if (way === 'portal' || way === 'iron_door') return { ...base, kind: 'wall', way };
  if (way === 'unloaded') return UNLOADED;
  if (way === 'open' || way === 'door' || way === 'leaves') return { ...base, kind: 'open', way };
  if (!mayBreak(name, policy, at)) return { ...base, kind: 'wall', way };
  const seconds = Math.min(DIG_SECONDS_CAP, (policy.digSeconds ?? defaultDigSeconds)(name));
  return { ...base, kind: 'rock', seconds, way };
}

// ===== The grid =====

interface Box { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }

class Grid {
  readonly w: number; readonly h: number; readonly d: number;
  readonly cells: Uint16Array;
  private readonly palette: Info[] = [];
  private readonly byKey = new Map<string, number>();
  reads = 0;
  constructor(readonly box: Box, private readonly read: BlockReader, private readonly policy: RoutePolicy) {
    this.w = box.x1 - box.x0 + 1; this.h = box.y1 - box.y0 + 1; this.d = box.z1 - box.z0 + 1;
    this.cells = new Uint16Array(this.w * this.h * this.d);
  }
  inside(x: number, y: number, z: number): boolean { return x >= this.box.x0 && x <= this.box.x1 && y >= this.box.y0 && y <= this.box.y1 && z >= this.box.z0 && z <= this.box.z1; }
  index(x: number, y: number, z: number): number { return ((y - this.box.y0) * this.d + (z - this.box.z0)) * this.w + (x - this.box.x0); }
  cellOf(index: number): Cell {
    const x = index % this.w, rest = Math.floor(index / this.w), z = rest % this.d, y = Math.floor(rest / this.d);
    return { x: x + this.box.x0, y: y + this.box.y0, z: z + this.box.z0 };
  }
  info(x: number, y: number, z: number): Info {
    if (!this.inside(x, y, z)) return UNLOADED;
    const index = this.index(x, y, z);
    let slot = this.cells[index];
    if (slot === 0) {
      this.reads++;
      const block = this.read(x, y, z);
      const key = block ? `${block.name}|${block.solid ? 1 : 0}|${block.open ? 1 : 0}|${block.top ?? ''}|${block.level ?? ''}|${block.symbol ?? ''}|${block.plates ?? ''}` : '';
      // A fluid's level, a door's state and a top change what the block is; names that hold none of them share one info (rock does not depend on its place, but a village's made blocks do).
      let found = VILLAGE_MADE.test(block?.name ?? '') ? undefined : this.byKey.get(key);
      if (found === undefined) {
        const made = classify(block, this.policy, { x, y, z });
        this.palette.push(made);
        found = this.palette.length;
        if (!VILLAGE_MADE.test(block?.name ?? '')) this.byKey.set(key, found);
      }
      slot = this.cells[index] = found;
    }
    return this.palette[slot - 1];
  }
}

// ===== Moves =====

export type StepKind = 'walk' | 'diagonal' | 'up' | 'drop' | 'ladder' | 'dig_level' | 'dig_down' | 'dig_up' | 'shaft' | 'pillar' | 'scaffold' | 'bridge';
const KINDS: StepKind[] = ['walk', 'diagonal', 'up', 'drop', 'ladder', 'dig_level', 'dig_down', 'dig_up', 'shaft', 'pillar', 'scaffold', 'bridge'];
const CODE = Object.fromEntries(KINDS.map((kind, i) => [kind, i + 1])) as Record<StepKind, number>;

/** Seconds of a move apart from its blocks (a tunnel walk's pace: the dig's own time is added by the blocks). All provisional until measured in the lab. */
const WALK_S = 0.25, DIAG_S = 0.35, UP_S = 0.45, DROP_S = 0.25, DROP_PER_LEVEL_S = 0.1, LADDER_S = 0.15, SWIM_S = 0.6;
const DIG_LEVEL_S = 0.3, DIG_DOWN_S = 0.35, DIG_UP_S = 0.5, SHAFT_S = 0.3, PILLAR_S = 0.6, SCAFFOLD_S = 0.55, BRIDGE_S = 0.25;
/** Added to a dug block's own seconds (start and confirmation), and to a laid block's seconds. */
const DIG_EXTRA_S = 0.15, PLACE_S = 0.45;
/** Weights outside the clock: a block dug costs this much more, a block laid this much more (the tiers raise them). */
const DIG_WEIGHT_S = 0.6, PLACE_WEIGHT_S = 0.4;
/** Standing or passing beside lava; digging a block with water at its side; a falling block over a dug cell. */
const LAVA_BESIDE_S = 8, WET_DIG_S = 20, FALLING_ABOVE_S = 4;

export interface RouteStep {
  kind: StepKind;
  /** The cell the feet end in. */
  to: Cell;
  /** The blocks cut for it (rock only; a cell already open is not here). */
  dig: Cell[];
  /** The blocks laid for it. */
  place: Cell[];
  /** The dug blocks that have water at their side (each is sealed once). */
  wet: Cell[];
  seconds: number;
}

/** `laid`: the move ends standing on a block it laid (the cell has no floor of its own: the search keeps that with the cell, so a bridge goes on from its last block). */
interface Candidate { x: number; y: number; z: number; kind: StepKind; cost: number; dig: Cell[]; place: Cell[]; wet: Cell[]; laid?: boolean }
const NONE: Cell[] = [];
const DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAGS: ReadonlyArray<readonly [number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

export interface RouteOptions extends RoutePolicy {
  /** How near the feet must come to a goal (default 0: the cell itself). */
  range?: number;
  maxDrop?: number;
  /** Water may be swum (a shallow stretch). Default no: water is a wall. */
  waterOk?: boolean;
  /** The blocks the head allows to be dug at most (its maxDig). Absent: DEFAULT_CEILING. */
  maxDig?: number;
  /** How many blocks the pack can lay (cheap whole blocks). Default 0: nothing is laid. */
  placeBlocks?: number;
  /** The whole planning's time in ms (default 250). */
  ms?: number;
  /** The most cells of the box (default 400,000). */
  maxCells?: number;
  /** Margins round the cells asked about: sideways, up, down. */
  margin?: { side: number; up: number; down: number };
  /** The search's own cap on cells taken from the open list (default 200,000). */
  maxNodes?: number;
}

/** The ceiling for blocks dug when the hand gives none: a way that digs more is told before it is walked (a few minutes of work). */
export const DEFAULT_CEILING = 80;
/** The time planning is given in all (ms): about the cost of a path request the body makes in a tick. */
export const DEFAULT_MS = 300;
/** How much the distance estimate is inflated: while walking only, and while cutting or laying; and the least a level costs cutting down by a shaft, up by a pillar, either by a stair. */
const WALK_INFLATE = 1.2, DIG_INFLATE = 5, VERTICAL_SHAFT_S = 1.8, VERTICAL_PILLAR_S = 2.4, VERTICAL_STAIR_S = 5.2;
const MIN_SIDE_MARGIN = 6;
const DEFAULT_MARGIN = { side: 24, up: 16, down: 24 };

// ===== The search =====

interface Search {
  status: 'success' | 'none' | 'timeout';
  /** Cell indices from the start to the goal (or to the cell nearest the goal when it is not reached). */
  path: number[];
  goal: number | null;
  closest: number;
  closestDistance: number;
  nodes: number;
  limited: boolean;
  /** The move that entered each cell (an index into KINDS, plus one). */
  kinds: Uint8Array;
  /** Whether each cell was entered standing on a block laid for it. */
  laid: Uint8Array;
}

interface Weights { dig: number; place: number }
interface Allow { dig: boolean; place: boolean; shaft: boolean }

class Heap {
  private keys = new Float64Array(1024);
  private vals = new Int32Array(1024);
  size = 0;
  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const keys = new Float64Array(this.size * 2), vals = new Int32Array(this.size * 2);
      keys.set(this.keys); vals.set(this.vals); this.keys = keys; this.vals = vals;
    }
    let i = this.size++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.keys[i] = this.keys[parent]; this.vals[i] = this.vals[parent]; i = parent;
    }
    this.keys[i] = key; this.vals[i] = val;
  }
  pop(): number {
    const top = this.vals[0];
    const key = this.keys[--this.size], val = this.vals[this.size];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.keys[child + 1] < this.keys[child]) child++;
      if (this.keys[child] >= key) break;
      this.keys[i] = this.keys[child]; this.vals[i] = this.vals[child]; i = child;
    }
    this.keys[i] = key; this.vals[i] = val;
    return top;
  }
}

interface Goals { cells: Cell[]; range: number; /** The goal is the nearest column of a clamped box: any height. */ horizontalOnly: boolean }

class RouteSearch {
  constructor(private readonly grid: Grid, private readonly opts: Required<Pick<RouteOptions, 'maxDrop' | 'waterOk'>> & { placeBlocks: number }) {}

  // --- reading cells ---
  private open(x: number, y: number, z: number): boolean {
    const info = this.grid.info(x, y, z);
    return info.kind === 'open' || (this.opts.waterOk && info.kind === 'water');
  }
  private standable(x: number, y: number, z: number): boolean {
    const feet = this.grid.info(x, y, z);
    if (!(feet.kind === 'open' || (this.opts.waterOk && feet.kind === 'water')) || !this.open(x, y + 1, z)) return false;
    return feet.kind === 'water' || feet.ladder || this.grid.info(x, y - 1, z).floor;
  }
  private lavaBeside(x: number, y: number, z: number): boolean {
    for (const [dx, dz] of DIRS) {
      if (this.grid.info(x + dx, y, z + dz).kind === 'lava' || this.grid.info(x + dx, y + 1, z + dz).kind === 'lava') return true;
    }
    return false;
  }
  private waterBeside(x: number, y: number, z: number): boolean {
    for (const [dx, dz] of DIRS) if (this.grid.info(x + dx, y, z + dz).kind === 'water') return true;
    return false;
  }
  private pace(base: number, x: number, y: number, z: number): number {
    let cost = base;
    if (this.grid.info(x, y, z).kind === 'water') cost += SWIM_S - WALK_S;
    if (this.lavaBeside(x, y, z)) cost += LAVA_BESIDE_S;
    return cost;
  }

  /** What digging the cells costs, and why not: null when one of them may not be cut (lava or any liquid over it, lava beside it, a wall, a hole where a block is wanted). */
  private cut(cells: Array<[number, number, number]>, weights: Weights, own: Array<[number, number, number]>): { dig: Cell[]; wet: Cell[]; cost: number } | null {
    const dig: Cell[] = [], wet: Cell[] = [];
    let cost = 0;
    for (const [x, y, z] of cells) {
      const info = this.grid.info(x, y, z);
      if (info.kind === 'open') continue;
      if (info.kind !== 'rock') return null;
      const above = this.grid.info(x, y + 1, z);
      if (above.kind === 'water' || above.kind === 'lava') return null;
      let wetHere = false;
      for (const [dx, dz] of DIRS) {
        const side = this.grid.info(x + dx, y, z + dz);
        if (side.kind === 'lava') return null;
        if (side.kind === 'water' && !own.some(cell => cell[0] === x + dx && cell[1] === y && cell[2] === z + dz)) wetHere = true;
      }
      dig.push({ x, y, z });
      cost += info.seconds + DIG_EXTRA_S + weights.dig;
      if (above.falling) cost += FALLING_ABOVE_S;
      if (wetHere) { wet.push({ x, y, z }); cost += WET_DIG_S + PLACE_S + weights.place; }
    }
    return { dig, wet, cost };
  }

  /** The moves from the cell (x, y, z). */
  moves(x: number, y: number, z: number, laidHere: boolean, allow: Allow, weights: Weights, out: Candidate[]): void {
    out.length = 0;
    const g = this.grid;
    const placeCost = PLACE_S + weights.place;
    const ladderHere = g.info(x, y, z).ladder;
    const headRoom = this.open(x, y + 2, z);
    const floorHere = laidHere || g.info(x, y - 1, z).floor;
    for (const [dx, dz] of DIRS) {
      const nx = x + dx, nz = z + dz;
      // Walking: level, one up, a fall.
      if (this.standable(nx, y, nz)) out.push({ x: nx, y, z: nz, kind: 'walk', cost: this.pace(WALK_S, nx, y, nz), dig: NONE, place: NONE, wet: NONE });
      else if (this.open(nx, y, nz) && this.open(nx, y + 1, nz)) {
        // A fall: every cell down the column open to the landing.
        let landed = -1;
        for (let k = 1; k <= this.opts.maxDrop; k++) {
          if (!this.open(nx, y - k, nz)) break;
          if (this.standable(nx, y - k, nz)) { landed = k; break; }
        }
        if (landed > 0) out.push({ x: nx, y: y - landed, z: nz, kind: 'drop', cost: this.pace(DROP_S + DROP_PER_LEVEL_S * landed, nx, y - landed, nz), dig: NONE, place: NONE, wet: NONE });
      }
      if (headRoom && this.standable(nx, y + 1, nz)) {
        const step = g.info(nx, y, nz);
        const floor = g.info(x, y - 1, z);
        const feet = g.info(x, y, z);
        const base = feet.kind === 'water' || feet.ladder || !floorHere ? y : y - 1 + (floor.floor ? floor.top : 1);
        if (step.floor && y + step.top - base <= MAX_CLIMB) out.push({ x: nx, y: y + 1, z: nz, kind: 'up', cost: this.pace(UP_S, nx, y + 1, nz), dig: NONE, place: NONE, wet: NONE });
      }
      if (!allow.dig && !allow.place) continue;
      const standsHere = g.info(x, y, z).kind !== 'water';
      // Cut (and lay) moves, the shapes of utils/tunnelWalk.stepNeeds.
      if (allow.dig) {
        const level: Array<[number, number, number]> = [[nx, y, nz], [nx, y + 1, nz]];
        const cutLevel = this.cut(level, weights, level);
        if (cutLevel && cutLevel.dig.length > 0) {
          const floor = g.info(nx, y - 1, nz);
          const placing: Cell[] = floor.kind === 'open' && allow.place && standsHere ? [{ x: nx, y: y - 1, z: nz }] : NONE;
          if (floor.floor || placing.length) {
            out.push({ x: nx, y, z: nz, kind: 'dig_level', cost: DIG_LEVEL_S + cutLevel.cost + placing.length * placeCost + (this.lavaBeside(nx, y, nz) ? LAVA_BESIDE_S : 0), dig: cutLevel.dig, place: [...placing, ...cutLevel.wet], wet: cutLevel.wet, laid: placing.length > 0 });
          }
        }
        // A stair down: the head's and the feet's height of the level left, and the cell stepped down to.
        const down: Array<[number, number, number]> = [[nx, y + 1, nz], [nx, y, nz], [nx, y - 1, nz]];
        const cutDown = this.cut(down, weights, down);
        if (cutDown && cutDown.dig.length > 0 && g.info(nx, y - 2, nz).floor) {
          out.push({ x: nx, y: y - 1, z: nz, kind: 'dig_down', cost: DIG_DOWN_S + cutDown.cost + (this.lavaBeside(nx, y - 1, nz) ? LAVA_BESIDE_S : 0), dig: cutDown.dig, place: cutDown.wet, wet: cutDown.wet });
        }
        // A stair up: the cell over the head and the two of the step up; the step's block stays as the floor.
        if (g.info(nx, y, nz).floor) {
          const up: Array<[number, number, number]> = [[x, y + 2, z], [nx, y + 1, nz], [nx, y + 2, nz]];
          const cutUp = this.cut(up, weights, up);
          if (cutUp && cutUp.dig.length > 0) {
            out.push({ x: nx, y: y + 1, z: nz, kind: 'dig_up', cost: DIG_UP_S + cutUp.cost + (this.lavaBeside(nx, y + 1, nz) ? LAVA_BESIDE_S : 0), dig: cutUp.dig, place: cutUp.wet, wet: cutUp.wet });
          }
        }
      }
      if (allow.place && standsHere) {
        // A bridge: the cell ahead open, its floor air.
        if (this.open(nx, y, nz) && this.open(nx, y + 1, nz) && g.info(nx, y - 1, nz).kind === 'open' && floorHere) {
          out.push({ x: nx, y, z: nz, kind: 'bridge', cost: this.pace(BRIDGE_S, nx, y, nz) + placeCost, dig: NONE, place: [{ x: nx, y: y - 1, z: nz }], wet: NONE, laid: true });
        }
        // A step up onto a block laid ahead.
        if (headRoom && g.info(nx, y, nz).kind === 'open' && this.open(nx, y + 1, nz) && this.open(nx, y + 2, nz) && floorHere) {
          out.push({ x: nx, y: y + 1, z: nz, kind: 'scaffold', cost: this.pace(SCAFFOLD_S, nx, y + 1, nz) + placeCost, dig: NONE, place: [{ x: nx, y, z: nz }], wet: NONE, laid: true });
        }
      }
    }
    // Diagonals (both corners open at the feet and the head).
    for (const [dx, dz] of DIAGS) {
      const nx = x + dx, nz = z + dz;
      if (!this.standable(nx, y, nz)) continue;
      if (!this.open(x + dx, y, z) || !this.open(x + dx, y + 1, z) || !this.open(x, y, z + dz) || !this.open(x, y + 1, z + dz)) continue;
      out.push({ x: nx, y, z: nz, kind: 'diagonal', cost: this.pace(DIAG_S, nx, y, nz), dig: NONE, place: NONE, wet: NONE });
    }
    // A ladder or a vine: up and down its column.
    if (ladderHere) {
      if (this.open(x, y + 1, z) && (g.info(x, y + 1, z).ladder || this.standable(x, y + 1, z)) && this.open(x, y + 2, z)) out.push({ x, y: y + 1, z, kind: 'ladder', cost: LADDER_S, dig: NONE, place: NONE, wet: NONE });
    }
    if (g.info(x, y - 1, z).ladder && this.open(x, y - 1, z)) out.push({ x, y: y - 1, z, kind: 'ladder', cost: LADDER_S, dig: NONE, place: NONE, wet: NONE });
    if (!allow.dig && !allow.place) return;
    const standsHere = g.info(x, y, z).kind !== 'water';
    // A shaft down: the floor under the feet is cut and the body drops onto the one under it.
    if (allow.dig && allow.shaft) {
      const shaft: Array<[number, number, number]> = [[x, y - 1, z]];
      const cutShaft = g.info(x, y - 1, z).kind === 'rock' ? this.cut(shaft, weights, shaft) : null;
      if (cutShaft && cutShaft.dig.length > 0 && g.info(x, y - 2, z).floor) {
        out.push({ x, y: y - 1, z, kind: 'shaft', cost: SHAFT_S + cutShaft.cost + (this.lavaBeside(x, y - 1, z) ? LAVA_BESIDE_S : 0), dig: cutShaft.dig, place: cutShaft.wet, wet: cutShaft.wet });
      }
    }
    // A pillar up: the cell over the head is cut when it is rock, and a block is laid in the cell the feet leave.
    if (allow.place && standsHere && floorHere) {
      const over: Array<[number, number, number]> = [[x, y + 2, z]];
      const cutOver = this.cut(over, weights, over);
      if (cutOver && this.open(x, y + 1, z)) {
        out.push({ x, y: y + 1, z, kind: 'pillar', cost: PILLAR_S + cutOver.cost + placeCost, dig: cutOver.dig, place: [{ x, y, z }, ...cutOver.wet], wet: cutOver.wet, laid: true });
      }
    }
  }

  run(from: Cell, goals: Goals, allow: Allow, weights: Weights, deadline: number, maxNodes: number): Search {
    // The distance to the goal is inflated while cutting is allowed: a cell of rock costs several times a cell of air, and an unweighted estimate would have the search taste every
    // cell of rock within the cost of the way (a shaft of 24 was 250 ms and no answer). A way found is within the inflation of the shortest.
    const cutting = allow.dig || allow.place;
    const inflate = cutting ? DIG_INFLATE : WALK_INFLATE;
    // A level of height costs a block cut (a shaft) at the least while cutting, a ladder rung at the least while walking only.
    const down = cutting ? (allow.shaft ? VERTICAL_SHAFT_S : VERTICAL_STAIR_S) : 0.15 * WALK_INFLATE;
    const up = cutting ? (allow.place ? VERTICAL_PILLAR_S : VERTICAL_STAIR_S) : 0.15 * WALK_INFLATE;
    const g = this.grid;
    const volume = g.cells.length;
    const cost = new Float32Array(volume).fill(Infinity);
    const prev = new Int32Array(volume).fill(-1);
    const via = new Uint8Array(volume);
    const laid = new Uint8Array(volume);
    const done = new Uint8Array(volume);
    const heap = new Heap();
    const start = g.index(from.x, from.y, from.z);
    const hOf = (x: number, y: number, z: number): number => {
      let best = Infinity;
      for (const goal of goals.cells) {
        const dxz = Math.max(Math.abs(goal.x - x), Math.abs(goal.z - z)) - goals.range;
        const dy = goals.horizontalOnly ? 0 : Math.abs(goal.y - y) - goals.range;
        const level = (goals.horizontalOnly ? 0 : goal.y - y);
        const h = Math.max(inflate * 0.25 * Math.max(0, dxz), (level < 0 ? down : up) * Math.max(0, dy));
        if (h < best) best = h;
      }
      return best;
    };
    const reached = (x: number, y: number, z: number): boolean => {
      for (const goal of goals.cells) {
        const dx = goal.x - x, dz = goal.z - z, dy = goals.horizontalOnly ? 0 : goal.y - y;
        if (dx * dx + dy * dy + dz * dz <= goals.range * goals.range + (goals.horizontalOnly ? 2 : 0)) return true;
      }
      return false;
    };
    cost[start] = 0;
    heap.push(hOf(from.x, from.y, from.z), start);
    const out: Candidate[] = [];
    let nodes = 0, closest = start, closestDistance = Infinity, goal: number | null = null;
    const distanceOf = (x: number, y: number, z: number) => {
      let best = Infinity;
      for (const c of goals.cells) best = Math.min(best, Math.hypot(c.x - x, goals.horizontalOnly ? 0 : c.y - y, c.z - z));
      return best;
    };
    let limited = false;
    while (heap.size > 0) {
      const index = heap.pop();
      if (done[index]) continue;
      done[index] = 1;
      const at = g.cellOf(index);
      if (reached(at.x, at.y, at.z)) { goal = index; break; }
      if (++nodes > maxNodes) { limited = true; break; }
      if ((nodes & 255) === 0 && performance.now() > deadline) { limited = true; break; }
      const distance = distanceOf(at.x, at.y, at.z);
      if (distance < closestDistance) { closestDistance = distance; closest = index; }
      this.moves(at.x, at.y, at.z, laid[index] === 1, allow, weights, out);
      for (const move of out) {
        if (!g.inside(move.x, move.y, move.z)) continue;
        const target = g.index(move.x, move.y, move.z);
        if (done[target]) continue;
        const next = cost[index] + move.cost;
        if (next < cost[target]) {
          cost[target] = next; prev[target] = index; via[target] = CODE[move.kind]; laid[target] = move.laid ? 1 : 0;
          const h = hOf(move.x, move.y, move.z);
          heap.push(next + h + h * 1e-3, target);   // a tie goes to the cell nearer the goal (a plateau of equal estimates was every cell of the rock round a stair)
        }
      }
    }
    const trace = (end: number): number[] => {
      const path: number[] = [];
      for (let at = end; at !== -1; at = prev[at]) { path.push(at); if (path.length > volume) break; }
      return path.reverse();
    };
    return goal !== null
      ? { status: 'success', path: trace(goal), goal, closest: goal, closestDistance: 0, nodes, limited: false, kinds: via, laid }
      : { status: limited ? 'timeout' : 'none', path: trace(closest), goal: null, closest, closestDistance, nodes, limited, kinds: via, laid };
  }

  /** The steps of a path (the moves that were taken, with their blocks), from the cells and the kinds the search recorded. */
  steps(path: number[], kinds: Uint8Array, laid: Uint8Array, allow: Allow, weights: Weights): RouteStep[] {
    const g = this.grid;
    const steps: RouteStep[] = [];
    const out: Candidate[] = [];
    for (let i = 1; i < path.length; i++) {
      const from = g.cellOf(path[i - 1]), to = g.cellOf(path[i]);
      const kind = KINDS[kinds[path[i]] - 1];
      this.moves(from.x, from.y, from.z, laid[path[i - 1]] === 1, allow, weights, out);
      const move = out.filter(candidate => candidate.x === to.x && candidate.y === to.y && candidate.z === to.z && candidate.kind === kind).sort((a, b) => a.cost - b.cost)[0];
      if (!move) continue;
      steps.push({ kind, to, dig: move.dig, place: move.place, wet: move.wet, seconds: move.cost });
    }
    return steps;
  }
}

// ===== The answer =====

export interface RouteTotals { steps: number; walk: number; up: number; down: number; dig: number; place: number; seconds: number }
export interface RoutePlan {
  /** success: the way is whole. partial: the way ends at `frontier` (the box ended, or the time did), walk there and plan again. over: a way exists but digs more than the ceiling. none: no way. */
  status: 'success' | 'partial' | 'over' | 'none';
  steps: RouteStep[];
  totals: RouteTotals;
  /** What is dug, by block name ("stone": 18). */
  digsByName: Record<string, number>;
  /** The dug blocks that have water at their side (each takes a block to seal it). */
  wet: Cell[];
  /** Ores and the like dug on the way (picked up), by name. */
  incidental: Record<string, number>;
  frontier?: Cell;
  /** none: one line saying why. */
  why?: string;
  /** over: the blocks the way needs at the least, the ceiling, and a way by shaft (blocks dug, blocks laid to climb back). */
  over?: { needed: number; ceiling: number; shaft: { dig: number; back: number } | null };
  /** The cell nearest the goal that is reached without digging or laying, and how far from the goal it is (m). */
  alt?: { cell: Cell; remaining: number };
  /** Which rule chose it: 'walk' (no dig, no block laid), 'cost' (the shortest in seconds) or 'few' (the fewest dug, weights raised). */
  tier: 'walk' | 'cost' | 'few' | 'none';
  visited: number;
  ms: number;
  limited: boolean;
}

const emptyTotals = (): RouteTotals => ({ steps: 0, walk: 0, up: 0, down: 0, dig: 0, place: 0, seconds: 0 });

function totalsOf(steps: RouteStep[]): RouteTotals {
  const totals = emptyTotals();
  totals.steps = steps.length;
  for (const step of steps) {
    totals.dig += step.dig.length;
    totals.place += step.place.length;
    totals.seconds += step.seconds;
    if (step.kind === 'up' || step.kind === 'dig_up' || step.kind === 'pillar' || step.kind === 'scaffold') totals.up++;
    else if (step.kind === 'dig_down' || step.kind === 'shaft' || step.kind === 'drop') totals.down++;
    else totals.walk++;
  }
  totals.seconds = Math.round(totals.seconds * 10) / 10;
  return totals;
}

/** Everything else a plan carries, from the steps and the grid. */
function planOf(grid: Grid, steps: RouteStep[], status: RoutePlan['status'], tier: RoutePlan['tier'], base: Pick<RoutePlan, 'visited' | 'ms' | 'limited'>): RoutePlan {
  const digsByName: Record<string, number> = {}, incidental: Record<string, number> = {}, wet: Cell[] = [];
  for (const step of steps) {
    for (const cell of step.dig) {
      const info = grid.info(cell.x, cell.y, cell.z);
      digsByName[info.name] = (digsByName[info.name] ?? 0) + 1;
      if (info.ore) incidental[info.name] = (incidental[info.name] ?? 0) + 1;
    }
    wet.push(...step.wet);
  }
  return { status, steps, totals: totalsOf(steps), digsByName, wet, incidental, tier, ...base };
}

const near = (a: Cell, b: Cell) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const cellText = (cell: Cell) => `(${cell.x},${cell.y},${cell.z})`;

/** Straight line seconds, the measure of "a walk is not too long to take instead of digging" (three times this and 20 s). */
const walkIsEnough = (straight: number, seconds: number) => seconds <= straight * WALK_S * 3 + 20;

/**
 * The plan from `from` to the first of `goals` the feet come near enough to (`range`, default the cell itself). Tiers: a way that digs and lays nothing, if there is
 * one and it is not far longer than the straight line (a way that is there is walked); else the way shortest in seconds; and when it digs more than the ceiling
 * (the head's maxDig, else DEFAULT_CEILING), the way raised in weight per dug block (3, 8, 20 s) until it digs least; past that, a plan of status `over`
 * with the blocks it needs, so the caller says it before moving.
 */
export function planRoute(read: BlockReader, from: Cell, goalCells: Cell[], options: RouteOptions = {}): RoutePlan {
  const started = performance.now();
  const goalsIn = goalCells.map(cell => ({ x: Math.floor(cell.x), y: Math.floor(cell.y), z: Math.floor(cell.z) }));
  const start = { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) };
  const range = options.range ?? 0;
  const margin = options.margin ?? DEFAULT_MARGIN;
  const ceiling = options.maxDig ?? DEFAULT_CEILING;
  const maxCells = options.maxCells ?? 400_000;
  const opts = { maxDrop: options.maxDrop ?? 3, waterOk: options.waterOk === true, placeBlocks: options.placeBlocks ?? 0 };
  const budget = options.ms ?? DEFAULT_MS;
  const empty = (status: RoutePlan['status'], why: string, tier: RoutePlan['tier'] = 'none', extra: Partial<RoutePlan> = {}): RoutePlan =>
    ({ status, steps: [], totals: emptyTotals(), digsByName: {}, wet: [], incidental: {}, why, tier, visited: 0, ms: Math.round(performance.now() - started), limited: false, ...extra });
  if (!goalsIn.length) return empty('none', 'goal が無い');

  // The box: the cells asked about and a margin; too big a box is cut round the start and the goal pulled to its edge (a partial plan, walked to and asked again).
  const xs = [start.x, ...goalsIn.map(c => c.x)], ys = [start.y, ...goalsIn.map(c => c.y)], zs = [start.z, ...goalsIn.map(c => c.z)];
  let box: Box = { x0: Math.min(...xs) - margin.side, x1: Math.max(...xs) + margin.side, z0: Math.min(...zs) - margin.side, z1: Math.max(...zs) + margin.side,
    y0: Math.max(-64, Math.min(...ys) - margin.down), y1: Math.min(319, Math.max(...ys) + margin.up) };
  let goals: Goals = { cells: goalsIn, range, horizontalOnly: false };
  const volume = (b: Box) => (b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) * (b.z1 - b.z0 + 1);
  // A big box first loses its margins (down to a few blocks) before the goal is pulled in.
  for (let side = margin.side; side >= MIN_SIDE_MARGIN && volume(box) > maxCells; side = Math.floor(side / 2)) {
    box = { ...box, x0: Math.min(...xs) - side, x1: Math.max(...xs) + side, z0: Math.min(...zs) - side, z1: Math.max(...zs) + side };
  }
  let clamped = false;
  if (volume(box) > maxCells) {
    const height = box.y1 - box.y0 + 1;
    const radius = Math.max(8, Math.floor((Math.sqrt(maxCells / height) - 1) / 2));
    const clampTo = (value: number, centre: number) => Math.max(centre - radius, Math.min(centre + radius, value));
    box = { ...box, x0: start.x - radius, x1: start.x + radius, z0: start.z - radius, z1: start.z + radius };
    goals = { cells: goalsIn.map(c => ({ x: clampTo(c.x, start.x), y: c.y, z: clampTo(c.z, start.z) })), range: 0, horizontalOnly: true };
    clamped = goalsIn.some(c => c.x !== clampTo(c.x, start.x) || c.z !== clampTo(c.z, start.z));
    if (!clamped) goals = { cells: goalsIn, range, horizontalOnly: false };
    // The goal may be inside the smaller box after all; then the height counts.
  }
  const grid = new Grid(box, read, options);
  const search = new RouteSearch(grid, opts);
  const maxNodes = options.maxNodes ?? 200_000;
  const deadlineFor = (share: number) => { const left = started + budget - performance.now(); return performance.now() + Math.max(20, left * share); };
  const finish = (searchResult: Search, allow: Allow, weights: Weights, tier: RoutePlan['tier'], statusIfWhole: RoutePlan['status'] = 'success'): RoutePlan => {
    const steps = search.steps(searchResult.path, searchResult.kinds, searchResult.laid, allow, weights);
    const whole = searchResult.status === 'success';
    const plan = planOf(grid, steps, whole ? (clamped ? 'partial' : statusIfWhole) : 'partial', tier,
      { visited: searchResult.nodes, ms: Math.round(performance.now() - started), limited: searchResult.limited });
    if (!whole || clamped) plan.frontier = steps.length ? steps[steps.length - 1].to : start;
    return plan;
  };

  if (!grid.inside(start.x, start.y, start.z)) return empty('none', `出発 ${cellText(start)} が計画の範囲の外`);
  // A goal that cannot be stood in at all (a wall, lava, a hurting block) with no range to stand beside it: said at once, not searched for.
  if (range === 0 && goalsIn.every(goal => grid.inside(goal.x, goal.y, goal.z) && (['wall', 'lava', 'harm', 'unloaded'].includes(grid.info(goal.x, goal.y, goal.z).kind) || (grid.info(goal.x, goal.y, goal.z).kind === 'water' && !opts.waterOk)))) {
    return empty('none', whyNone(grid, goalsIn, opts));
  }
  const goalLevel = Math.min(...goalsIn.map(c => c.y));
  const shaftOk = opts.placeBlocks >= Math.max(0, start.y - goalLevel) + 4;
  const noDig: Allow = { dig: false, place: false, shaft: false };
  const full: Allow = { dig: true, place: opts.placeBlocks > 0, shaft: shaftOk };
  const w0: Weights = { dig: DIG_WEIGHT_S, place: PLACE_WEIGHT_S };

  // Tier 1: nothing dug, nothing laid.
  const walked = search.run(start, goals, noDig, { dig: 0, place: 0 }, deadlineFor(0.4), maxNodes);
  const straight = Math.min(...goals.cells.map(c => near(c, start)));
  let walkPlan: RoutePlan | null = null;
  if (walked.status === 'success') {
    walkPlan = finish(walked, noDig, { dig: 0, place: 0 }, 'walk');
    if (walkIsEnough(straight, walkPlan.totals.seconds)) return walkPlan;
  }
  const altOf = (): RoutePlan['alt'] => {
    const cell = grid.cellOf(walked.closest);
    return { cell, remaining: Math.round(Math.min(...goalsIn.map(c => near(c, cell))) * 10) / 10 };
  };

  // Tier 2: the shortest in seconds, digging and laying as the pack allows.
  let best: Search | null = null;
  let bestWeights = w0;
  let bestAllow = full;
  let found = search.run(start, goals, full, w0, deadlineFor(0.5), maxNodes);
  if (found.status === 'success') { best = found; bestWeights = w0; }
  const placesOf = (s: Search, weights: Weights, allow: Allow) => search.steps(s.path, s.kinds, s.laid, allow, weights).reduce((n, step) => n + step.place.length, 0);
  // The pack holds so many blocks to lay: past that the weight of a laid block goes up, and at the last none is laid.
  if (best && Number.isFinite(opts.placeBlocks)) {
    for (const placeWeight of [4, 16, 64]) {
      if (placesOf(best, bestWeights, bestAllow) <= opts.placeBlocks) break;
      const weights = { dig: bestWeights.dig, place: placeWeight };
      const again = search.run(start, goals, full, weights, deadlineFor(0.5), maxNodes);
      if (again.status === 'success') { best = again; bestWeights = weights; }
    }
    if (placesOf(best, bestWeights, bestAllow) > opts.placeBlocks) {
      const noPlace: Allow = { dig: true, place: false, shaft: shaftOk };
      const again = search.run(start, goals, noPlace, w0, deadlineFor(0.5), maxNodes);
      best = again.status === 'success' ? again : null;
      bestAllow = noPlace;
    }
  }
  if (!best) {
    // Nothing whole. The plan nearest the goal is a part (the box ended or the time did), else there is no way.
    if (found.status === 'timeout' || (clamped && found.path.length > 1)) {
      const part = finish(found, full, w0, 'cost');
      part.status = 'partial';
      if (walkPlan) part.alt = altOf();
      return part;
    }
    if (walkPlan) return walkPlan;   // a long way round on foot is still a way
    return { ...empty('none', whyNone(grid, goalsIn, opts), 'none', { alt: altOf() }), visited: found.nodes, limited: found.limited };
  }
  let plan = finish(best, bestAllow, bestWeights, 'cost');
  if (walkPlan && walkPlan.totals.seconds <= plan.totals.seconds * 1.0001 && plan.totals.dig > 0) plan = walkPlan;
  if (plan.totals.dig <= ceiling) return plan;

  // Tier 3: the way over the ceiling: a block dug is weighed more and more until the way digs least.
  let fewest = plan;
  for (const digWeight of [3, 8, 20]) {
    const weights = { dig: digWeight, place: bestWeights.place };
    const again = search.run(start, goals, bestAllow, weights, deadlineFor(0.5), maxNodes);
    if (again.status !== 'success') continue;
    const candidate = finish(again, bestAllow, weights, 'few');
    if (candidate.totals.dig < fewest.totals.dig) fewest = candidate;
    if (fewest.totals.dig <= ceiling) break;
  }
  if (fewest.totals.dig <= ceiling) return fewest;
  // A way exists and digs more than the ceiling: said before it is walked, with the way by shaft.
  const dx = Math.min(...goalsIn.map(c => Math.abs(c.x - start.x))), dz = Math.min(...goalsIn.map(c => Math.abs(c.z - start.z)));
  const dy = start.y - goalLevel;
  const shaft = dy > 0 ? { dig: dy + 2 * (dx + dz), back: dy } : null;
  const over = { ...fewest, status: 'over' as const, over: { needed: fewest.totals.dig, ceiling, shaft } };
  if (walkPlan || walked.closest !== grid.index(start.x, start.y, start.z)) over.alt = altOf();
  return over;
}

/** Why no way: one reason, named. */
function whyNone(grid: Grid, goals: Cell[], opts: { waterOk: boolean; placeBlocks: number }): string {
  for (const goal of goals) {
    const info = grid.info(goal.x, goal.y, goal.z);
    if (info.kind === 'wall') return `${cellText(goal)} の ${info.name} は行き先そのもので、掘れない物`;
    if (info.kind === 'unloaded') return `${cellText(goal)} は未読み込み`;
    if (info.kind === 'lava') return `行き先 ${cellText(goal)} は溶岩の中`;
    if (info.kind === 'water' && !opts.waterOk) return `行き先 ${cellText(goal)} は水の中（waterOk が要る）`;
    if (info.kind === 'harm') return `行き先 ${cellText(goal)} は ${info.name}（立つと傷つく物）`;
    const floor = grid.info(goal.x, goal.y - 1, goal.z);
    if (info.kind === 'open' && !floor.floor && opts.placeBlocks <= 0) return `行き先 ${cellText(goal)} の足元に立てる床が無く、置く物が荷に無い`;
    if (info.kind === 'open' && floor.kind === 'wall') return `行き先 ${cellText(goal)} の足元の ${floor.name} は掘れず、そこへ入る道が見つからない`;
  }
  return `箱の中のどこからも ${cellText(goals[0])} に届かない（岩盤・村の建材など掘れない物に囲まれているか、立てる床が無く置く物が荷に無い）`;
}

// ===== The words =====

const NAME_JA: Record<string, string> = { stone: '石', dirt: '土', gravel: '砂利', sand: '砂', cobblestone: '丸石', deepslate: '深層岩', andesite: '安山岩', diorite: '閃緑岩', granite: '花崗岩', netherrack: 'ネザーラック' };
const nameJa = (name: string) => NAME_JA[name] ?? name;

/** What a plan says to the head: one line. Success first with the numbers; over with what it needs and the other way; none with its reason. */
export function summarizeRoute(plan: RoutePlan, goalText?: string): string {
  const t = plan.totals;
  const digs = Object.entries(plan.digsByName).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => `${nameJa(name)} ${n}`).join('・');
  const facts = [`歩 ${t.walk}`, `上り ${t.up}`, `下り ${t.down}`];
  if (t.dig) facts.push(`掘 ${t.dig}${digs ? `〔${digs}〕` : ''}`);
  if (t.place) facts.push(`置 ${t.place}`);
  const wet = plan.wet.length ? `。水の隣を掘る所 ${plan.wet.length}（置く ${plan.wet.length}・塞ぎ ${plan.wet.length}）` : t.dig || t.place ? '。水・溶岩のそばは避けた' : '';
  const ores = Object.entries(plan.incidental);
  const picked = ores.length ? `。鉱石も掘る（${ores.map(([name, n]) => `${name}×${n}`).join('・')}）` : '';
  if (plan.status === 'success') return `道 ${t.steps} マス（${facts.join('・')}）約 ${Math.round(t.seconds)} 秒${wet}${picked}`;
  if (plan.status === 'partial') {
    const at = plan.frontier;
    return `道は ${at ? cellText(at) : '途中'} まで ${t.steps} マス（${facts.join('・')}）約 ${Math.round(t.seconds)} 秒。着いたら出し直す${wet}`;
  }
  if (plan.status === 'over' && plan.over) {
    const { needed, ceiling, shaft } = plan.over;
    const alt = plan.alt ? `。掘らずに行ける最寄りは ${cellText(plan.alt.cell)}、${goalText ?? '行き先'}まであと ${Math.round(plan.alt.remaining)}m` : '';
    const vertical = shaft ? `（縦穴にすれば約 ${shaft.dig}、戻りに置く物 ${shaft.back}）` : '';
    return `この道は掘り ${needed}${vertical}で天井 ${ceiling} を超える${alt}`;
  }
  return `行けない: ${plan.why ?? '道が見つからない'}。別の側から`;
}
