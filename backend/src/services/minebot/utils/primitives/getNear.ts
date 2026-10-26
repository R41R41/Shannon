import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { bodyReader, type Cell } from '../localMap.js';
import { blockInSight, eyeOf } from '../probeTools.js';
import { DIG_REACH, eyeDistance, letGo, type StepContext } from './common.js';
import { goWith, walkMovements, type WayNotes } from './walk.js';

const { goals } = pathfinder;

/**
 * Whether the eye reaches the cell and sees a face of it: the test every hand that works on a block (dig, a furnace, a table) is held to.
 * `reach` is the nearer bound the hand wants (a little under the dig reach, so that a step of drift does not lose it).
 */
export function canWorkOn(bot: any, cell: Cell, reach = DIG_REACH - 0.2): boolean {
  const at = bot.entity?.position;
  if (!at || eyeDistance(bot, cell) > reach) return false;
  try { return blockInSight(bodyReader(bot), eyeOf(at), cell).visible; } catch { return false; }
}

/**
 * Walks, digging nothing and laying nothing (the walk's own rules), to where the cell can be worked on: in reach and seen. The route search
 * is given a goal that is any standing place from which a ray of the eye meets the block (mineflayer-pathfinder's GoalLookAtBlock).
 */
export async function getNear(ctx: StepContext, cell: Cell, notes: WayNotes, reach = DIG_REACH - 0.3, timeoutMs = 20_000): Promise<{ near: boolean; timedOut: boolean; stuck: boolean }> {
  const bot = ctx.bot;
  if (canWorkOn(bot, cell)) return { near: true, timedOut: false, stuck: false };
  const navigator = bot.pathfinder as { movements?: unknown; setMovements(movements: unknown): void } | undefined;
  if (!navigator) return { near: false, timedOut: false, stuck: false };
  const previous = navigator.movements;
  try {
    navigator.setMovements(walkMovements(bot, false));
    const goal = new goals.GoalLookAtBlock(new Vec3(cell.x, cell.y, cell.z), bot.world, { reach });
    const gone = await goWith(ctx, goal, Math.max(1000, Math.min(timeoutMs, ctx.deadline - Date.now())), notes);
    if (!canWorkOn(bot, cell)) letGo(bot);
    return { near: canWorkOn(bot, cell), timedOut: gone.timedOut, stuck: gone.stuck };
  } finally { try { if (previous) navigator.setMovements(previous); } catch { /* kept */ } }
}
