import type { Vec3 } from 'vec3';
import type { SkillResult } from '../types/skillParams.js';
import { reachWorkstation, type StationBot } from './workstationAccess.js';

/** How near the eyes a furnace has to be for its window to open (the body's use reach). */
export const FURNACE_REACH = 4.5;

/**
 * Brings a furnace within reach (and in sight) before it is opened: null when it is (or now is), else why not and what to do. The
 * walk is move-to's `block` goal, a stand from which the block can be reached whatever the height. Run 17 was told "too far" three
 * times by withdraw-from-furnace, once standing 14 blocks under the furnace after a move in XZ that said it had arrived. Run 20's
 * start-smelting was refused a furnace at 4.3 m (measured from the feet: the eyes are further, and a table stood between), and a
 * third furnace was made for it.
 *
 * Reach is measured as the server does, from the eyes to the block (utils/blockInteractionReach), not from the feet; when the coarse
 * walk leaves the furnace out of sight or still out of reach, a stand beside it is looked for and walked to
 * (utils/workstationAccess) before it is given up, and the failure says which block is in the way.
 */
export async function approachFurnace(bot: StationBot, pos: Vec3,
  move: (x: number, y: number, z: number, range: number, goalType: string) => Promise<SkillResult>,
  options: { stopped?: () => boolean; tryAnyway?: boolean; clearSight?: (position: Vec3) => Promise<{ clear: boolean; dug: boolean }> } = {}): Promise<SkillResult | null> {
  return reachWorkstation(bot, pos, move, { label: 'かまど', ...options });
}
