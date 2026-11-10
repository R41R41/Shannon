import { Vec3 } from 'vec3';
import type { Cell } from '../localMap.js';

/** How long a place whose answer is overdue (promptPlace gives up at 1.5 s) is waited for before it is called refused (S2 lab: a server 2.2 s late with the block; run 6: a furnace 3 s late during a save). */
export const LATE_ANSWER_MS = 3500;

/** The block the hand held shows in the cell a place was made for within LATE_ANSWER_MS: the server was only slow. False when the cell is still not it, or the act is stopped. */
export async function laidLate(host: any, cell: Cell | null, blockName: string, stopped: () => boolean): Promise<boolean> {
  if (!cell || !blockName) return false;
  const at = new Vec3(cell.x, cell.y, cell.z);
  const until = Date.now() + LATE_ANSWER_MS;
  while (Date.now() < until && !stopped()) {
    if (String(host.blockAt?.(at, false)?.name ?? '') === blockName) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return String(host.blockAt?.(at, false)?.name ?? '') === blockName;
}
