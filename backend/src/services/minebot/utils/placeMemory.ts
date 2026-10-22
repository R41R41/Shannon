import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import {
  biomesAround, describeBiomes, noteBiome,
  describeLastDeath, describeSeenReach, DRAGON_PLACES, DROP_LIFETIME_MS, emptyPlaceMemory, forgetPlaces, indexPlaces, makeRoom, mapSummary, markSeen, mergeRadius, observedDeaths, parsePlaceMemory,
  type ObservedDeath,
  placesDigest, recallPlaces, recordDeath, rememberPlace, seenReach, type PlaceKeep, type PlaceMemoryState, type RecalledPlace, type Sighting,
} from '../../../modules/minecraftLearning/places.js';
import { biomeFitsDimension } from './biomeNames.js';

const log = createLogger('Minebot:PlaceMemory');

/**
 * The body's side of the map in its head (`modules/minecraftLearning/places.ts`): what it takes note of as
 * the world comes into view, without being asked.
 *
 * Each chunk column is read once when the server sends it, and the few around the body again now and then
 * (what the body itself changes is there). A column is read by its sections' palettes, so one with nothing
 * of note costs a comparison per section. What is noted:
 *   - water and lava that can be reached with a bucket (a source with air over it),
 *   - ore that shows (a face of it open to air: what a person walking the cave would see),
 *   - things made to be used where they stand (crafting table, furnace, chest, bed, portal, spawner),
 *   - a structure, by the blocks only it is built of (a Nether fortress by its bricks),
 *   - a village, when the landmark watcher makes one out,
 *   - a cave under the overworld (a section with many open cells), and a cave entrance: a mouth at the surface from which the
 *     hollow under ground goes down 12 blocks or more (with the bottom it was followed to),
 *   - where the body died.
 * A place looked at again and found gone (ore mined, a furnace taken along) is dropped.
 */
const EQUIPMENT = ['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'barrel', 'enchanting_table', 'brewing_stand',
  'anvil', 'nether_portal', 'end_portal_frame', 'spawner', 'grindstone', 'smithing_table', 'obsidian'];
/**
 * Blocks only a built structure puts in the world, and the structure they give away (a whole one is one place). A village's bell;
 * a ruined portal's crying obsidian, and its netherrack, which the overworld has nowhere else (see OVERWORLD_ONLY); an igloo's
 * white carpet (on snow blocks: see noteCell). A shipwreck is a chest with water beside it (see noteCell).
 */
const STRUCTURE_MARKS: Record<string, string> = { nether_bricks: 'fortress', nether_brick_fence: 'fortress', nether_brick_stairs: 'fortress',
  bell: 'village', crying_obsidian: 'ruined_portal', netherrack: 'ruined_portal', white_carpet: 'igloo',
  // Rails lie in the overworld only in an abandoned mine (its timbers and planks are wood to be had).
  rail: 'mineshaft' };
/** Marks that mean their structure only in the overworld (the Nether is made of netherrack). */
const OVERWORLD_ONLY = new Set(['netherrack', 'rail']);
/** A section of the overworld below this height with this many open cells or more is noted as a cave (its middle, its size). */
const CAVE_BELOW_Y = 40;
const CAVE_MIN_CELLS = 400;
const SECTION_VOLUME = 4096;
/**
 * Cells read in one step: a quarter of a section. A whole section was one step, and the longest took 30-61 ms in natural worlds
 * (mb-body's runs 20-21): the body stood still for a tick or two.
 */
const SLICE_CELLS = 1024;
/**
 * A cave entrance: open air under the sky beside open air under ground (ground above it), from which the hollow under ground is
 * followed (air only, never out under the sky again) for at most ENTRANCE_CELLS cells. It is an entrance when that reaches
 * ENTRANCE_DEPTH blocks or more below the mouth: a way down to the iron and the diamonds that is walked, not dug. A ledge or a
 * nook is followed too, and found shallow.
 */
const ENTRANCE_CELLS = 1500;
const ENTRANCE_DEPTH = 12;
/** Mouths followed per column (the lowest first, each this far from the last), and cells followed in one step. */
const ENTRANCE_SEEDS = 4;
const ENTRANCE_SEED_APART = 6;
const ENTRANCE_STEP_CELLS = 100;
/** A cave followed this far below its mouth is deep enough to be worth the walk: it is followed no further. */
const ENTRANCE_DEEP_ENOUGH = 40;
/** Milliseconds of reading columns allowed in one physics tick (50ms): the body's own motion comes first. */
const TICK_BUDGET_MS = 2;
/** Steps kept in the stats as the slowest (to set beside the garbage collector's pauses). */
const SLOWEST_KEPT = 12;
const NEARBY_REREAD_TICKS = 200;
const VILLAGE_SAMPLE_TICKS = 100;
const SAVE_INTERVAL_MS = 30_000;
const FACES: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
/** Containers whose contents are noted when opened (the kinds the reading of columns knows them by). */
const CONTAINERS: Record<string, string> = { chest: 'chest', barrel: 'barrel' };
/**
 * Dropped items age only while their chunk is ticked: within the server's simulation distance of a player (10 chunks
 * by default). Further off, the five minutes stand still.
 */
const DROPS_AGE_WITHIN = 160;
/** How long after going through a portal the arrival is taken as its other end. */
const PORTAL_PAIR_MS = 20_000;
/** The biome line is read again after this long, or after this much travel. */
const BIOME_LINE_MS = 5_000;
const BIOME_LINE_MOVE = 16;
/** A death message is matched to a death this close in time (the chat and the health come in either order). */
const DEATH_MESSAGE_MS = 10_000;

interface ColumnEntry { chunkX: number | string; chunkZ: number | string; column: any }
interface ItemLike { name?: string; count?: number }
interface MemoryBot {
  entity?: { position: Vec3 };
  game?: { dimension?: unknown };
  username?: string;
  health?: number;
  registry: { blocksByName: Record<string, { name?: string; minStateId?: number; maxStateId?: number } | undefined> };
  world?: { getColumns?(): ColumnEntry[]; getColumn?(chunkX: number, chunkZ: number): any; getBlockStateId?(position: Vec3): number };
  blockAt?(position: Vec3): { stateId?: number; name?: string } | null;
  blockAtCursor?(maxDistance?: number): { name?: string; position: Vec3 } | null;
  heldItem?: { name?: string } | null;
  inventory?: { slots?: Array<ItemLike | null> };
  entities?: Record<string, { name?: string; position?: Vec3 } | undefined>;
  currentWindow?: unknown;
  landmarks?: Array<{ kind: string; position: { x: number; y: number; z: number }; evidence?: string }>;
  placeMemory?: PlaceMemory;
  on?(event: string, listener: (...args: any[]) => void): unknown;
  removeListener?(event: string, listener: (...args: any[]) => void): unknown;
}

