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
const SIDES: ReadonlyArray<readonly [number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const DIRECTIONS = [{ direction: 'east', dx: 1, dz: 0 }, { direction: 'west', dx: -1, dz: 0 },
  { direction: 'south', dx: 0, dz: 1 }, { direction: 'north', dx: 0, dz: -1 }] as const;
const WORD = { east: '東', west: '西', south: '南', north: '北' };
const key = (p: LaneCell) => `${p.x},${p.y},${p.z}`;
const add = (p: LaneCell, dx: number, dy: number, dz: number): LaneCell => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz });
const cell = (p: LaneCell): LaneCell => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
const solid = (b: CampCellBlock | null | undefined) => !!b && (b.solid ?? b.boundingBox === 'block');
// Same two open cells as huntCamp; no floor or light test. It is a cell model, not a fractional hitbox simulation.
const open = (b: CampCellBlock | null | undefined) => !!b && !solid(b) && !HAZARDS.has(b.name);
const overlaps = (e: LaneEntity, p: LaneCell) => {
  const w = (e.width ?? 0.6) / 2, h = e.height ?? 1.8;
  return e.position.x + w > p.x && e.position.x - w < p.x + 1 && e.position.y + h > p.y && e.position.y < p.y + 1
    && e.position.z + w > p.z && e.position.z - w < p.z + 1;
};

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
      const d = Math.hypot(t.at.x + 0.5 - eye[0], t.at.y + 0.5 - eye[1], t.at.z + 0.5 - eye[2]);
      build.push({ at, part: t.part, supportNow, supportAfter, occupied: entities.filter(e => overlaps(e, t.at)).map(e => e.id),
        distance: Math.round(d * 100) / 100, inReach: d <= 4.5, visible: solidBetween(read, eye, [t.at.x + 0.5, t.at.y + 0.5, t.at.z + 0.5]).length === 0,
        noSupport: supportNow === false && !supportAfter, below: below(t.at), needsClearing: at.state === 'block' });
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
    + `指定の形でもレーン外に湧ける空間${best.remainingOutsideLane}か所・不明${best.unknownOutsideLane}か所。建築順は囲み、屋根と栓、蓋が基本で支えを先にする。手の距離は目から4.5以内、視線は現在の地形。`;
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
  const facts: Array<[number, boolean | null, number, number, LanePlacement['below']['end'], boolean]> = [], factIds = new Map<string, number>();
  const fact = (p: LanePlacement) => {
    const k = key(p.at);
    if (!factIds.has(k)) { factIds.set(k, facts.length); facts.push([ref(p.at), p.supportNow, p.occupied.length, p.below.depth, p.below.end, p.needsClearing]); }
    return factIds.get(k)!;
  };
  const parts: LanePart[] = ['enclosure', 'roof', 'plug', 'lid'];
  const candidates = report.candidates.map(c => ({ ...c, plug: ref(c.plug), lane: c.lane.map(p => [ref(p.feet), ref(p.head)]),
    waiting: [ref(c.waiting.feet), ref(c.waiting.head)], clear: c.clear.map(ref), hazards: c.hazards.map(p => [ref(p), p.inside]),
    build: c.build.map(p => [fact(p), parts.indexOf(p.part), p.supportAfter ? ref({ ...p.supportAfter, name: 'air', state: 'air' }) : null,
      (p.inReach ? 1 : 0) | (p.visible ? 2 : 0) | (p.noSupport ? 4 : 0)]) }));
  return { ...report, candidates, cells, facts,
    rows: { indexBase: 0, cells: ['x', 'y', 'z', 'name', 'state'], facts: ['cell', 'supportNow', 'occupiedCount', 'belowDepth', 'belowEnd', 'needsClearing'],
      build: ['fact', 'partIndex', 'supportAfterCell', 'flags'], parts, flags: { inReach: 1, visibleNow: 2, noSupport: 4 },
      lane: ['feetCell', 'headCell'], waiting: ['feetCell', 'headCell'], hazards: ['cell', 'inside'] } };
}
