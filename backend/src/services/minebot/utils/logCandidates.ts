import type { BlockReader, Cell, MapBlock } from './localMap.js';
import type { ScanCellHit } from './loadedBlockScan.js';
import { BESIDE, enterable, floorOf, isWater, standable } from './walkRules.js';
import { blockInSight, eyeOf, probeSight } from './probeTools.js';

export const LOG_SAMPLE_LIMIT = 64;
export const LOG_GROUP_LIMIT = 2;
export const LOG_READ_LIMIT = 512;
const key = (p: Cell) => `${p.x},${p.y},${p.z}`;
const isLog = (b: MapBlock | null) => !!b && /_(log|wood)$/u.test(b.name);
const supported = (b: MapBlock | null) => !!b && floorOf(b) && !isLog(b) && !b.name.endsWith('_leaves');

export interface LogCandidate {
  nearest: ScanCellHit;
  lowest: ScanCellHit;
  support: { at: Cell; name: string } | null;
  stand: { at: Cell; floor: string; visible: boolean; reach: boolean } | null;
}
export interface LogCandidates {
  candidates: LogCandidate[];
  retained: number;
  total: number;
  reads: number;
  unread: boolean;
  limited: boolean;
}

/** Observed connected log cells, never a botanical tree identity or a route. No world traversal beyond the retained sample. */
export function* inspectLogCandidates(read: BlockReader, hits: readonly ScanCellHit[], total: number): Generator<void, LogCandidates, void> {
  const sample = [...hits].sort((a, b) => a.distance - b.distance).slice(0, LOG_SAMPLE_LIMIT);
  const out: LogCandidates = { candidates: [], retained: sample.length, total, reads: 0, unread: false,
    limited: total > sample.length || hits.length > LOG_SAMPLE_LIMIT };
  const kept = new Map(sample.map(hit => [key(hit), hit]));
  const seen = new Set<string>();
  const cache = new Map<string, MapBlock | null>();
  const observed: BlockReader = (x, y, z) => {
    const id = `${x},${y},${z}`;
    if (cache.has(id)) return cache.get(id)!;
    if (out.reads >= LOG_READ_LIMIT) { out.limited = true; out.unread = true; return null; }
    out.reads++;
    const b = read(x, y, z);
    if (!b) out.unread = true;
    cache.set(id, b);
    return b;
  };
  for (const seed of sample) {
    if (seen.has(key(seed))) continue;
    if (out.candidates.length >= LOG_GROUP_LIMIT || out.reads >= LOG_READ_LIMIT) { out.limited = true; break; }
    const group = [seed]; seen.add(key(seed));
    for (let index = 0; index < group.length; index++) {
      const p = group[index];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const id = `${p.x + dx},${p.y + dy},${p.z + dz}`, next = kept.get(id);
        if (next && !seen.has(id)) { seen.add(id); group.push(next); }
      }
      yield; // At most 26 Map lookups before the scan's existing slice clock is checked.
    }
    const byHeight = [...group].sort((a, b) => a.y - b.y || a.distance - b.distance);
    let lowest = byHeight[0], support: LogCandidate['support'] = null;
    for (const cell of byHeight) {
      const current = observed(cell.x, cell.y, cell.z), below = observed(cell.x, cell.y - 1, cell.z);
      if (isLog(current) && supported(below)) {
        lowest = cell; support = { at: { x: cell.x, y: cell.y - 1, z: cell.z }, name: below!.name };
        yield;
        break;
      }
      yield;
    }
    const stands: NonNullable<LogCandidate['stand']>[] = [];
    for (const [dx, dy, dz] of BESIDE) {
      // Do not suggest standing on the very log to be dug, or inside its column.
      if (dx === 0 && dz === 0) continue;
      if (out.reads >= LOG_READ_LIMIT) { out.limited = true; break; }
      const at = { x: lowest.x + dx, y: lowest.y + dy, z: lowest.z + dz };
      const foot = observed(at.x, at.y, at.z), head = observed(at.x, at.y + 1, at.z), floor = observed(at.x, at.y - 1, at.z);
      if (supported(floor) && enterable(foot) && enterable(head) && !isWater(foot) && !isWater(head)
        && standable(observed, at.x, at.y, at.z)) {
        const eye = eyeOf(at, true), sight = probeSight(observed, eye, { block: lowest });
        // A trunk's upper log can hide its lower log's centre while its side face remains visible.
        const visible = blockInSight(observed, eye, lowest).visible;
        stands.push({ at, floor: floor!.name, visible, reach: sight.reach });
      }
      yield; // A fixed adjacent-cell check and a short sight ray; never probePath.
    }
    stands.sort((a, b) => Number(b.visible && b.reach) - Number(a.visible && a.reach) || a.at.y - b.at.y);
    out.candidates.push({ nearest: seed, lowest, support, stand: stands[0] ?? null });
  }
  return out;
}
