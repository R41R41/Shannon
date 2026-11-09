interface Point { readonly x: number; readonly y: number; readonly z: number }
export interface ArrowSegmentCell { x: number; y: number; z: number; entry: number }

function entryFraction(from: readonly number[], delta: readonly number[], cell: readonly number[]): number | null {
  let enter = 0, leave = 1;
  for (let axis = 0; axis < 3; axis++) {
    if (delta[axis] === 0) {
      if (from[axis] < cell[axis] || from[axis] > cell[axis] + 1) return null;
    } else {
      const a = (cell[axis] - from[axis]) / delta[axis], b = (cell[axis] + 1 - from[axis]) / delta[axis];
      enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
      if (enter > leave) return null;
    }
  }
  return enter;
}

/** Closed voxel/segment intersections in travel order. Work follows crossed grid planes,
 * rather than the volume of the segment's bounding box. No world read or motor is owned here. */
export function arrowSegmentCells(from: Point, to: Point): readonly ArrowSegmentCell[] {
  const a = [from.x, from.y, from.z], b = [to.x, to.y, to.z];
  if ([...a, ...b].some(n => !Number.isFinite(n) || !Number.isSafeInteger(Math.floor(n)) || Math.abs(Math.floor(n)) >= Number.MAX_SAFE_INTEGER))
    throw new Error('Arrow segment coordinates are not finite cells');
  const delta = b.map((n, i) => n - a[i]), times = new Set([0, 1]);
  const low = a.map((n, i) => { const v = Math.min(n, b[i]); return Math.floor(v) - (Number.isInteger(v) ? 1 : 0); });
  const high = a.map((n, i) => Math.floor(Math.max(n, b[i])));
  for (let axis = 0; axis < 3; axis++) {
    for (let plane = Math.floor(Math.min(a[axis], b[axis])) + 1; plane < Math.max(a[axis], b[axis]); plane++) {
      times.add((plane - a[axis]) / delta[axis]);
    }
  }
  const cuts = [...times].sort((x, y) => x - y), probes = [...cuts];
  for (let i = 1; i < cuts.length; i++) probes.push((cuts[i - 1] + cuts[i]) / 2);
  const tested = new Set<string>(), cells: ArrowSegmentCell[] = [];
  for (const time of probes) {
    const p = a.map((n, i) => Math.floor(n + delta[i] * time));
    // Neighbours cover closed faces/edges and floating-point rounding at a grid plane.
    // Exact slab clipping below rejects any neighbour the segment does not touch.
    for (let x = Math.max(low[0], p[0] - 1); x <= Math.min(high[0], p[0] + 1); x++) {
      for (let y = Math.max(low[1], p[1] - 1); y <= Math.min(high[1], p[1] + 1); y++) {
        for (let z = Math.max(low[2], p[2] - 1); z <= Math.min(high[2], p[2] + 1); z++) {
          const key = `${x},${y},${z}`; if (tested.has(key)) continue; tested.add(key);
          const entry = entryFraction(a, delta, [x, y, z]);
          if (entry !== null) cells.push({ x, y, z, entry });
        }
      }
    }
  }
  return cells.sort((x, y) => x.entry - y.entry || x.x - y.x || x.y - y.y || x.z - y.z);
}

export function firstSolidInArrowSegment(from: Point, to: Point,
  read: (x: number, y: number, z: number) => { name: string; solid?: boolean } | null,
): { x: number; y: number; z: number; name: string } | null {
  for (const { x, y, z } of arrowSegmentCells(from, to)) {
    const block = read(x, y, z);
    if (block?.solid === true) return { x, y, z, name: block.name };
  }
  return null;
}
