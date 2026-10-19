import { nativeActionHost } from '../execution/ActionExecution.js';

/**
 * Blocks the approach failed to reach, per body. A paid run asked for the same two cliff-top logs again and again; each call re-picked
 * the nearest ones and timed out. They go to the back of the list for a while, not out of it.
 *
 * Kept on the body itself, not on the handle a skill is given for one call: that handle is made anew for every command under common
 * FCA, and the memory kept on it was gone by the next call. Run 18 walked to the iron ore at (58, 57, 16) three times (D19, D22, D44)
 * and was told "no path" each time, some 80 s.
 */
const UNREACHABLE_MEMORY_MS = 10 * 60_000;
const unreachable = new WeakMap<object, Map<string, number>>();

type Point = { x: number; y: number; z: number };
export const targetKey = (position: Point) => `${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`;

/** The positions (by targetKey) found unreachable within the last ten minutes, and when. */
export function recentlyUnreachable(bot: object, now = Date.now()): Map<string, number> {
  const host = nativeActionHost(bot);
  let memory = unreachable.get(host);
  if (!memory) { memory = new Map(); unreachable.set(host, memory); }
  for (const [key, at] of memory) if (now - at > UNREACHABLE_MEMORY_MS) memory.delete(key);
  return memory;
}

/** `forMs`: how long it is held (a mob in the way moves on; a cliff stays). At most the ten minutes. */
export function noteUnreachable(bot: object, position: Point, now = Date.now(), forMs = UNREACHABLE_MEMORY_MS): void {
  recentlyUnreachable(bot, now).set(targetKey(position), now - (UNREACHABLE_MEMORY_MS - Math.min(forMs, UNREACHABLE_MEMORY_MS)));
}

/** A dig refused for the hostile it would let in is held this long: the mob moves on. */
export const THREAT_REFUSAL_MS = 60_000;

export function wasUnreachable(bot: object, position: Point, now = Date.now()): boolean {
  return recentlyUnreachable(bot, now).has(targetKey(position));
}
