import type { CampCellBlock, CampReader } from './huntCamp.js';
import { solidBetween } from './probeTools.js';

/** A reading of the specified shape, never a builder or a choice of when to build. */
export interface LaneCell { x: number; y: number; z: number }
export interface LaneEntity {
  id: number; name: string; position: LaneCell; width?: number; height?: number;
}
export interface LaneOptions { entities?: readonly LaneEntity[] }
export interface LaneBlock extends LaneCell { name: string | null; state: 'air' | 'solid' | 'block' | 'unloaded' }
export type LanePart = 'enclosure' | 'roof' | 'plug' | 'lid';
export interface LanePlacement {
  at: LaneBlock; part: LanePart;
  /** Six neighbouring faces now. null: none known, at least one neighbour unloaded. */
  supportNow: boolean | null;
  /** An earlier planned block, conditional on it actually being placed; never counts as supportNow. */
  supportAfter: LaneCell | null;
  occupied: number[];
  /** Eye at the waiting cell's centre, feet + 1.62, to the target centre. Distance only. */
  inReach: boolean; distance: number; visible: boolean;
  /** No face now or after the preceding supported placements (unknown faces stay unknown). */
  noSupport: boolean;
  /** Forty-eight cells read downwards: open is a bounded observation, not a world-bottom claim. */
  below: { depth: number; end: 'solid' | 'lava' | 'water' | 'unloaded' | 'open' };
  needsClearing: boolean;
  /** A currently standable feet cell; preceding unblocked placements must leave it and its sight line open. */
  standAt: LaneCell | null;
  noStand: 'out_of_reach' | 'hazard' | 'unloaded' | null;
  /** One-based, consecutive groups of at most six, or null when there is no footing. */
  group: number | null;
  blockedByCreature: boolean;
  /** false at a safe footing, null when no footing is available. */
  fireNear: boolean | null;
}
export interface LaneCandidate {
  direction: 'east' | 'west' | 'south' | 'north';
  plug: LaneBlock; lane: Array<{ feet: LaneBlock; head: LaneBlock }>; waiting: { feet: LaneBlock; head: LaneBlock };
  required: Record<LanePart, number> & { total: number; unknown: number; complete: boolean };
  build: LanePlacement[];
  /** Cells that must be open for the shape, read now; no digging is performed. */
  clear: LaneBlock[];
  hazards: Array<LaneBlock & { inside: boolean }>;
  /** After the specified shape, counting also the lower feet layer and the cleared lane. */
  remainingOutsideLane: number; unknownOutsideLane: number;
}
export interface LaneReport {
  text: string; spawner: LaneCell; from: LaneCell;
  spawn: { min: LaneCell; max: LaneCell; spaces: number; columns: number; unknown: number };
  blaze: { count: number; limit: 6; atLimit: boolean; min: LaneCell; max: LaneCell };
  candidates: LaneCandidate[];
}

