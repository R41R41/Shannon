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

/** A cell that is over the reach by no more than this many metres is stepped toward (a step or two), not refused (run 8: 5.1 m and 6.3 m stopped as out_of_reach). */
export const REACH_SLACK_M = 2;
/**
 * The hands that work on a cell (dig, place, furnace) hold to the reach (5 m from the eyes). A cell just over it: the body walks the way only (nothing dug, nothing laid) to a stand
 * within reach, in a few seconds. True when the cell is in reach afterwards; a cell farther than REACH_SLACK_M over, or no way, is false and the hand says out_of_reach as before.
 */
export async function stepIntoReach(ctx: StepContext, cell: Cell, reach: number): Promise<boolean> {
  const bot = ctx.bot;
  const distance = eyeDistance(bot, cell);
  if (distance <= reach) return true;
  if (distance > reach + REACH_SLACK_M) return false;
  const navigator = bot.pathfinder as { movements?: unknown; setMovements(movements: unknown): void } | undefined;
  if (!navigator) return false;
  const previous = navigator.movements;
  try {
    navigator.setMovements(walkMovements(bot, false));
    // The goal is a standing place (feet) near the cell: the eyes are some 1.6 m up, so the range keeps them inside the reach.
    await goWith(ctx, new goals.GoalNear(cell.x, cell.y, cell.z, Math.max(1, reach - 2.2)), Math.max(500, Math.min(3000, ctx.deadline - Date.now())), { opened: [], leaves: 0 });
  } catch (error) {
    if (!(error instanceof Error) || /Action interrupted/u.test(error.message) || error.name === 'StepStopped') throw error;
  } finally { letGo(bot); try { if (previous) navigator.setMovements(previous); } catch { /* kept */ } }
  return eyeDistance(bot, cell) <= reach;
}
