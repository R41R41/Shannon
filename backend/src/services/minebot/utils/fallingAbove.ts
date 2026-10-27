import type { Cell } from './localMap.js';

/** Blocks that fall when what holds them is gone. */
export const FALLING_BLOCK = /^(?:sand|red_sand|gravel|suspicious_sand|suspicious_gravel|anvil|chipped_anvil|damaged_anvil|dragon_egg|pointed_dripstone|.*_concrete_powder)$/u;

interface FallBody {
  entity?: { position?: { x: number; y: number; z: number } };
  blockAt?(position: unknown, extraInfos?: boolean): { name?: string } | null;
}

/**
 * What falls onto the body when this cell is dug: the block right above the cell, when it is one that falls and the cell is in the body's own
 * column at or above its feet (the falling block comes down that column and stops on the body's floor, filling its feet and head).
 *
 * Run 41 (+1,805, replayed on its own ground): `dig 0,2,0` then `pillarUp 1`, eight times up a shaft; the fourth dig took the deepslate under
 * three gravel, the gravel came down the shaft while the body jumped, filled its feet and head cells, and it suffocated ten seconds later
 * with every tool it had. Nothing looked above the cell before the dig (the go's own climb did, `go.ts`).
 */
export function fallsOntoBody(bot: FallBody, cell: Cell, read: (cell: Cell) => { name?: string } | null): { name: string; at: Cell } | null {
  const position = bot.entity?.position;
  if (!position) return null;
  const feetY = Math.floor(position.y + 1e-3);
  if (cell.y < feetY) return null;
  const corners = [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]];
  if (!corners.some(([dx, dz]) => Math.floor(position.x + dx) === cell.x && Math.floor(position.z + dz) === cell.z)) return null;
  const at = { x: cell.x, y: cell.y + 1, z: cell.z };
  const name = String(read(at)?.name ?? '');
  return FALLING_BLOCK.test(name) ? { name, at } : null;
}