export interface PlaceMemory {
  state: PlaceMemoryState;
  remember(kind: string, position: { x: number; y: number; z: number }, extra?: { count?: number; note?: string; keep?: PlaceKeep }): void;
  recall(kind?: string, limit?: number): RecalledPlace[];
  /** The nearest of each kind, one short line each, within what a decision's summary keeps (see placesDigest). */
  digest(limit?: number): Record<string, string>;
  /** The task's need: `dragon` puts the base, the portals, the stronghold, the fortress and the village first in the digest. */
  focus: 'dragon' | null;
  /** The last death as one line, while it matters (see describeLastDeath). */
  lastDeath(): string | undefined;
  /** The deaths of the last day as records, newest last, within what a decision's summary keeps (see observedDeaths). */
  deaths(): ObservedDeath[];
  /** How far the ground already seen reaches in each direction from the body, as one line (nearest new ground first). */
  unseen(): string;
  /** The biomes seen in this dimension, each by its nearest column, as one line (see describeBiomes); empty when none. */
  biomes(): string;
  /** The map: every kind of place known, by count and the nearest few, with the structures' chests (see mapSummary); 3,000 characters at most. */
  map(): string;
  flush(): void;
  /** Keep the memory in this file from now on (what the file already holds is taken up). */
  persistTo(file: string): void;
  /**
   * What reading costs the body. `maxReadMs` is the longest single step (a quarter of a section, a row of the ground, or a part of
   * following a cave down); `maxColumnMs` the most one chunk column took in all, its steps added up (they are spread over ticks);
   * `maxTickMs` the most the memory took out of one physics tick (reading, noting, saving); `setupMs` the reckoning of what is read
   * for, once per dimension; `stepBuckets` / `columnBuckets` how many steps / columns took under 0.5, 1, 2, 5 and 10 ms, and longer.
   */
  stats: { columnsRead: number; maxReadMs: number; totalReadMs: number; forgotten: number; maxColumnMs: number; maxTickMs: number;
    setupMs: number; stepBuckets: number[]; columnBuckets: number[];
    /** The steps of each kind (sections, ground, mouths, entrances): how many, their time in all, the longest (a column's noting is in its last step). */
    phases: Record<string, { steps: number; totalMs: number; maxMs: number; maxCpuMs: number }>;
    /**
     * The same longest step and column in CPU time (the process's, from getrusage): on a busy machine the clock also counts the
     * time the process waited for a core, and a garbage collection that fell in the step.
     */
    maxStepCpuMs: number; maxColumnCpuMs: number; columnCpuBuckets: number[];
    /** The slowest steps (at most SLOWEST_KEPT): which kind, when (performance.now), how long by the clock and in CPU. */
    slowest: Array<{ phase: string; at: number; ms: number; cpuMs: number }> };
  /** Reads what is waiting to be read, for at most this long (tests and probes; the tick does it by itself). */
  work(budgetMs: number): void;
}

/** What a block state is, for the reading: one look-up in a table instead of a set or a map per cell. */
const AIR = 1, KIND = 2, GROUND = 4, SNOW = 8;
/**
 * The ground a cave is under, and the ground under the sky: natural rock, earth, sand, snow and ice (a tree, a plant, a house is not
 * ground: the air under a canopy is not a cave).
 */
const GROUND_NAMES = /(^|_)(stone|deepslate|tuff|calcite|granite|diorite|andesite|dirt|grass_block|podzol|mycelium|mud|clay|gravel|sand|sandstone|terracotta|snow_block|ice|powder_snow|dripstone_block|moss_block|basalt|amethyst_block|budding_amethyst|obsidian|bedrock|magma_block|netherrack|blackstone|soul_sand|soul_soil|end_stone)$|_ore$/;

export interface Wanted { flags: Uint8Array; kindOf: Map<number, string>; liquidSource: Map<number, string>; kinds: Set<string>; overworld: boolean }

export function wantedStates(bot: MemoryBot, dimension = 'overworld'): Wanted {
  const blocks = Object.entries(bot.registry.blocksByName);
  let maxState = 0;
  for (const [, block] of blocks) if (block?.maxStateId !== undefined && block.maxStateId > maxState) maxState = block.maxStateId;
  const flags = new Uint8Array(maxState + 1);
  const kindOf = new Map<number, string>();
  const liquidSource = new Map<number, string>();
  const kinds = new Set<string>();
  const overworld = dimension.includes('overworld');
  for (const [name, block] of blocks) {
    if (block?.minStateId === undefined || block.maxStateId === undefined) continue;
    const mark = (flag: number) => { for (let state = block.minStateId!; state <= block.maxStateId!; state++) flags[state] |= flag; };
    if (name === 'air' || name === 'cave_air' || name === 'void_air') { mark(AIR); continue; }
    if (name === 'snow_block') mark(SNOW);
    if (GROUND_NAMES.test(name)) mark(GROUND);
    if (OVERWORLD_ONLY.has(name) && !overworld) continue;
    // A source is the first state of a liquid (level 0); only a source fills a bucket.
    if (name === 'water' || name === 'lava') { liquidSource.set(block.minStateId, name); kindOf.set(block.minStateId, name); flags[block.minStateId] |= KIND; kinds.add(name); continue; }
    const kind = name.endsWith('_ore') ? name.replace(/^deepslate_/, '') : name === 'ancient_debris' ? name
      : name.endsWith('_bed') ? 'bed' : EQUIPMENT.includes(name) ? name : STRUCTURE_MARKS[name] ?? null;
    if (!kind) continue;
    kinds.add(kind);
    for (let state = block.minStateId; state <= block.maxStateId; state++) kindOf.set(state, kind);
    mark(KIND);
  }
  if (overworld) { kinds.add('cave'); kinds.add('cave_entrance'); }
  kinds.add('shipwreck');
  // Lava with rock over it: read beside the lava that has air over it, and told apart on the map (a source poured on once its cover is dug).
  if (overworld) kinds.add('lava_covered');
  return { flags, kindOf, liquidSource, kinds, overworld };
}
const flagOf = (wanted: Wanted, state: number | null | undefined): number => (state === null || state === undefined ? 0 : wanted.flags[state] | 0);

interface Cluster { kind: string; position: Vec3; count: number; note?: string }

/**
 * What a spawner makes, as the server tells the client (which draws the mob turning inside the cage). A spawner
 * was remembered as a spawner and no more; the one a planner had come for (blazes, in a fortress) read the same
 * as any dungeon's, and a paid run walked round the fortress "looking for blazes" 97 blocks from the two it knew.
 */
function spawnedBy(column: any, x: number, y: number, z: number): string | undefined {
  try {
    const entity = column.getBlockEntity?.(new Vec3(x, y, z)) ?? column.blockEntities?.[`${x},${y},${z}`];
    const data = entity?.value?.SpawnData?.value;
    const id = data?.entity?.value?.id?.value ?? data?.id?.value;
    return typeof id === 'string' && id ? id.replace(/^minecraft:/, '') : undefined;
  } catch { return undefined; }
}

interface Point { x: number; y: number; z: number }
/** Which of the stats' buckets (under 0.5, 1, 2, 5, 10 ms, and longer) a time falls in. */
const BUCKET_EDGES = [0.5, 1, 2, 5, 10];
const bucketOf = (ms: number) => { const index = BUCKET_EDGES.findIndex(edge => ms < edge); return index < 0 ? BUCKET_EDGES.length : index; };
/** The section being read: its cells, and for a palette the flags of each entry (only those that matter in this section). */
interface SectionRead { data: any; palette?: number[]; bits?: { get(index: number): number }; paletteFlags?: Uint8Array; mask: number;
  cave: boolean; baseY: number; open: number; sumX: number; sumY: number; sumZ: number }

/**
 * The caves already followed down, shared by the columns read after them: one cave has a mouth in many columns (in a lab world, 38
 * mouths led to a dozen caves), and following it again from each cost up to 200 ms a column. The last CAVES_KEPT searches are kept
 * with the cells they reached; a mouth whose first cell one of them reached takes its bottom.
 */
