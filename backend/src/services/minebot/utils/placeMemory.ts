import fs from 'node:fs';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import {
  describeLastDeath, describeSeenReach, DRAGON_PLACES, DROP_LIFETIME_MS, emptyPlaceMemory, forgetPlaces, markSeen, mergeRadius, parsePlaceMemory,
  placesDigest, recallPlaces, recordDeath, rememberPlace, seenReach, type PlaceKeep, type PlaceMemoryState, type RecalledPlace, type Sighting,
} from '../../../modules/minecraftLearning/places.js';

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
 *   - where the body died.
 * A place looked at again and found gone (ore mined, a furnace taken along) is dropped.
 */
const EQUIPMENT = ['crafting_table', 'furnace', 'blast_furnace', 'smoker', 'chest', 'barrel', 'enchanting_table', 'brewing_stand',
  'anvil', 'nether_portal', 'end_portal_frame', 'spawner'];
/** Blocks only a built structure puts in the world, and the structure they give away (a whole one is one place). */
const STRUCTURE_MARKS: Record<string, string> = { nether_bricks: 'fortress', nether_brick_fence: 'fortress', nether_brick_stairs: 'fortress' };
const SECTION_VOLUME = 4096;
/** Milliseconds of reading columns allowed in one physics tick (50ms): the body's own motion comes first. */
const TICK_BUDGET_MS = 2;
const NEARBY_REREAD_TICKS = 200;
const VILLAGE_SAMPLE_TICKS = 100;
const SAVE_INTERVAL_MS = 30_000;
const FACES: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
/** What a body sets down to live by: the first of each it places in a dimension is its base. */
const BASE_KINDS = new Set(['crafting_table', 'furnace', 'bed']);
/** Containers whose contents are noted when opened (the kinds the reading of columns knows them by). */
const CONTAINERS: Record<string, string> = { chest: 'chest', barrel: 'barrel' };
/**
 * Dropped items age only while their chunk is ticked: within the server's simulation distance of a player (10 chunks
 * by default). Further off, the five minutes stand still.
 */
const DROPS_AGE_WITHIN = 160;
/** How long after going through a portal the arrival is taken as its other end. */
const PORTAL_PAIR_MS = 20_000;
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
  placeBlock?(reference: { position: Vec3 }, face: Vec3, ...rest: unknown[]): Promise<unknown>;
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
  /** How far the ground already seen reaches in each direction from the body, as one line (nearest new ground first). */
  unseen(): string;
  flush(): void;
  /** Keep the memory in this file from now on (what the file already holds is taken up). */
  persistTo(file: string): void;
  /** `maxReadMs` is the longest single step (one section of one column). */
  stats: { columnsRead: number; maxReadMs: number; totalReadMs: number; forgotten: number };
  /** Reads what is waiting to be read, for at most this long (tests and probes; the tick does it by itself). */
  work(budgetMs: number): void;
}

interface Wanted { byState: Map<number, string>; air: Set<number>; liquidSource: Map<number, string>; kinds: Set<string> }

function wantedStates(bot: MemoryBot): Wanted {
  const byState = new Map<number, string>();
  const liquidSource = new Map<number, string>();
  const air = new Set<number>();
  const kinds = new Set<string>();
  for (const [name, block] of Object.entries(bot.registry.blocksByName)) {
    if (block?.minStateId === undefined || block.maxStateId === undefined) continue;
    if (name === 'air' || name === 'cave_air' || name === 'void_air') { for (let state = block.minStateId; state <= block.maxStateId; state++) air.add(state); continue; }
    // A source is the first state of a liquid (level 0); only a source fills a bucket.
    if (name === 'water' || name === 'lava') { liquidSource.set(block.minStateId, name); byState.set(block.minStateId, name); kinds.add(name); continue; }
    const kind = name.endsWith('_ore') ? name.replace(/^deepslate_/, '') : name === 'ancient_debris' ? name
      : name.endsWith('_bed') ? 'bed' : EQUIPMENT.includes(name) ? name : STRUCTURE_MARKS[name] ?? null;
    if (!kind) continue;
    kinds.add(kind);
    for (let state = block.minStateId; state <= block.maxStateId; state++) byState.set(state, kind);
  }
  return { byState, air, liquidSource, kinds };
}

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
interface ColumnJob { chunkX: number; chunkZ: number; column: any; index: number; clusters: Cluster[] }

