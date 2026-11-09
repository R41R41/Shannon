import type { BlockReader, Cell } from './localMap.js';

interface BarrierEnemy { position: { x: number; y: number; z: number }; height?: number }
const AIR = new Set(['air', 'cave_air', 'void_air']);
const key = (cell: Cell) => `${cell.x},${cell.y},${cell.z}`;
const NEIGHBOURS = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];

/** null: no bounded opening here; 'blocked': an opening exists but cannot safely be sealed in this one hand. */
export function boundedMeleeBarrier(read: BlockReader, feet: Cell, direction: { x: number; z: number }, own: readonly Cell[],
  enemies: readonly BarrierEnemy[], available: number): Cell[] | 'blocked' | null {
  const front = { x: feet.x + direction.x, y: feet.y, z: feet.z + direction.z };
  const across = { x: -direction.z, z: direction.x };
  const column = (offset: number) => ({ x: front.x + across.x * offset, y: feet.y, z: front.z + across.z * offset });
  const solid = (cell: Cell) => read(cell.x, cell.y, cell.z)?.solid === true;
  const wallDistance = (sign: number): number | null => {
    for (let step = 1; step <= 3; step++) {
      const cell = column(sign * step);
      if (solid(cell) && solid({ ...cell, y: cell.y + 1 })) return step;
    }
    return null;
  };
  const left = wallDistance(-1), right = wallDistance(1);
  if (left === null || right === null || left + right - 1 > 3) return null;
  // All of this hand's threats must remain on the other side of the row it closes.
  if (enemies.some(enemy => (enemy.position.x - (feet.x + 0.5)) * direction.x
    + (enemy.position.z - (feet.z + 0.5)) * direction.z <= 1)) return 'blocked';
  const planned = new Set<string>(), cells: Cell[] = [];
  // For tall melee mobs, the upper row closes their passage first, anchored to the observed side wall.
  const levels = enemies.every(enemy => (enemy.height ?? 1.8) > 1) ? [1, 0] : [0, 1];
  for (const dy of levels) for (let offset = -left + 1; offset < right; offset++) {
    const cell = { ...column(offset), y: feet.y + dy };
    if (solid(cell)) continue;
    if (!AIR.has(read(cell.x, cell.y, cell.z)?.name ?? '') || own.some(body => key(body) === key(cell))) return 'blocked';
    // Preserve the existing placement margin; starting sooner must not relax entity collision safety.
    if (enemies.some(enemy => Math.abs(enemy.position.x - (cell.x + 0.5)) < 1
      && Math.abs(enemy.position.z - (cell.z + 0.5)) < 1 && Math.abs(enemy.position.y - cell.y) < 2.5)) return 'blocked';
    if (!NEIGHBOURS.some(([dx, dy, dz]) => {
      const neighbour = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz };
      return solid(neighbour) || planned.has(key(neighbour));
    })) return 'blocked';
    planned.add(key(cell)); cells.push(cell);
  }
  return cells.length && cells.length <= available ? cells : 'blocked';
}