export interface CaveFollowed { bottom: Point; cells: number }
interface FollowedCave { origin: Point; seen: Set<number>; followed: CaveFollowed }
export interface CaveCache { searches: FollowedCave[] }
export const newCaveCache = (): CaveCache => ({ searches: [] });
const CAVES_KEPT = 64;
function caveReaching(caves: CaveCache, cell: Point): CaveFollowed | null {
  for (const search of caves.searches) {
    const packed = packCell(search.origin, cell.x, cell.y, cell.z);
    if (packed >= 0 && search.seen.has(packed)) return search.followed;
  }
  return null;
}

/** Following the hollow under ground from one mouth (breadth first, down first), within ENTRANCE_CELLS. */
interface EntranceSearch extends FollowedCave { mouth: Point; queue: number[]; head: number }
interface ColumnJob {
  chunkX: number; chunkZ: number; column: any; clusters: Cluster[];
  phase: 'sections' | 'ground' | 'mouths' | 'entrances' | 'done';
  index: number; cell: number; section: SectionRead | null;
  /**
   * The top of the ground of each of the column's 256 cells (z*16+x), read row by row, and the highest open cell under it within
   * MOUTH_SPAN (NO_HOLLOW where there is none): where a cave under the ground comes nearest the surface.
   */
  top: Int16Array | null; hollow: Int16Array | null; groundRow: number;
  mouths: Array<{ mouth: Point; under: Point }>; search: EntranceSearch | null;
  caves: CaveCache;
  /** The columns round this one, the tops of their ground and which of their sections hold ground, as they are asked for. */
  columns: Map<number, any>; tops: Map<number, Int16Array>; hollows: Map<number, Int16Array>; groundSections: Map<any, Int8Array>;
  airSections: Map<any, Int8Array>;
  local: Vec3;
  readMs: number; cpuMs: number;
}
const newJob = (chunkX: number, chunkZ: number, column: any, caves: CaveCache): ColumnJob => ({ chunkX, chunkZ, column, clusters: [], phase: 'sections',
  index: 0, cell: 0, section: null, top: null, hollow: null, groundRow: 0, mouths: [], search: null, caves, columns: new Map(), tops: new Map(),
  hollows: new Map(), groundSections: new Map(), airSections: new Map(),
  local: new Vec3(0, 0, 0), readMs: 0, cpuMs: 0 });
const minYOf = (column: any): number => (typeof column?.minY === 'number' ? column.minY : 0);
/** A column as a small integer (chunks 32,768 apart share one: never both round one job). */
const columnKey = (chunkX: number, chunkZ: number) => ((chunkX & 0x7fff) << 15) | (chunkZ & 0x7fff);

/** The state of a cell of a column (local x and z, world y), straight from its section; null where the section is not there. */
function cellIn(column: any, lx: number, y: number, lz: number): number | null {
  const offset = y - minYOf(column);
  if (offset < 0) return null;
  const data = column.sections[offset >> 4]?.data;
  return data ? data.get(((offset & 15) << 8) | (lz << 4) | lx) : null;
}

function columnAt(bot: MemoryBot, job: ColumnJob, chunkX: number, chunkZ: number): any {
  if (chunkX === job.chunkX && chunkZ === job.chunkZ) return job.column;
  const key = columnKey(chunkX, chunkZ);
  let column = job.columns.get(key);
  if (column === undefined) {
    try { column = bot.world?.getColumn?.(chunkX, chunkZ) ?? null; } catch { column = null; }
    job.columns.set(key, column?.sections ? column : null);
  }
  return job.columns.get(key);
}

// The state of a cell anywhere, or null where it is not known. A column the server has not sent is not air:
// read as air (what the world object answers), every ore on the edge of a column counted as showing.
function stateAt(bot: MemoryBot, job: ColumnJob, x: number, y: number, z: number): number | null {
  const column = columnAt(bot, job, x >> 4, z >> 4);
  if (!column) return null;
  const state = cellIn(column, x & 15, y, z & 15);
  if (state !== null || typeof column.getBlockStateId !== 'function') return state;
  // Outside the sections it has (above or below the world): what the column itself says.
  try { job.local.x = x & 15; job.local.y = y; job.local.z = z & 15; return column.getBlockStateId(job.local); } catch { return null; }
}

function note(job: ColumnJob, kind: string, position: Vec3, what?: string): void {
  const radius = mergeRadius(kind);
  const known = job.clusters.find(cluster => cluster.kind === kind && cluster.position.distanceTo(position) <= radius);
  if (known) known.count++; else job.clusters.push({ kind, position, count: 1, ...(what ? { note: what } : {}) });
}

/** The section at `index` as it is to be read, or null when nothing in it is of note (told by its palette alone). */
function openSection(wanted: Wanted, column: any, index: number): SectionRead | null {
  const data = column.sections[index]?.data;
  if (!data) return null;
  const baseY = minYOf(column) + index * 16;
  // A cave: the open cells of a section of the overworld's underground, counted (a section of solid rock or of nothing but air is
  // passed over by its palette).
  const below = wanted.overworld && baseY + 15 < CAVE_BELOW_Y;
  const fresh = { data, baseY, open: 0, sumX: 0, sumY: 0, sumZ: 0 };
  const palette: number[] | undefined = Array.isArray(data.palette) ? data.palette : undefined;
  if (palette) {
    let air = false, solid = false, kind = false;
    for (const state of palette) {
      const flag = flagOf(wanted, state);
      if (flag & AIR) air = true; else solid = true;
      if (flag & KIND) kind = true;
    }
    const cave = below && air && solid;
    if (!cave && !kind) return null;
    const mask = KIND | (cave ? AIR : 0);
    // A palette's cells are indices into it: read straight from the bits, one look-up per cell.
    const bits = typeof data.data?.get === 'function' ? data.data : undefined;
    return { ...fresh, palette, bits, paletteFlags: Uint8Array.from(palette, state => flagOf(wanted, state) & mask), mask, cave };
  }
  // One state fills the section.
  if (typeof data.value === 'number') return flagOf(wanted, data.value) & KIND ? { ...fresh, mask: KIND, cave: false } : null;
  // No palette (more states than one holds): every cell is read.
  return { ...fresh, mask: KIND | (below ? AIR : 0), cave: below };
}

/** Notes what one cell of note is (it has the KIND flag). */
function noteCell(bot: MemoryBot, wanted: Wanted, job: ColumnJob, section: SectionRead, cell: number, state: number): void {
  const kind = wanted.kindOf.get(state);
  if (!kind) return;
  const x = job.chunkX * 16 + (cell & 15), y = section.baseY + (cell >> 8), z = job.chunkZ * 16 + ((cell >> 4) & 15);
  if (kind === 'igloo') {
    // An igloo's floor: white carpet on snow blocks (a carpet elsewhere is a house's).
    if (flagOf(wanted, stateAt(bot, job, x, y - 1, z)) & SNOW) note(job, kind, new Vec3(x, y, z));
    return;
  }
  if (kind === 'chest' && FACES.some(([dx, dy, dz]) => wanted.liquidSource.get(stateAt(bot, job, x + dx, y + dy, z + dz) ?? -1) === 'water')) {
    note(job, 'shipwreck', new Vec3(x, y, z));
  }
  if (wanted.liquidSource.has(state)) {
    // Reachable with a bucket: air over it. The cell above is in this section or the next one up.
    const above = (cell >> 8) < 15 ? section.data.get(cell + 256) : job.column.sections[job.index + 1]?.data?.get(cell & 255);
    if (flagOf(wanted, above) & AIR) note(job, kind, new Vec3(x, y, z));
    // Rock over it (not lava, not water, not an unloaded cell): a source that is poured on once its cover is dug (utils/lavaPools).
    else if (kind === 'lava' && wanted.overworld && above !== undefined && above !== null && !wanted.liquidSource.has(above) && (flagOf(wanted, above) & GROUND)) note(job, 'lava_covered', new Vec3(x, y, z));
  } else if (kind.endsWith('_ore') || kind === 'ancient_debris') {
    if (FACES.some(([dx, dy, dz]) => flagOf(wanted, stateAt(bot, job, x + dx, y + dy, z + dz)) & AIR)) note(job, kind, new Vec3(x, y, z));
  } else note(job, kind, new Vec3(x, y, z), kind === 'spawner' ? spawnedBy(job.column, cell & 15, y, (cell >> 4) & 15) : undefined);
}

