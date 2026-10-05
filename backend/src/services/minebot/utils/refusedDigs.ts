import type { Vec3 } from 'vec3';

/**
 * The blocks a dig rule has refused, kept for the route planner.
 *
 * The rules that refuse a dig (lava behind the block, a hostile the block shuts out) throw from the dig
 * itself. The path executor takes a failed dig as "plan again", plans the same route, and asks for the same
 * dig: ten times a second for as long as the move is allowed to run. A tunnel towards diamonds stood before
 * one block of stone with a skeleton behind it for 65 seconds, 872 refusals, until the action timed out
 * (paid run L78). A block refused is closed to routes for a while: the planner goes round it, or finds no
 * route and the move ends with the reason at once.
 */
interface RefusalBody { refusedDigs?: Map<string, number> }
type Point = { x: number; y: number; z: number };

const key = (position: Point) => `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;

/** `forMs`: how long the refusal is taken to hold (lava stays where it is; a mob moves on). */
export function noteRefusedDig(bot: unknown, position: Point | Vec3, forMs: number, now = Date.now()): void {
  const body = bot as RefusalBody;
  const refused = body.refusedDigs ??= new Map();
  refused.set(key(position), now + forMs);
  if (refused.size > 256) for (const [cell, until] of refused) if (until <= now) refused.delete(cell);
}

export function digRefusedAt(bot: unknown, position: Point | Vec3, now = Date.now()): boolean {
  const refused = (bot as RefusalBody).refusedDigs;
  const until = refused?.get(key(position));
  if (until === undefined) return false;
  if (until > now) return true;
  refused!.delete(key(position));
  return false;
}

/** For the navigator: a block a dig rule has just refused costs more than any route may. */
export function refusedDigBreakCost(bot: unknown): (block: { position?: Point }) => number {
  return block => block?.position && digRefusedAt(bot, block.position) ? 100 : 0;
}