/**
 * Reads one section (16 blocks of height) of the job's column and moves the job on. A column is read a
 * section at a time so that reading never takes more than a few milliseconds out of one tick: read whole,
 * a column cost 10ms on average and 120ms at worst (measured), and the body stood still meanwhile.
 */
function readSection(bot: MemoryBot, wanted: Wanted, job: ColumnJob): void {
  const column = job.column;
  const index = job.index++;
  const data = column.sections[index]?.data;
  if (!data) return;
  const palette: number[] | undefined = data.palette;
  if (palette ? !palette.some(state => wanted.byState.has(state)) : !(typeof data.value === 'number' && wanted.byState.has(data.value))) return;
  const baseX = job.chunkX * 16, baseZ = job.chunkZ * 16;
  const minY = typeof column.minY === 'number' ? column.minY : 0;
  const local = new Vec3(0, 0, 0);
  // The state beside a cell, or null where it is not known. A column the server has not sent is not air:
  // read as air (what the world object answers), every ore on the edge of a column counted as showing.
  const stateAt = (x: number, y: number, z: number): number | null => {
    try {
      const chunkX = Math.floor(x / 16), chunkZ = Math.floor(z / 16);
      const other = chunkX === job.chunkX && chunkZ === job.chunkZ ? column : bot.world?.getColumn?.(chunkX, chunkZ);
      if (!other?.getBlockStateId) return null;
      local.x = x & 15; local.y = y; local.z = z & 15;
      return other.getBlockStateId(local);
    } catch { return null; }
  };
  const note = (kind: string, position: Vec3, what?: string) => {
    const radius = mergeRadius(kind);
    const known = job.clusters.find(cluster => cluster.kind === kind && cluster.position.distanceTo(position) <= radius);
    if (known) known.count++; else job.clusters.push({ kind, position, count: 1, ...(what ? { note: what } : {}) });
  };
  for (let cell = 0; cell < SECTION_VOLUME; cell++) {
    const state = data.get(cell);
    const kind = wanted.byState.get(state);
    if (!kind) continue;
    const x = baseX + (cell & 15), y = minY + index * 16 + (cell >> 8), z = baseZ + ((cell >> 4) & 15);
    if (wanted.liquidSource.has(state)) {
      // Reachable with a bucket: air over it. The cell above is in this section or the next one up.
      const above = (cell >> 8) < 15 ? data.get(cell + 256) : column.sections[index + 1]?.data?.get(cell & 255);
      if (above !== undefined && wanted.air.has(above)) note(kind, new Vec3(x, y, z));
    } else if (kind.endsWith('_ore') || kind === 'ancient_debris') {
      if (FACES.some(([dx, dy, dz]) => { const beside = stateAt(x + dx, y + dy, z + dz); return beside !== null && wanted.air.has(beside); })) note(kind, new Vec3(x, y, z));
    } else note(kind, new Vec3(x, y, z), kind === 'spawner' ? spawnedBy(column, cell & 15, y, (cell >> 4) & 15) : undefined);
  }
}

const sightingsOf = (job: ColumnJob, dimension: string): Sighting[] => job.clusters.map(cluster => ({ kind: cluster.kind, dimension,
  position: { x: cluster.position.x, y: cluster.position.y, z: cluster.position.z }, ...(cluster.count > 1 ? { count: cluster.count } : {}),
  ...(cluster.note ? { note: cluster.note } : {}) }));