/** Reads at most SLICE_CELLS cells of the column's sections, from where the last step stopped. */
function readSlice(bot: MemoryBot, wanted: Wanted, job: ColumnJob): void {
  const sections = job.column.sections;
  while (!job.section) {
    if (job.index >= sections.length) { job.phase = wanted.overworld ? 'ground' : 'done'; return; }
    job.section = openSection(wanted, job.column, job.index);
    if (!job.section) job.index++;
  }
  const section = job.section;
  const end = Math.min(SECTION_VOLUME, job.cell + SLICE_CELLS);
  const { bits, palette, paletteFlags, mask, data } = section;
  for (let cell = job.cell; cell < end; cell++) {
    let state: number, flag: number;
    if (bits) {
      const entry = bits.get(cell);
      flag = paletteFlags![entry];
      if (!flag) continue;
      state = palette![entry];
    } else {
      state = data.get(cell);
      flag = flagOf(wanted, state) & mask;
      if (!flag) continue;
    }
    if (flag & AIR) { section.open++; section.sumX += cell & 15; section.sumY += cell >> 8; section.sumZ += (cell >> 4) & 15; continue; }
    noteCell(bot, wanted, job, section, cell, state);
  }
  job.cell = end;
  if (end < SECTION_VOLUME) return;
  if (section.open >= CAVE_MIN_CELLS) {
    // One cave across sections and columns: its open cells added up where the hollows meet (mergeRadius of a cave).
    const middle = new Vec3(job.chunkX * 16 + Math.floor(section.sumX / section.open), section.baseY + Math.floor(section.sumY / section.open),
      job.chunkZ * 16 + Math.floor(section.sumZ / section.open));
    const known = job.clusters.find(cluster => cluster.kind === 'cave' && cluster.position.distanceTo(middle) <= mergeRadius('cave'));
    if (known) known.count += section.open; else job.clusters.push({ kind: 'cave', position: middle, count: section.open });
  }
  job.section = null; job.cell = 0; job.index++;
}

/** Which sections of a column hold any ground (by their palettes), worked out once a column for the job. */
function groundSectionsOf(wanted: Wanted, job: ColumnJob, column: any): Int8Array {
  let known = job.groundSections.get(column);
  if (known) return known;
  const sections = column.sections;
  known = new Int8Array(sections.length);
  for (let index = 0; index < sections.length; index++) {
    const data = sections[index]?.data;
    known[index] = !data ? 0 : Array.isArray(data.palette) ? (data.palette.some((state: number) => flagOf(wanted, state) & GROUND) ? 1 : 0)
      : typeof data.value === 'number' ? (flagOf(wanted, data.value) & GROUND ? 1 : 0) : 1;
  }
  job.groundSections.set(column, known);
  return known;
}

/** The highest ground block of one cell of a column (minY - 1 when it has none), from the top down; sections without ground are passed over. */
function groundTop(wanted: Wanted, job: ColumnJob, column: any, lx: number, lz: number): number {
  const sections = column.sections, minY = minYOf(column), withGround = groundSectionsOf(wanted, job, column);
  for (let index = sections.length - 1; index >= 0; index--) {
    if (!withGround[index]) continue;
    const data = sections[index].data;
    for (let ly = 15; ly >= 0; ly--) if (flagOf(wanted, data.get((ly << 8) | (lz << 4) | lx)) & GROUND) return minY + index * 16 + ly;
  }
  return minY - 1;
}

/** Which sections of a column have any air (by their palettes), worked out once a column for the job. */
function airSectionsOf(wanted: Wanted, job: ColumnJob, column: any): Int8Array {
  let known = job.airSections.get(column);
  if (known) return known;
  const sections = column.sections;
  known = new Int8Array(sections.length);
  for (let index = 0; index < sections.length; index++) {
    const data = sections[index]?.data;
    known[index] = !data ? 0 : Array.isArray(data.palette) ? (data.palette.some((state: number) => flagOf(wanted, state) & AIR) ? 1 : 0)
      : typeof data.value === 'number' ? (flagOf(wanted, data.value) & AIR ? 1 : 0) : 1;
  }
  job.airSections.set(column, known);
  return known;
}

/** The highest open cell under the top of the ground of one cell of a column, within MOUTH_SPAN of it; NO_HOLLOW where there is none. */
function hollowUnder(wanted: Wanted, job: ColumnJob, column: any, lx: number, lz: number, top: number): number {
  const minY = minYOf(column), withAir = airSectionsOf(wanted, job, column), sections = column.sections;
  for (let y = top - 1; y >= Math.max(minY, top - MOUTH_SPAN); y--) {
    const index = (y - minY) >> 4;
    // A section with no air in it is passed over whole.
    if (!withAir[index]) { y = minY + index * 16; continue; }
    if (flagOf(wanted, sections[index].data.get((((y - minY) & 15) << 8) | (lz << 4) | lx)) & AIR) return y;
  }
  return NO_HOLLOW;
}

/** Reads the top of the ground, and the highest hollow under it, of four rows of the column (64 cells) per step. */
function readGround(wanted: Wanted, job: ColumnJob): void {
  job.top ??= new Int16Array(256);
  job.hollow ??= new Int16Array(256);
  const last = Math.min(16, job.groundRow + 4);
  for (let lz = job.groundRow; lz < last; lz++) for (let lx = 0; lx < 16; lx++) {
    const top = job.top[lz * 16 + lx] = groundTop(wanted, job, job.column, lx, lz);
    job.hollow[lz * 16 + lx] = hollowUnder(wanted, job, job.column, lx, lz, top);
  }
  job.groundRow = last;
  if (last >= 16) job.phase = 'mouths';
}

const NO_TOP = -32_768;
const NO_HOLLOW = -32_767;

/** The highest hollow under the ground at a cell of another column (see hollowUnder), or null where the column is not known. */
function hollowAt(bot: MemoryBot, wanted: Wanted, job: ColumnJob, x: number, z: number): number | null {
  const top = groundTopAt(bot, wanted, job, x, z);
  if (top === null) return null;
  const key = columnKey(x >> 4, z >> 4);
  let hollows = job.hollows.get(key);
  if (!hollows) { hollows = new Int16Array(256).fill(NO_TOP); job.hollows.set(key, hollows); }
  const cell = (z & 15) * 16 + (x & 15);
  if (hollows[cell] === NO_TOP) hollows[cell] = hollowUnder(wanted, job, columnAt(bot, job, x >> 4, z >> 4), x & 15, z & 15, top);
  return hollows[cell];
}
/** The top of the ground at a cell of any column (the job's own from its rows), or null where the column is not known. */
function groundTopAt(bot: MemoryBot, wanted: Wanted, job: ColumnJob, x: number, z: number): number | null {
  const chunkX = x >> 4, chunkZ = z >> 4;
  if (chunkX === job.chunkX && chunkZ === job.chunkZ) return job.top![(z & 15) * 16 + (x & 15)];
  const column = columnAt(bot, job, chunkX, chunkZ);
  if (!column) return null;
  const key = columnKey(chunkX, chunkZ);
  let tops = job.tops.get(key);
  if (!tops) { tops = new Int16Array(256).fill(NO_TOP); job.tops.set(key, tops); }
  const cell = (z & 15) * 16 + (x & 15);
  if (tops[cell] === NO_TOP) tops[cell] = groundTop(wanted, job, column, x & 15, z & 15);
  return tops[cell];
}

