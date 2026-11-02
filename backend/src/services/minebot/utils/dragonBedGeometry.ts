import type { P3 } from './dragonParts.js';

/** The bed scene's placement: 2.2 blocks past the head, on a supporting column. Geometry only. */
export function perchBedFoot(head: P3, outward: P3, y: number): P3 {
  return { x: Math.floor(head.x + outward.x * 2.2), y: Math.floor(y), z: Math.floor(head.z + outward.z * 2.2) };
}

/** A one-block-thick obsidian screen between the bed and the standing point, built bottom first.
 * Width is the caller's material choice; it is never evidence that the screen stops the blast. */
export function bedWallCells(foot: P3, stand: P3, bottom: number, top: number, width: number): P3[] {
  const alongZ = Math.abs(stand.z - foot.z - 0.5) >= Math.abs(stand.x - foot.x - 0.5);
  const middle = alongZ ? Math.floor((foot.z + 0.5 + stand.z) / 2) : Math.floor((foot.x + 0.5 + stand.x) / 2);
  const cells: P3[] = [];
  for (let y = Math.floor(bottom); y <= Math.floor(top); y++) for (let i = -Math.floor((width - 1) / 2); i <= Math.ceil((width - 1) / 2); i++) {
    cells.push(alongZ ? { x: foot.x + i, y, z: middle } : { x: middle, y, z: foot.z + i });
  }
  return cells;
}