const AIR = new Set(['air', 'cave_air', 'void_air']);
const HAZARDS = new Set(['lava', 'water', 'fire', 'soul_fire']);
const STAND_HAZARDS = new Set([...HAZARDS, 'magma_block', 'campfire', 'soul_campfire']);
const HORIZONTAL = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
const STAND_REACH = 4.3;
const SIDES: ReadonlyArray<readonly [number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const DIRECTIONS = [{ direction: 'east', dx: 1, dz: 0 }, { direction: 'west', dx: -1, dz: 0 },
  { direction: 'south', dx: 0, dz: 1 }, { direction: 'north', dx: 0, dz: -1 }] as const;
const WORD = { east: '東', west: '西', south: '南', north: '北' };
const key = (p: LaneCell) => `${p.x},${p.y},${p.z}`;
const add = (p: LaneCell, dx: number, dy: number, dz: number): LaneCell => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
const cell = (p: LaneCell): LaneCell => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const solid = (b: CampCellBlock | null | undefined) => !!b && (b.solid ?? b.boundingBox === 'block');
// boundingBox='block' alone also includes half boxes and narrow collision shapes.
const PARTIAL = /slab|stairs|fence|bars|pane|_wall$|chain|ladder|sign|trapdoor|_door$|chest|bed$|carpet|farmland|dirt_path|soul_sand|^mud$|^snow$|cactus|cake|anvil|enchanting_table|brewing_stand|hopper|cauldron|stonecutter|grindstone|lectern|bell|daylight_detector|end_portal_frame|head$|skull$/u;
const fullFloor = (b: CampCellBlock | null | undefined) => solid(b) && !PARTIAL.test(b!.name)
  && ((b as CampCellBlock & { top?: number }).top ?? 1) === 1;
// Same two open cells as huntCamp; no floor or light test. It is a cell model, not a fractional hitbox simulation.
const open = (b: CampCellBlock | null | undefined) => !!b && !solid(b) && !HAZARDS.has(b.name);
const overlaps = (e: LaneEntity, p: LaneCell) => {
  const w = (e.width ?? 0.6) / 2, h = e.height ?? 1.8;
  return e.position.x + w > p.x && e.position.x - w < p.x + 1 && e.position.y + h > p.y && e.position.y < p.y + 1
    && e.position.z + w > p.z && e.position.z - w < p.z + 1;
};

/** Voxel traversal, treating even a slab as an opaque cell. Unknown cells never make a clear line. */
function placementLine(read: CampReader, from: LaneCell, to: LaneCell): 'clear' | 'blocked' | 'unloaded' {
  const a = [from.x, from.y, from.z], b = [to.x, to.y, to.z];
  const pos = a.map(Math.floor), end = b.map(Math.floor), delta = b.map((v, i) => v - a[i]);
  const step = delta.map(Math.sign), stride = delta.map(v => v ? Math.abs(1 / v) : Infinity);
  const next = delta.map((v, i) => v ? (pos[i] + (v > 0 ? 1 : 0) - a[i]) / v : Infinity);
  let unknown = false;
  while (pos.some((v, i) => v !== end[i])) {
    const axis = next[0] <= next[1] && next[0] <= next[2] ? 0 : next[1] <= next[2] ? 1 : 2;
    pos[axis] += step[axis]; next[axis] += stride[axis];
    if (pos.every((v, i) => v === end[i])) break;
    const block = read(pos[0], pos[1], pos[2]);
    if (!block) unknown = true;
    else if (solid(block) || PARTIAL.test(block.name)) return 'blocked';
  }
  return unknown ? 'unloaded' : 'clear';
}

export function laneReport(reader: CampReader, spawner: LaneCell, from: LaneCell, options: LaneOptions = {}): LaneReport {
  if (![spawner.x, spawner.y, spawner.z, from.x, from.y, from.z].every(Number.isFinite)) throw new RangeError('lane coordinates must be finite');
  spawner = cell(spawner); from = cell(from);
  // A single snapshot of every cell asked; no map memory, world mutation, movement or external I/O.
  const cache = new Map<string, CampCellBlock | null>();
  const read = (x: number, y: number, z: number): CampCellBlock | null => {
    const k = `${x},${y},${z}`;
    if (!cache.has(k)) cache.set(k, reader(x, y, z) ?? null);
    return cache.get(k)!;
  };
  const block = (p: LaneCell): LaneBlock => {
    const b = read(p.x, p.y, p.z);
    return { ...p, name: b?.name ?? null, state: !b ? 'unloaded' : AIR.has(b.name) ? 'air' : solid(b) ? 'solid' : 'block' };
  };
  const entities = (options.entities ?? []).filter(e => [e.position.x, e.position.y, e.position.z].every(Number.isFinite));
  const standing = new Map<string, 'safe' | NonNullable<LanePlacement['noStand']>>();
  const footing = (p: LaneCell): 'safe' | NonNullable<LanePlacement['noStand']> => {
    const k = key(p), known = standing.get(k);
    if (known) return known;
    const check = (): 'safe' | NonNullable<LanePlacement['noStand']> => {
      const feet = read(p.x, p.y, p.z), head = read(p.x, p.y + 1, p.z), floor = read(p.x, p.y - 1, p.z);
      if (floor && !fullFloor(floor)) return 'out_of_reach';
      if (!feet || !head || !floor) return 'unloaded';
      if ([feet, head, floor].some(b => STAND_HAZARDS.has(b.name))) return 'hazard';
      if (!AIR.has(feet.name) || !AIR.has(head.name) || entities.some(e => overlaps(e, p) || overlaps(e, add(p, 0, 1, 0)))) return 'out_of_reach';
      let unknown = false;
      // Include diagonals and the floor/head's adjacent layer. Never promise safety beside an unread cell.
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 2; dy++) {
        const b = read(p.x + dx, p.y + dy, p.z + dz);
        if (!b) unknown = true;
        else if (STAND_HAZARDS.has(b.name)) return 'hazard';
      }
      // As in camp, a push onto an open neighbouring cell must not drop the body into a hole.
      for (const [dx, dz] of HORIZONTAL) {
        if (fullFloor(read(p.x + dx, p.y, p.z + dz)) || fullFloor(read(p.x + dx, p.y + 1, p.z + dz))) continue;
        const a = read(p.x + dx, p.y - 1, p.z + dz), b = read(p.x + dx, p.y - 2, p.z + dz);
        if (!(fullFloor(a) && !STAND_HAZARDS.has(a!.name)) && !(fullFloor(b) && !STAND_HAZARDS.has(b!.name))) {
          if (!a || !b) unknown = true;
          else return 'hazard';
        }
      }
      return unknown ? 'unloaded' : 'safe';
    };
    const result = check(); standing.set(k, result); return result;
  };
  const spawn = { min: add(spawner, -4, -1, -4), max: add(spawner, 4, 1, 4), spaces: 0, columns: 0, unknown: 0 };
  const columns: LaneCell[] = [];
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
    let possible = false;
    for (let dy = -1; dy <= 1; dy++) {
      const p = add(spawner, dx, dy, dz), a = read(p.x, p.y, p.z), b = read(p.x, p.y + 1, p.z);
      if (open(a) && open(b)) { spawn.spaces++; possible = true; }
      else if ((!a || !b) && (!a || open(a)) && (!b || open(b))) spawn.unknown++;
    }
    if (possible) columns.push(add(spawner, dx, 1, dz));
  }
  spawn.columns = columns.length;
  // A spawner block's AABB expanded by four: [x-4, x+5] on all three axes, a 9x9x9 counting box.
  const min = add(spawner, -4, -4, -4), max = add(spawner, 5, 5, 5);
  const count = entities.filter(e => e.name.replace(/^minecraft:/u, '') === 'blaze'
    && e.position.x + (e.width ?? 0.6) / 2 > min.x && e.position.x - (e.width ?? 0.6) / 2 < max.x
    && e.position.y + (e.height ?? 1.8) > min.y && e.position.y < max.y
    && e.position.z + (e.width ?? 0.6) / 2 > min.z && e.position.z - (e.width ?? 0.6) / 2 < max.z).length;
  const blaze = { count, limit: 6 as const, atLimit: count >= 6, min, max };

  const candidates: LaneCandidate[] = DIRECTIONS.map(({ direction, dx, dz }) => {
    const along = (n: number, dy = 0) => add(spawner, dx * n, dy, dz * n);
    const waitingFeet = along(5), plug = along(1, 1), laneFeet = [along(2), along(3), along(4)];
    const laneColumns = new Set(laneFeet.map(p => key(add(p, 0, 1, 0))));
    const targets: Array<{ at: LaneCell; part: LanePart }> = [];
    const targetKeys = new Set<string>();
    const target = (at: LaneCell, part: LanePart) => {
      if (!solid(read(at.x, at.y, at.z)) && !targetKeys.has(key(at))) { targets.push({ at, part }); targetKeys.add(key(at)); }
    };
    // Eight cells: floor, the two-high sides and back, ceiling. Only the mouth (towards the lane) stays open.
    target(add(waitingFeet, 0, -1, 0), 'enclosure');
    for (const side of [-1, 1]) for (const dy of [0, 1]) target(add(waitingFeet, -dz * side, dy, dx * side), 'enclosure');
    for (const dy of [0, 1]) target(along(6, dy), 'enclosure');
    target(add(waitingFeet, 0, 2, 0), 'enclosure');
    for (const n of [4, 3, 2]) target(along(n, 2), 'roof');
    target(plug, 'plug');
    const distance = (p: LaneCell) => Math.hypot(p.x - waitingFeet.x, p.y - waitingFeet.y, p.z - waitingFeet.z);
    for (const p of columns.filter(p => !laneColumns.has(key(p)) && key(p) !== key(plug)).sort((a, b) => distance(a) - distance(b))) target(p, 'lid');

    const required = { enclosure: 0, roof: 0, plug: 0, lid: 0, total: 0, unknown: 0, complete: true };
    for (const t of targets) {
      if (read(t.at.x, t.at.y, t.at.z)) { required[t.part]++; required.total++; } else required.unknown++;
    }
    required.complete = required.unknown === 0 && spawn.unknown === 0;
    const eye: [number, number, number] = [waitingFeet.x + 0.5, waitingFeet.y + 1.62, waitingFeet.z + 0.5];
    const built = new Map<string, LaneCell>();
    const build: LanePlacement[] = [];
    const faces = (p: LaneCell) => SIDES.map(([x, y, z]) => add(p, x, y, z));
    const support = (p: LaneCell): boolean | null => {
      const adjacent = faces(p).map(c => read(c.x, c.y, c.z));
      return adjacent.some(solid) ? true : adjacent.some(b => !b) ? null : false;
    };
    const prior = (p: LaneCell) => faces(p).map(c => built.get(key(c))).find(Boolean) ?? null;
    const below = (p: LaneCell): LanePlacement['below'] => {
      for (let depth = 0; depth < 48; depth++) {
        const b = read(p.x, p.y - depth - 1, p.z);
        const end = !b ? 'unloaded' : solid(b) ? 'solid' : b.name === 'lava' ? 'lava' : b.name === 'water' ? 'water' : null;
        if (end) return { depth, end };
      }
      return { depth: 48, end: 'open' };
    };
    const append = (t: typeof targets[number]) => {
      const at = block(t.at), supportNow = support(t.at), supportAfter = supportNow === true ? null : prior(t.at);
      const occupied = entities.filter(e => overlaps(e, t.at)).map(e => e.id);
      const d = Math.hypot(t.at.x + 0.5 - eye[0], t.at.y + 0.5 - eye[1], t.at.z + 0.5 - eye[2]);
      build.push({ at, part: t.part, supportNow, supportAfter, occupied,
        distance: Math.round(d * 100) / 100, inReach: d <= 4.5, visible: solidBetween(read, eye, [t.at.x + 0.5, t.at.y + 0.5, t.at.z + 0.5]).length === 0,
        noSupport: supportNow === false && !supportAfter, below: below(t.at), needsClearing: at.state === 'block',
        standAt: null, noStand: null, group: null, blockedByCreature: occupied.length > 0, fireNear: null });
      // Only an air target with a known face can provide a later hypothetical face. Occupancy is a separate present-time fact.
      if (at.state === 'air' && (supportNow === true || supportAfter)) built.set(key(t.at), t.at);
    };
    // Enclosure, roof/plug, then near-to-far lids are the priority. A prerequisite face may precede that order across phases too.
    const pending = [...targets];
    while (pending.length) {
      const ready = pending.findIndex(t => block(t.at).state === 'air' && (support(t.at) === true || prior(t.at)));
      if (ready < 0) { for (const t of pending) append(t); break; }
      append(pending.splice(ready, 1)[0]);
    }
    // Footings use the actual floor, never a future floor or an excavation. Earlier feasible placements
    // are opaque and cannot be stood in. A blocked/unsupported placement supplies no hypothetical cover.
    const placed = new Set<string>();
    const plannedRead: CampReader = (x, y, z) => placed.has(`${x},${y},${z}`) ? { name: 'cobblestone', solid: true } : read(x, y, z);
    const chooseStand = (p: LanePlacement) => {
      p.standAt = null; p.fireNear = null;
      if (p.at.state === 'unloaded') { p.noStand = 'unloaded'; return; }
      let hazard = false, unknown = false;
      const choices: Array<{ at: LaneCell; distance: number; protected: boolean; covered?: boolean }> = [];
      for (let x = p.at.x - 4; x <= p.at.x + 4; x++) for (let z = p.at.z - 4; z <= p.at.z + 4; z++) for (let y = p.at.y - 5; y <= p.at.y + 3; y++) {
        const q = { x, y, z };
        if (Math.hypot(x - p.at.x, y + 1.62 - (p.at.y + 0.5), z - p.at.z) > STAND_REACH) continue;
        if (x === p.at.x && z === p.at.z && (y === p.at.y || y + 1 === p.at.y)) continue;
        if (placed.has(key(q)) || placed.has(key(add(q, 0, 1, 0)))) continue;
        const state = footing(q);
        if (state !== 'safe') { hazard ||= state === 'hazard'; unknown ||= state === 'unloaded'; continue; }
        choices.push({ at: q, distance: distance(q), protected: Math.abs(x - spawner.x) > 4 || Math.abs(z - spawner.z) > 4
          || fullFloor(plannedRead(x, spawner.y + 1, z)) || fullFloor(plannedRead(x, spawner.y + 2, z)) });
      }
      const sheltered = (q: typeof choices[number]) => q.covered ??= placementLine(plannedRead,
        add(spawner, 0.5, 1.53, 0.5), add(q.at, 0.5, 1.62, 0.5)) === 'blocked';
      choices.sort((a, b) => a.distance - b.distance || Number(b.protected) - Number(a.protected) || Number(sheltered(b)) - Number(sheltered(a)));
      for (const q of choices) {
        const line = placementLine(plannedRead, add(q.at, 0.5, 1.62, 0.5), add(p.at, 0.5, 0.5, 0.5));
        if (line === 'unloaded') unknown = true;
        if (line !== 'clear') continue;
        p.standAt = q.at; p.noStand = null; p.fireNear = false; return;
      }
      p.noStand = hazard ? 'hazard' : unknown ? 'unloaded' : 'out_of_reach';
    };
    const project = (p: LanePlacement) => {
      if (p.standAt && !p.blockedByCreature && p.at.state === 'air'
        && (p.supportNow === true || (p.supportAfter && placed.has(key(p.supportAfter))))) placed.add(key(p.at));
    };
    for (const p of build) { chooseStand(p); project(p); }
    // Defer occupied cells within each run. Split before a row that requires an occupied face;
    // moving its prerequisite behind it would falsify the existing supportAfter contract.
    const runs: LanePlacement[][] = [];
    for (const p of build) {
      const run = runs.at(-1), last = run?.at(-1);
      if (!run || run.length === 6 || !p.standAt || !last?.standAt || key(p.standAt) !== key(last.standAt)
        || (!p.blockedByCreature && p.supportAfter && run.some(b => b.blockedByCreature && key(b.at) === key(p.supportAfter!)))) runs.push([p]);
      else run.push(p);
    }
    build.length = 0; placed.clear();
    let group = 0;
    for (const run of runs) {
      const ordered = [...run.filter(p => !p.blockedByCreature), ...run.filter(p => p.blockedByCreature)];
      let last: LanePlacement | undefined;
      for (const p of ordered) {
        // A deferred creature cell may now have another block in its line. Read the final order again.
        chooseStand(p);
        if (p.standAt) {
          if (!last?.standAt || key(last.standAt) !== key(p.standAt)) group++;
          p.group = group;
        }
        build.push(p); project(p); last = p;
      }
    }
    const interior = [...laneFeet, waitingFeet].flatMap(p => [p, add(p, 0, 1, 0)]);
    const clear = interior.map(block).filter(b => b.state !== 'air');
    const insideKeys = new Set(interior.map(key)), near = new Map<string, LaneCell>();
    for (const p of interior) for (const q of [p, ...faces(p)]) near.set(key(q), q);
    const hazards = [...near.values()].map(block).filter(b => b.name && HAZARDS.has(b.name)).map(b => ({ ...b, inside: insideKeys.has(key(b)) }));
    // Check the proposed final cells, including the lane excavation, rather than claiming the one head-layer seals every vertical layer.
    const cleared = new Set(interior.map(key));
    const finalOpen = (p: LaneCell): boolean | null => targetKeys.has(key(p)) ? false : cleared.has(key(p)) ? true
      : read(p.x, p.y, p.z) ? open(read(p.x, p.y, p.z)) : null;
    let remainingOutsideLane = 0, unknownOutsideLane = 0;
    for (let x = spawn.min.x; x <= spawn.max.x; x++) for (let z = spawn.min.z; z <= spawn.max.z; z++) for (let y = spawn.min.y; y <= spawn.max.y; y++) {
      if (y === spawner.y && laneFeet.some(p => p.x === x && p.z === z)) continue;
      const a = finalOpen({ x, y, z }), b = finalOpen({ x, y: y + 1, z });
      if (a === true && b === true) remainingOutsideLane++;
      else if (a !== false && b !== false && (a === null || b === null)) unknownOutsideLane++;
    }
    return { direction, plug: block(plug), lane: laneFeet.map(p => ({ feet: block(p), head: block(add(p, 0, 1, 0)) })),
      waiting: { feet: block(waitingFeet), head: block(add(waitingFeet, 0, 1, 0)) }, required, build, clear, hazards, remainingOutsideLane, unknownOutsideLane };
  });
  candidates.sort((a, b) => a.required.total - b.required.total);
  const best = candidates[0];
  const text = `湧ける空間は${spawn.spaces}か所・${spawn.columns}列（床と明るさは数に含めない、未ロードで不明${spawn.unknown}か所）。`
    + `既知の必要数の順は${candidates.map(c => `${WORD[c.direction]}${c.required.total}個${c.required.complete ? '' : '以上（不明あり）'}`).join('、')}。`
    + `見えている数え箱内のブレイズは${count}体（6体以上で湧き止めの条件${blaze.atLimit ? 'に達している' : 'には未到達'}）。`
    + `先頭の向きは、溶岩・水・火が中か隣に${best.hazards.length}マス、支えなし${best.build.filter(p => p.noSupport).length}マス、未ロードの建築マス${best.required.unknown}。`
    + `指定の形でもレーン外に湧ける空間${best.remainingOutsideLane}か所・不明${best.unknownOutsideLane}か所。建築順は囲み、屋根と栓、蓋が基本で支えを先にする。手の距離は目から4.5以内、視線は現在の地形。`
    + `\n立ち位置つきの建築順（${new Set(best.build.filter(p => p.group !== null).map(p => p.group)).size}組）。立てる所が無いマス${best.build.filter(p => !p.standAt).length}個。`;
  return { text, spawner, from, spawn, blaze, candidates };
}