const SIDES: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/** A hollow is looked for this far under the top of the ground at most (a cave in the face of a cliff of that height). */
const MOUTH_SPAN = 48;
/**
 * Where open air under the sky meets open air under a roof of ground, beside it: the mouths a cave down may start from. Each cell
 * beside is looked at once, at its highest hollow (see hollowUnder): looking up every height between the two grounds took 2-3 ms a
 * column and up to 37 ms in hills (lab world 20261020). The lowest first, a few blocks apart, at most ENTRANCE_SEEDS.
 */
function findMouths(bot: MemoryBot, wanted: Wanted, job: ColumnJob): void {
  const top = job.top!, hollow = job.hollow!, baseX = job.chunkX * 16, baseZ = job.chunkZ * 16, column = job.column;
  const found: Array<{ mouth: Point; under: Point }> = [];
  for (let lz = 0; lz < 16; lz++) for (let lx = 0; lx < 16; lx++) {
    const own = top[lz * 16 + lx];
    for (const [dx, dz] of SIDES) {
      // The cell beside, in this column or across its edge: its highest hollow, above this cell's ground and open to its air.
      const nx = lx + dx, nz = lz + dz, inside = nx >= 0 && nx < 16 && nz >= 0 && nz < 16;
      const y = inside ? hollow[nz * 16 + nx] : hollowAt(bot, wanted, job, baseX + nx, baseZ + nz);
      if (y === null || y === NO_HOLLOW || y <= own || !(flagOf(wanted, cellIn(column, lx, y, lz)) & AIR)) continue;
      found.push({ mouth: { x: baseX + lx, y, z: baseZ + lz }, under: { x: baseX + nx, y, z: baseZ + nz } });
    }
  }
  found.sort((a, b) => a.mouth.y - b.mouth.y);
  for (const candidate of found) {
    if (job.mouths.length >= ENTRANCE_SEEDS) break;
    if (job.mouths.some(kept => Math.hypot(kept.mouth.x - candidate.mouth.x, kept.mouth.y - candidate.mouth.y, kept.mouth.z - candidate.mouth.z) < ENTRANCE_SEED_APART)) continue;
    job.mouths.push(candidate);
  }
  job.phase = job.mouths.length ? 'entrances' : 'done';
}

/** A cell as a small integer, relative to where the search began (-1 beyond 255 blocks across or 511 up or down of it). */
const packCell = (origin: Point, x: number, y: number, z: number) => {
  const dx = x - origin.x + 256, dz = z - origin.z + 256, dy = y - origin.y + 512;
  return dx < 0 || dx > 511 || dz < 0 || dz > 511 || dy < 0 || dy > 1023 ? -1 : (dx << 19) | (dz << 10) | dy;
};
const DOWN_FIRST: Array<[number, number, number]> = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];

/** Notes the mouth as an entrance when the cave it leads into goes deep enough below it. */
function noteEntrance(job: ColumnJob, mouthAt: Point, followed: CaveFollowed): void {
  if (mouthAt.y - followed.bottom.y < ENTRANCE_DEPTH) return;
  const mouth = new Vec3(mouthAt.x, mouthAt.y, mouthAt.z);
  const bottom = `底 (${followed.bottom.x},${followed.bottom.y},${followed.bottom.z})`;
  // Two mouths of one cave within a column: the one that goes deeper is kept.
  const known = job.clusters.find(cluster => cluster.kind === 'cave_entrance' && cluster.position.distanceTo(mouth) <= mergeRadius('cave_entrance'));
  if (!known) job.clusters.push({ kind: 'cave_entrance', position: mouth, count: followed.cells, note: bottom });
  else if (Number(known.note?.match(/,(-?\d+),/)?.[1] ?? Infinity) > followed.bottom.y) Object.assign(known, { position: mouth, count: followed.cells, note: bottom });
}

/** Follows the hollow under ground from the next mouth, ENTRANCE_STEP_CELLS cells per step; notes an entrance where it goes deep enough. */
function followEntrance(bot: MemoryBot, wanted: Wanted, job: ColumnJob): void {
  if (!job.search) {
    const next = job.mouths.shift();
    if (!next) { job.phase = 'done'; return; }
    // A cave already followed (from this column or one read before): its bottom is known.
    const known = caveReaching(job.caves, next.under);
    if (known) { noteEntrance(job, next.mouth, known); return; }
    const start = packCell(next.under, next.under.x, next.under.y, next.under.z);
    job.search = { mouth: next.mouth, origin: next.under, queue: [start], head: 0, seen: new Set([start]), followed: { bottom: { ...next.under }, cells: 1 } };
  }
  const search = job.search, origin = search.origin, followed = search.followed;
  let cells = 0;
  while (search.head < search.queue.length && cells++ < ENTRANCE_STEP_CELLS) {
    // Deep enough to be worth the walk: no need to follow it further.
    if (search.mouth.y - followed.bottom.y >= ENTRANCE_DEEP_ENOUGH) { search.head = search.queue.length; break; }
    const key = search.queue[search.head++];
    const x = (key >> 19) - 256 + origin.x, z = ((key >> 10) & 511) - 256 + origin.z, y = (key & 1023) - 512 + origin.y;
    if (y < followed.bottom.y) followed.bottom = { x, y, z };
    for (const [dx, dy, dz] of DOWN_FIRST) {
      if (search.seen.size >= ENTRANCE_CELLS) break;
      const nx = x + dx, ny = y + dy, nz = z + dz;
      const packed = packCell(origin, nx, ny, nz);
      if (packed < 0 || search.seen.has(packed)) continue;
      // Open air only (not water, not rock), and never out under the sky again.
      if (!(flagOf(wanted, stateAt(bot, job, nx, ny, nz)) & AIR)) continue;
      const top = groundTopAt(bot, wanted, job, nx, nz);
      if (top === null || ny > top) continue;
      search.seen.add(packed);
      search.queue.push(packed);
    }
  }
  followed.cells = search.seen.size;
  if (search.head < search.queue.length) return;
  job.search = null;
  job.caves.searches.unshift({ origin, seen: search.seen, followed });
  if (job.caves.searches.length > CAVES_KEPT) job.caves.searches.pop();
  noteEntrance(job, search.mouth, followed);
}

/** One step of reading a column: a slice of a section, rows of the ground, the mouths, or a part of following one down. Returns which. */
function stepColumn(bot: MemoryBot, wanted: Wanted, job: ColumnJob): string {
  const phase = job.phase;
  if (phase === 'sections') readSlice(bot, wanted, job);
  else if (phase === 'ground') readGround(wanted, job);
  else if (phase === 'mouths') findMouths(bot, wanted, job);
  else if (phase === 'entrances') followEntrance(bot, wanted, job);
  return phase;
}

const sightingsOf = (job: ColumnJob, dimension: string): Sighting[] => job.clusters.map(cluster => ({ kind: cluster.kind, dimension,
  position: { x: cluster.position.x, y: cluster.position.y, z: cluster.position.z }, ...(cluster.count > 1 ? { count: cluster.count } : {}),
  ...(cluster.note ? { note: cluster.note } : {}) }));

