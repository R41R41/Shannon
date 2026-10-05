import { Vec3 } from 'vec3';

/**
 * Where the head really is. The server does not keep a player standing where
 * a standing body does not fit: under a low ceiling it holds the body
 * crouched (1.5 high, eyes at 1.27), and lower still, flat (0.6 high, eyes at
 * 0.4). The client library models one standing body, 1.8 high with eyes at
 * 1.62, whatever the room. In a water pocket two blocks deep under a dirt
 * ceiling the client therefore placed its eyes inside the dirt ("not in
 * water"), wiped its way back to the last breath on every tick, and judged
 * the body buried, while on the server the crouched head was under water
 * and the air ran out (paid run L38, drowned 1.5 m from the hole it fell
 * through).
 *
 * Solid cells are taken as full blocks: enough to tell a ceiling from none.
 */
export const BODY_POSES = [
  { name: 'standing', height: 1.8, eye: 1.62 },
  { name: 'crouching', height: 1.5, eye: 1.27 },
  { name: 'flat', height: 0.6, eye: 0.4 },
] as const;
export type BodyPose = typeof BODY_POSES[number];

const HALF_WIDTH = 0.3;
const EDGE = 1e-4;

interface PoseBot { entity?: { position: Vec3 }; blockAt?(position: Vec3, extraInfos?: boolean): { boundingBox?: string } | null }

function fits(bot: PoseBot, position: Vec3, height: number): boolean {
  for (let x = Math.floor(position.x - HALF_WIDTH + EDGE); x <= Math.floor(position.x + HALF_WIDTH - EDGE); x++)
    for (let z = Math.floor(position.z - HALF_WIDTH + EDGE); z <= Math.floor(position.z + HALF_WIDTH - EDGE); z++)
      // The cell the feet are in is where the body stands, whatever it is: only what is above can crowd the head.
      for (let y = Math.floor(position.y + EDGE) + 1; y <= Math.floor(position.y + height - EDGE); y++)
        if (bot.blockAt!(new Vec3(x, y, z), false)?.boundingBox === 'block') return false;
  return true;
}

/** The pose the server holds the body in where it is now: the tallest that fits, flat when nothing does. */
export function bodyPose(bot: PoseBot): BodyPose {
  const position = bot.entity?.position;
  if (!position || typeof bot.blockAt !== 'function') return BODY_POSES[0];
  try { return BODY_POSES.find(pose => fits(bot, position, pose.height)) ?? BODY_POSES[2]; } catch { return BODY_POSES[0]; }
}

export function eyeHeight(bot: PoseBot): number { return bodyPose(bot).eye; }

/**
 * Height above the feet at which a solid block means the body is buried: the cell right over the one
 * the feet are in. With that cell filled the body cannot even crouch (sand or gravel has come down on
 * it). A block higher up is only a low ceiling, under which the server crouches the body and it is free.
 */
export const BURIED_AT = 1.1;

/** The cell the eyes are in. */
export function eyeCell(bot: PoseBot): Vec3 | null {
  const position = bot.entity?.position;
  return position ? new Vec3(Math.floor(position.x), Math.floor(position.y + eyeHeight(bot)), Math.floor(position.z)) : null;
}