/** All planned cells and requested flags, with common facts once. Occupancy counts and reach flags keep four plans within the receipt. */
export function laneProbeFields(report: LaneReport) {
  const cells: Array<[number, number, number, string | null, LaneBlock['state']]> = [], ids = new Map<string, number>();
  const ref = (p: LaneBlock) => {
    const k = key(p);
    if (!ids.has(k)) { ids.set(k, cells.length); cells.push([p.x, p.y, p.z, p.name, p.state]); }
    return ids.get(k)!;
  };
  const facts: Array<[number, boolean | null, number, number, LanePlacement['below']['end'], boolean, number]> = [], factIds = new Map<string, number>();
  const fact = (p: LanePlacement) => {
    const standing = standFact(p), k = `${key(p.at)}|${standing}`;
    if (!factIds.has(k)) { factIds.set(k, facts.length); facts.push([ref(p.at), p.supportNow, p.occupied.length, p.below.depth, p.below.end, p.needsClearing, standing]); }
    return factIds.get(k)!;
  };
  // Intern repeated reason/creature/fire facts without changing the original fact columns.
  const standFacts: Array<[LanePlacement['noStand'], boolean, boolean | null]> = [], standFactIds = new Map<string, number>();
  const standFact = (p: LanePlacement) => {
    const row: typeof standFacts[number] = [p.noStand, p.blockedByCreature, p.fireNear], k = JSON.stringify(row);
    if (!standFactIds.has(k)) { standFactIds.set(k, standFacts.length); standFacts.push(row); }
    return standFactIds.get(k)!;
  };
  const parts: LanePart[] = ['enclosure', 'roof', 'plug', 'lid'];
  const candidates = report.candidates.map(c => ({ ...c, plug: ref(c.plug), lane: c.lane.map(p => [ref(p.feet), ref(p.head)]),
    waiting: [ref(c.waiting.feet), ref(c.waiting.head)], clear: c.clear.map(ref), hazards: c.hazards.map(p => [ref(p), p.inside]),
    build: c.build.map(p => [fact(p), parts.indexOf(p.part), p.supportAfter ? ref({ ...p.supportAfter, name: 'air', state: 'air' }) : null,
      (p.inReach ? 1 : 0) | (p.visible ? 2 : 0) | (p.noSupport ? 4 : 0),
      p.standAt ? ref({ ...p.standAt, name: 'air', state: 'air' }) : null, p.group]) }));
  return { ...report, candidates, cells, facts,
    rows: { indexBase: 0, cells: ['x', 'y', 'z', 'name', 'state'], facts: ['cell', 'supportNow', 'occupiedCount', 'belowDepth', 'belowEnd', 'needsClearing', 'standFact'],
      build: ['fact', 'partIndex', 'supportAfterCell', 'flags', 'standAtCell', 'group'], parts, flags: { inReach: 1, visibleNow: 2, noSupport: 4 },
      lane: ['feetCell', 'headCell'], waiting: ['feetCell', 'headCell'], hazards: ['cell', 'inside'],
      standFacts: ['noStand', 'blockedByCreature', 'fireNear'] }, standFacts };
}