/** What is worth noting in one chunk column, as sightings already gathered into places (a pool is one, a vein is one). */
export function readColumn(bot: MemoryBot, wanted: Wanted, entry: ColumnEntry, dimension: string, caves = newCaveCache()): Sighting[] {
  if (!entry.column?.sections) return [];
  const job = newJob(Number(entry.chunkX), Number(entry.chunkZ), entry.column, caves);
  while (job.phase !== 'done') stepColumn(bot, wanted, job);
  return sightingsOf(job, dimension);
}

export function installPlaceMemory(bot: MemoryBot, options: { file?: string } = {}): void {
  if (bot.placeMemory || typeof bot.on !== 'function') return;
  let file = options.file;
  const load = (from: string): PlaceMemoryState => {
    try { if (fs.existsSync(from)) return parsePlaceMemory(JSON.parse(fs.readFileSync(from, 'utf8'))); }
    catch (error) { log.warn(`場所の記憶を読めなかった（空から始める）: ${String(error)}`); }
    return emptyPlaceMemory();
  };
  const state = file ? load(file) : emptyPlaceMemory();
  const dimension = () => String(bot.game?.dimension ?? 'overworld');
  const here = () => bot.entity?.position ?? new Vec3(0, 0, 0);
  let dirty = false;
  let savedAt = Date.now();
  const flush = () => {
    if (!file || !dirty) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(memory.state), { mode: 0o600 });
      fs.renameSync(temporary, file);
      dirty = false; savedAt = Date.now();
    } catch (error) { log.warn(`場所の記憶を保存できなかった: ${String(error)}`); }
  };
  const from = () => ({ dimension: dimension(), position: here() });
  const memory: PlaceMemory = bot.placeMemory = {
    state,
    remember(kind, position, extra = {}) { rememberPlace(memory.state, { kind, dimension: dimension(), position, ...extra }, Date.now(), from()); dirty = true; },
    recall(kind, limit = 10) { return recallPlaces(memory.state, { from: here(), dimension: dimension(), kind, limit }); },
    digest(limit = 10) { return placesDigest(memory.state, here(), dimension(), limit, memory.focus === 'dragon' ? { ensure: DRAGON_PLACES } : {}); },
    focus: null,
    lastDeath() { return describeLastDeath(memory.state, Date.now(), from()); },
    deaths() { return observedDeaths(memory.state, Date.now()); },
    unseen() { return describeSeenReach(seenReach(memory.state, here(), dimension())); },
    biomes() {
      // Read again every few seconds, or after a few blocks of travel: the observation is taken far more often.
      const at = here(), now = Date.now();
      if (biomeLine && now - biomeLine.at < BIOME_LINE_MS && biomeLine.from.distanceTo(at) < BIOME_LINE_MOVE) return biomeLine.text;
      const text = describeBiomes(biomesAround(memory.state, at, dimension()));
      biomeLine = { at: now, from: at.clone(), text };
      return text;
    },
    map() {
      // Read again as the biome line is: the observation is taken far more often than the map changes.
      const at = here(), now = Date.now();
      if (mapLine && now - mapLine.at < BIOME_LINE_MS && mapLine.from.distanceTo(at) < BIOME_LINE_MOVE && mapLine.dimension === dimension()) return mapLine.text;
      const text = mapSummary(memory.state, at, dimension());
      mapLine = { at: now, from: at.clone(), text, dimension: dimension() };
      return text;
    },
    flush,
    persistTo(target) {
      const before = memory.state;
      file = target;
      memory.state = load(target);
      const now = Date.now();
      for (const place of before.places) rememberPlace(memory.state, place, now);
      for (const death of before.deaths ?? []) recordDeath(memory.state, death);
      for (const [where, columns] of Object.entries(before.seen ?? {})) {
        for (const column of columns) { const [chunkX, chunkZ] = column.split(',').map(Number); markSeen(memory.state, where, chunkX, chunkZ); }
      }
      for (const [where, columns] of Object.entries(before.biomes ?? {})) {
        for (const [column, biome] of Object.entries(columns)) { const [chunkX, chunkZ] = column.split(',').map(Number); noteBiome(memory.state, where, chunkX, chunkZ, biome); }
      }
      dirty = true;
    },
    stats: { columnsRead: 0, maxReadMs: 0, totalReadMs: 0, forgotten: 0, maxColumnMs: 0, maxTickMs: 0, setupMs: 0,
      stepBuckets: [0, 0, 0, 0, 0, 0], columnBuckets: [0, 0, 0, 0, 0, 0], phases: {}, maxStepCpuMs: 0, maxColumnCpuMs: 0,
      columnCpuBuckets: [0, 0, 0, 0, 0, 0], slowest: [] },
    work: budgetMs => work(budgetMs),
  };

  /**
   * The biome of a column, read at its middle: in the overworld at the height of the ground most of it lies at (y 64), so that the
   * caves under it do not stand for it; elsewhere at the body's own height. Null when the world cannot say.
   */
  // Read from the column just read itself, not through the world: a column gone from the world by then (it can unload while
  // the job spans ticks) answers 0 there, which is the id of badlands, and would be noted as that. A section not sent is no answer.
  const biomeOfColumn = (column: any): string | null => {
    try {
      if (typeof column?.getBiome !== 'function') return null;
      const y = dimension().includes('overworld') ? 64 : Math.floor(bot.entity?.position?.y ?? 64);
      const minY = typeof column.minY === 'number' ? column.minY : 0;
      // The biome section itself (prismarine-chunk answers 0, badlands, for one it does not have).
      const sections = Array.isArray(column.biomes) ? column.biomes : column.sections;
      if (Array.isArray(sections) && !sections[(y - minY) >> 4]) return null;
      const id = column.getBiome(new Vec3(8, y, 8));
      const name = typeof id === 'number' ? (bot.registry as { biomes?: Record<number, { name?: string }> }).biomes?.[id]?.name : undefined;
      // Not a name the dimension cannot have (an unsent section of the Nether reads 0, badlands: utils/biomeNames).
      return biomeFitsDimension(dimension(), name) ? name : null;
    } catch { return null; }
  };
  let biomeLine: { at: number; from: Vec3; text: string } | null = null;
  let mapLine: { at: number; from: Vec3; text: string; dimension: string } | null = null;

  // What is read for, per dimension (netherrack means a ruined portal only in the overworld; caves are counted only there).
  const wantedByDimension = new Map<string, Wanted>();
  let wanted: Wanted | null = null;
  const queue = new Set<string>();
  const enqueue = (chunkX: number, chunkZ: number) => queue.add(`${chunkX},${chunkZ}`);
  // One column at a time, a slice per step, within the tick's budget.
  let job: ColumnJob | null = null;
  // The caves followed down in this dimension (see CaveCache); forgotten with the dimension.
  let caves = newCaveCache();
  const finish = (done: ColumnJob) => {
    const where = dimension();
    const sightings = sightingsOf(done, where);
    const now = Date.now();
    // Known places inside this column that the reading no longer shows are gone.
    const baseX = done.chunkX * 16, baseZ = done.chunkZ * 16;
    const forgotten = forgetPlaces(memory.state, place => place.dimension === where && wanted!.kinds.has(place.kind)
      && place.position.x >= baseX && place.position.x < baseX + 16 && place.position.z >= baseZ && place.position.z < baseZ + 16
      && !sightings.some(sighting => sighting.kind === place.kind
        && Math.hypot(sighting.position.x - place.position.x, sighting.position.y - place.position.y, sighting.position.z - place.position.z) <= mergeRadius(place.kind)));
    // Room is made once for the column (a column can bring dozens of sightings).
    const index = sightings.length ? indexPlaces(memory.state) : undefined;
    for (const sighting of sightings) rememberPlace(memory.state, sighting, now, from(), { later: true, index });
    makeRoom(memory.state, now, from());
    if (markSeen(memory.state, where, done.chunkX, done.chunkZ) || sightings.length || forgotten) dirty = true;
    const biome = biomeOfColumn(done.column);
    if (biome && noteBiome(memory.state, where, done.chunkX, done.chunkZ, biome)) dirty = true;
    memory.stats.columnsRead++; memory.stats.forgotten += forgotten;
  };
  const work = (budgetMs: number) => {
    // Mineflayer injects plugins before login creates the world. Keep queued columns for readiness.
    if (!bot.world) return;
    const started = performance.now();
    // At least one step a call, however small the budget: a step is a slice (see SLICE_CELLS).
    for (let first = true; first || performance.now() - started < budgetMs; first = false) {
      if (!job) {
        const key = queue.values().next().value as string | undefined;
        if (key === undefined) return;
        queue.delete(key);
        const [chunkX, chunkZ] = key.split(',').map(Number);
        const column = bot.world?.getColumn?.(chunkX, chunkZ);
        if (!column?.sections) continue;
        const where = dimension();
        wanted = wantedByDimension.get(where) ?? null;
        if (!wanted) {
          const setupStarted = performance.now();
          wanted = wantedStates(bot, where);
          wantedByDimension.set(where, wanted);
          memory.stats.setupMs += performance.now() - setupStarted;
        }
        job = newJob(chunkX, chunkZ, column, caves);
      }
      // A column's noting (merging what it showed into the places kept) is a step of its own: once the memory is full it is the
      // largest part of a column (lab world 20261020), and it was not timed before.
      const stepStarted = performance.now(), cpuStarted = process.cpuUsage();
      const phase = job.phase === 'done' ? 'noting' : stepColumn(bot, wanted!, job);
      if (phase === 'noting') finish(job);
      const stepMs = performance.now() - stepStarted, cpu = process.cpuUsage(cpuStarted), stepCpuMs = (cpu.user + cpu.system) / 1000;
      const slowest = memory.stats.slowest;
      if (slowest.length < SLOWEST_KEPT || stepMs > slowest[slowest.length - 1].ms) {
        slowest.push({ phase, at: stepStarted, ms: stepMs, cpuMs: stepCpuMs });
        slowest.sort((a, b) => b.ms - a.ms);
        if (slowest.length > SLOWEST_KEPT) slowest.pop();
      }
      job.cpuMs += stepCpuMs;
      memory.stats.maxStepCpuMs = Math.max(memory.stats.maxStepCpuMs, stepCpuMs);
      const byPhase = memory.stats.phases[phase] ??= { steps: 0, totalMs: 0, maxMs: 0, maxCpuMs: 0 };
      byPhase.steps++; byPhase.totalMs += stepMs; byPhase.maxMs = Math.max(byPhase.maxMs, stepMs); byPhase.maxCpuMs = Math.max(byPhase.maxCpuMs, stepCpuMs);
      job.readMs += stepMs;
      memory.stats.maxReadMs = Math.max(memory.stats.maxReadMs, stepMs);
      memory.stats.stepBuckets[bucketOf(stepMs)]++;
      if (phase === 'noting') {
        // A column's cost is its steps added up, its noting included.
        memory.stats.totalReadMs += job.readMs;
        memory.stats.maxColumnMs = Math.max(memory.stats.maxColumnMs, job.readMs);
        memory.stats.columnBuckets[bucketOf(job.readMs)]++;
        memory.stats.maxColumnCpuMs = Math.max(memory.stats.maxColumnCpuMs, job.cpuMs);
        memory.stats.columnCpuBuckets[bucketOf(job.cpuMs)]++;
        job = null;
      }
    }
  };

  bot.on('chunkColumnLoad', (corner: Vec3) => { if (corner) enqueue(Math.floor(corner.x / 16), Math.floor(corner.z / 16)); });
  // What is carried and worn, taken while alive: at the moment of death the pack may already be emptied.
  let carried: Array<{ name: string; count: number }> = [];
  const takeStock = () => {
    const slots = bot.inventory?.slots;
    if (!Array.isArray(slots) || !(Number(bot.health) > 0)) return;
    const counts = new Map<string, number>();
    for (let slot = 1; slot <= 45 && slot < slots.length; slot++) {
      const item = slots[slot];
      if (item?.name && Number(item.count) > 0) counts.set(item.name, (counts.get(item.name) ?? 0) + Number(item.count));
    }
    // Fewest first: the one pickaxe and the armour before the stack of stone.
    carried = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.count - b.count || a.name.localeCompare(b.name));
  };
  let deathMessage: { text: string; at: number } | null = null;
  let deathAwaitingRespawn = false;
  bot.on('death', () => {
    const position = bot.entity?.position;
    if (!position) return;
    memory.remember('death', position);
    const now = Date.now();
    recordDeath(memory.state, { at: now, dimension: dimension(), position: { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) },
      lost: [...carried], nearMs: 0, ...(deathMessage && now - deathMessage.at < DEATH_MESSAGE_MS ? { cause: deathMessage.text } : {}) });
    // A body that died next to a portal did not go through it: the respawn is not its other end.
    deathMessage = null; deathAwaitingRespawn = true; lastPortal = null; dirty = true;
  });
  bot.on('message', (message: any) => {
    const key = String(message?.translate ?? '');
    try {
      if (key.startsWith('death.')) {
        const victim = message?.with?.[0];
        const name = String(victim?.toString?.() ?? victim?.text ?? '');
        if (bot.username && name && name !== bot.username) return;
        const text = String(message?.toString?.() ?? key).slice(0, 80);
        const latest = memory.state.deaths?.at(-1);
        if (latest && !latest.cause && Date.now() - latest.at < DEATH_MESSAGE_MS) { latest.cause = text; dirty = true; }
        else deathMessage = { text, at: Date.now() };
      } else if (key === 'block.minecraft.set_spawn') {
        // The bed the body used (activate-block by day, or sleep): the one it looks at, else the nearest beside it.
        const looked = bot.blockAtCursor?.(6);
        const bed = looked?.name?.endsWith('_bed') ? looked.position : nearbyBed();
        if (bed) setRespawn(bed);
      }
    } catch (error) { log.warn(`チャットから場所の記憶を更新できなかった: ${String(error)}`); }
  });
  const nearbyBed = (): Vec3 | null => {
    const at = bot.entity?.position?.floored?.();
    if (!at || !bot.blockAt) return null;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -2; dz <= 2; dz++) {
      const position = at.offset(dx, dy, dz);
      if (bot.blockAt(position)?.name?.endsWith('_bed')) return position;
    }
    return null;
  };
  /** One bed holds the respawn point: the one before it is an ordinary bed again (unless it was the base). */
  const setRespawn = (position: Vec3) => {
    for (const place of memory.state.places) if (place.keep === 'respawn') { delete place.keep; if (place.note === 'リスポーン地点') delete place.note; }
    memory.remember('bed', position, { keep: 'respawn', note: 'リスポーン地点' });
  };
  /**
   * What the body sets down itself: the first crafting table, bed and furnace in a dimension are its base. Told by the
   * world, not by a wrapped call (the placing methods are replaced by later plugins, and some skills place by another
   * one): such a block appears beside the body just after it held one.
   */
  let held: { name: string; at: number } | null = null;
  bot.on('blockUpdate', (_old: unknown, block: { name?: string; position?: Vec3 } | null) => {
    const name = block?.name;
    if (!name || !(name === 'crafting_table' || name === 'furnace' || name.endsWith('_bed')) || !block.position) return;
    try {
      const body = bot.entity?.position;
      if (!body || !held || Date.now() - held.at > 1500 || block.position.distanceTo(body) > 6) return;
      if (!(held.name === name || (name.endsWith('_bed') && held.name.endsWith('_bed')))) return;
      const kind = name.endsWith('_bed') ? 'bed' : name;
      const first = !memory.state.places.some(place => place.kind === kind && place.dimension === dimension() && place.keep === 'base');
      memory.remember(kind, block.position, first ? { keep: 'base', note: '拠点' } : {});
    } catch { /* the memory is optional */ }
  });
  // A chest's contents, noted on the place when it is opened and again when it is closed (after taking or putting).
  let containerWatch: (() => void) | null = null;
  bot.on('windowOpen', (window: any) => {
    containerWatch?.();
    const block = bot.blockAtCursor?.(6);
    const kind = block?.name ? CONTAINERS[block.name] : undefined;
    if (!block || !kind) return;
    const position = block.position;
    const note = () => {
      try {
        const counts = new Map<string, number>();
        for (const item of (window?.containerItems?.() ?? []) as ItemLike[]) if (item?.name) counts.set(item.name, (counts.get(item.name) ?? 0) + Number(item.count ?? 0));
        const items = [...counts].sort((a, b) => b[1] - a[1]);
        memory.remember(kind, position, { note: items.length ? `中身: ${items.slice(0, 6).map(([name, count]) => `${name}×${count}`).join(' ')}${items.length > 6 ? ` ほか${items.length - 6}種` : ''}` : '中身: 空' });
      } catch { /* a window without contents says nothing */ }
    };
    // The items come a moment after the window itself.
    const read = setTimeout(() => { if (bot.currentWindow === window) note(); }, 500);
    const onClose = (closed: unknown) => { if (closed === window) { note(); containerWatch?.(); } };
    containerWatch = () => { clearTimeout(read); bot.removeListener?.('windowClose', onClose); containerWatch = null; };
    bot.on?.('windowClose', onClose);
  });
  // A portal gone through: its two ends, each with the other, kept.
  let lastPortal: { dimension: string; position: Vec3; at: number } | null = null;
  const pairPortal = () => {
    const arrived = dimension(), position = bot.entity?.position;
    if (!lastPortal || !position || lastPortal.dimension === arrived || Date.now() - lastPortal.at > PORTAL_PAIR_MS) return;
    const there = position.floored(), back = lastPortal.position;
    const short = (name: string) => name.replace(/^minecraft:/, '').replace(/^the_/, '');
    const now = Date.now();
    rememberPlace(memory.state, { kind: 'nether_portal', dimension: lastPortal.dimension, position: back, keep: 'portal',
      note: `↔${short(arrived)}(${there.x},${there.y},${there.z})` }, now);
    rememberPlace(memory.state, { kind: 'nether_portal', dimension: arrived, position: there, keep: 'portal',
      note: `↔${short(lastPortal.dimension)}(${back.x},${back.y},${back.z})` }, now);
    lastPortal = null; dirty = true;
  };
  // A death's items: they age only near the body, and are gone once it has been back and found none.
  let agedAt = Date.now();
  const ageDrops = () => {
    const now = Date.now(), elapsed = Math.min(2000, now - agedAt);
    agedAt = now;
    const death = memory.state.deaths?.at(-1), position = bot.entity?.position;
    if (!death || !position || death.cleared || !death.lost.length || death.nearMs >= DROP_LIFETIME_MS || death.dimension !== dimension()) return;
    const away = Math.hypot(position.x - death.position.x, position.y - death.position.y, position.z - death.position.z);
    if (away <= DROPS_AGE_WITHIN) { death.nearMs = Math.min(DROP_LIFETIME_MS, death.nearMs + elapsed); dirty = true; }
    if (away <= 4 && Number(bot.health) > 0 && now - death.at > 5000
      && !Object.values(bot.entities ?? {}).some(entity => entity?.name === 'item' && entity.position
        && Math.hypot(entity.position.x - death.position.x, entity.position.y - death.position.y, entity.position.z - death.position.z) <= 8)) {
      death.cleared = true; dirty = true;
    }
  };
  const seedLoadedColumns = () => {
    for (const entry of bot.world?.getColumns?.() ?? []) enqueue(Number(entry.chunkX), Number(entry.chunkZ));
  };
  bot.on('login', seedLoadedColumns);
  // Spawn also covers plugin installation before login and a later respawn/dimension switch.
  // An unfinished column belongs to the previous world, never the new dimension.
  // The arrival is read a few ticks after the spawn: the spawn comes with the health, which may be ahead of the position.
  let pairInTicks = 0;
  bot.on('spawn', () => {
    job = null; queue.clear(); caves = newCaveCache(); seedLoadedColumns();
    pairInTicks = 10;
    if (deathAwaitingRespawn) {
      deathAwaitingRespawn = false;
      // keepInventory: the pack comes back with the body, so nothing lies at the place of death.
      setTimeout(() => {
        try {
          const death = memory.state.deaths?.at(-1);
          const lostCount = death?.lost.reduce((sum, item) => sum + item.count, 0) ?? 0;
          const slots = bot.inventory?.slots ?? [];
          const have = slots.slice(1, 46).reduce((sum, item) => sum + (item?.name ? Number(item.count ?? 0) : 0), 0);
          if (death && lostCount > 0 && have * 2 >= lostCount) { death.lost = []; dirty = true; }
        } catch { /* unknown stays as it was */ }
      }, 2000);
    }
  });
  bot.on('end', () => { job = null; queue.clear(); flush(); });
  seedLoadedColumns();
  let tick = 0;
  bot.on('physicsTick', () => {
    tick++;
    const tickStarted = performance.now();
    try {
      if (tick % NEARBY_REREAD_TICKS === 0 && bot.entity?.position) {
        const chunkX = Math.floor(bot.entity.position.x / 16), chunkZ = Math.floor(bot.entity.position.z / 16);
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) enqueue(chunkX + dx, chunkZ + dz);
      }
      const hand = bot.heldItem?.name;
      if (hand) held = { name: hand, at: Date.now() };
      if (pairInTicks > 0 && --pairInTicks === 0) pairPortal();
      if (tick % 5 === 0 && bot.entity?.position && bot.blockAt?.(bot.entity.position.floored())?.name === 'nether_portal') {
        lastPortal = { dimension: dimension(), position: bot.entity.position.floored(), at: Date.now() };
      }
      if (tick % 20 === 0) { takeStock(); ageDrops(); }
      if (tick % VILLAGE_SAMPLE_TICKS === 0) {
        for (const landmark of bot.landmarks ?? []) memory.remember(landmark.kind, landmark.position, landmark.evidence ? { note: landmark.evidence } : {});
      }
      work(TICK_BUDGET_MS);
      if (dirty && Date.now() - savedAt >= SAVE_INTERVAL_MS) flush();
    } catch (error) { log.warn(`場所の記憶の更新に失敗（身体は止めない）: ${String(error)}`); }
    memory.stats.maxTickMs = Math.max(memory.stats.maxTickMs, performance.now() - tickStarted);
  });
}

/**
 * Plugin form. The memory lives for the session. It is written to disk only once the host calls `persistTo`
 * with a file for this world, which a host does only for a world it can tell from every other (a display name
 * or an address is not an identity).
 */
export function placeMemoryPlugin(bot: unknown): void { installPlaceMemory(bot as MemoryBot); }