/** What is worth noting in one chunk column, as sightings already gathered into places (a pool is one, a vein is one). */
export function readColumn(bot: MemoryBot, wanted: Wanted, entry: ColumnEntry, dimension: string): Sighting[] {
  if (!entry.column?.sections) return [];
  const job: ColumnJob = { chunkX: Number(entry.chunkX), chunkZ: Number(entry.chunkZ), column: entry.column, index: 0, clusters: [] };
  while (job.index < job.column.sections.length) readSection(bot, wanted, job);
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
    unseen() { return describeSeenReach(seenReach(memory.state, here(), dimension())); },
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
      dirty = true;
    },
    stats: { columnsRead: 0, maxReadMs: 0, totalReadMs: 0, forgotten: 0 },
    work: budgetMs => work(budgetMs),
  };

  let wanted: Wanted | null = null;
  const queue = new Set<string>();
  const enqueue = (chunkX: number, chunkZ: number) => queue.add(`${chunkX},${chunkZ}`);
  // One column at a time, a section per step, within the tick's budget.
  let job: (ColumnJob & { startedReadMs: number }) | null = null;
  const finish = (done: ColumnJob & { startedReadMs: number }) => {
    const where = dimension();
    const sightings = sightingsOf(done, where);
    const now = Date.now();
    // Known places inside this column that the reading no longer shows are gone.
    const baseX = done.chunkX * 16, baseZ = done.chunkZ * 16;
    const forgotten = forgetPlaces(memory.state, place => place.dimension === where && wanted!.kinds.has(place.kind)
      && place.position.x >= baseX && place.position.x < baseX + 16 && place.position.z >= baseZ && place.position.z < baseZ + 16
      && !sightings.some(sighting => sighting.kind === place.kind
        && Math.hypot(sighting.position.x - place.position.x, sighting.position.y - place.position.y, sighting.position.z - place.position.z) <= mergeRadius(place.kind)));
    for (const sighting of sightings) rememberPlace(memory.state, sighting, now, from());
    if (markSeen(memory.state, where, done.chunkX, done.chunkZ) || sightings.length || forgotten) dirty = true;
    memory.stats.columnsRead++; memory.stats.forgotten += forgotten;
    memory.stats.totalReadMs += done.startedReadMs;
  };
  const work = (budgetMs: number) => {
    // Mineflayer injects plugins before login creates the world. Keep queued columns for readiness.
    if (!bot.world) return;
    const started = performance.now();
    while (performance.now() - started < budgetMs) {
      if (!job) {
        const key = queue.values().next().value as string | undefined;
        if (key === undefined) return;
        queue.delete(key);
        const [chunkX, chunkZ] = key.split(',').map(Number);
        const column = bot.world?.getColumn?.(chunkX, chunkZ);
        if (!column?.sections) continue;
        wanted ??= wantedStates(bot);
        job = { chunkX, chunkZ, column, index: 0, clusters: [], startedReadMs: 0 };
      }
      const stepStarted = performance.now();
      readSection(bot, wanted!, job);
      const stepMs = performance.now() - stepStarted;
      job.startedReadMs += stepMs;
      memory.stats.maxReadMs = Math.max(memory.stats.maxReadMs, stepMs);
      if (job.index >= job.column.sections.length) { finish(job); job = null; }
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
    deathMessage = null; deathAwaitingRespawn = true; dirty = true;
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
  /** One bed holds the respawn point: the one before it stays a kept bed, no longer the respawn. */
  const setRespawn = (position: Vec3) => {
    for (const place of memory.state.places) if (place.keep === 'respawn') { place.keep = 'base'; if (place.note === 'リスポーン地点') delete place.note; }
    memory.remember('bed', position, { keep: 'respawn', note: 'リスポーン地点' });
  };
  // What the body sets down itself: the first crafting table, bed and furnace in a dimension are its base.
  const placeBlock = bot.placeBlock;
  if (typeof placeBlock === 'function') {
    bot.placeBlock = async (reference, face, ...rest) => {
      try { return await placeBlock.call(bot, reference, face, ...rest); }
      finally {
        try {
          const position = reference?.position?.plus?.(face);
          const name = position ? bot.blockAt?.(position)?.name : undefined;
          const kind = name?.endsWith('_bed') ? 'bed' : name;
          if (position && kind && BASE_KINDS.has(kind)) {
            const first = !memory.state.places.some(place => place.kind === kind && place.dimension === dimension() && (place.keep === 'base' || place.keep === 'respawn'));
            memory.remember(kind, position, first ? { keep: 'base', note: '拠点' } : {});
          }
        } catch { /* the placement's own answer stands */ }
      }
    };
  }
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
  bot.on('spawn', () => {
    job = null; queue.clear(); seedLoadedColumns();
    try { pairPortal(); } catch { /* the memory is optional */ }
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
    try {
      if (tick % NEARBY_REREAD_TICKS === 0 && bot.entity?.position) {
        const chunkX = Math.floor(bot.entity.position.x / 16), chunkZ = Math.floor(bot.entity.position.z / 16);
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) enqueue(chunkX + dx, chunkZ + dz);
      }
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
  });
}

/**
 * Plugin form. The memory lives for the session. It is written to disk only once the host calls `persistTo`
 * with a file for this world, which a host does only for a world it can tell from every other (a display name
 * or an address is not an identity).
 */
export function placeMemoryPlugin(bot: unknown): void { installPlaceMemory(bot as MemoryBot); }
