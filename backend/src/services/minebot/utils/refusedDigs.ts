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
interface RefusalBody { refusedDigs?: Map<string, number>; refusedThreats?: Map<string, { id: number | undefined; x: number; y: number; z: number }>; entities?: Record<string, { position?: Point } | undefined> }
/** A refusal for a hostile that a dig would let in holds as long as that hostile has not moved this far (m) from where it was when the dig was refused, or gone. */
export const REFUSED_THREAT_MOVED_M = 3;
/** How long a refusal for a hostile holds at the most (the hostile that stays put is not forgotten after a quarter of a minute: run 46, a route drawn at the same walls again and again). */
export const REFUSED_THREAT_MS = 90_000;
type Point = { x: number; y: number; z: number };

const key = (position: Point) => `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;

/** `forMs`: how long the refusal is taken to hold (lava stays where it is; a mob moves on). */
export function noteRefusedDig(bot: unknown, position: Point | Vec3, forMs: number, now = Date.now(), threat?: { id?: number; position: Point }): void {
  const body = bot as RefusalBody;
  const refused = body.refusedDigs ??= new Map();
  refused.set(key(position), now + forMs);
  const threats = body.refusedThreats ??= new Map();
  if (threat?.position) threats.set(key(position), { id: threat.id, x: threat.position.x, y: threat.position.y, z: threat.position.z });
  else threats.delete(key(position));
  if (refused.size > 256) for (const [cell, until] of refused) if (until <= now) { refused.delete(cell); threats.delete(cell); }
}
/** Whether the hostile a dig was refused for is still where it was (same place within REFUSED_THREAT_MOVED_M): if it has moved on or is gone, the refusal ends with it. */
function threatStillThere(body: RefusalBody, threat: { id: number | undefined; x: number; y: number; z: number }): boolean {
  if (threat.id === undefined) return true;
  const entity = body.entities?.[threat.id];
  const at = entity?.position;
  if (!at) return false;
  return Math.hypot(at.x - threat.x, at.y - threat.y, at.z - threat.z) <= REFUSED_THREAT_MOVED_M;
}

export function digRefusedAt(bot: unknown, position: Point | Vec3, now = Date.now()): boolean {
  const refused = (bot as RefusalBody).refusedDigs;
  const until = refused?.get(key(position));
  if (until === undefined) return false;
  if (until > now) {
    const body = bot as RefusalBody, threat = body.refusedThreats?.get(key(position));
    if (!threat || threatStillThere(body, threat)) return true;
    refused!.delete(key(position)); body.refusedThreats!.delete(key(position));
    return false;
  }
  refused!.delete(key(position));
  (bot as RefusalBody).refusedThreats?.delete(key(position));
  return false;
}

/** For the navigator: a block a dig rule has just refused costs more than any route may. */
export function refusedDigBreakCost(bot: unknown): (block: { position?: Point }) => number {
  return block => block?.position && digRefusedAt(bot, block.position) ? 100 : 0;
}
