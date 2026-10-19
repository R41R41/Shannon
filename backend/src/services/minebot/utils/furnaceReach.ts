import type { Vec3 } from 'vec3';
import type { SkillResult } from '../types/skillParams.js';

/** How near the eyes a furnace has to be for its window to open (the body's use reach). */
export const FURNACE_REACH = 4.5;
/** The stand looked for: the furnace within this of the eyes, so that the open is not at the very edge of reach. */
const STAND_REACH = 4;

/**
 * Brings a furnace within reach before it is opened: null when it is (or now is), else why not. The walk is move-to's `block` goal,
 * a stand from which the block can be reached whatever the height. Run 17 was told "too far" three times by withdraw-from-furnace,
 * once standing 14 blocks under the furnace after a move in XZ that said it had arrived.
 */
export async function approachFurnace(bot: { entity: { position: Vec3 } }, pos: Vec3,
  move: (x: number, y: number, z: number, range: number, goalType: string) => Promise<SkillResult>): Promise<SkillResult | null> {
  const distance = () => bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5));
  if (distance() <= FURNACE_REACH) return null;
  const before = distance();
  let moved: SkillResult;
  try { moved = await move(pos.x, pos.y, pos.z, STAND_REACH, 'block'); }
  catch (error: any) { moved = { success: false, result: String(error?.message ?? error) }; }
  if (distance() <= FURNACE_REACH) return null;
  return { success: false, failureType: moved.failureType ?? 'distance_too_far', recoverable: true,
    result: `かまど(${pos.x}, ${pos.y}, ${pos.z})に届く所まで近づけませんでした（距離 ${before.toFixed(1)}m → ${distance().toFixed(1)}m）: ${String(moved.result ?? '').slice(0, 160)}` };
}
