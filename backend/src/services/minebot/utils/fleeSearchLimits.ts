/**
 * Bounds on the work a flee may ask of the event loop (run 21: the body's event loop froze four times, 1.0 to 4.4 s and once a 12.9 s gap
 * between physics ticks, every time inside flee-from; one of them with 984 chunk loads and a body that had moved 2 m).
 *
 * The flee's route search allows towers and bridges (when nothing is near enough to arrive while the body stands still), asks for a point 8
 * to 24 blocks off that is often inside rock in a cave, and left mineflayer-pathfinder's defaults alone: no search radius, a five-second
 * think time, 40 ms of search in every physics tick. A goal with no way to it made the search walk the whole loaded cave system, and a
 * body that is being chased spent four fifths of every tick in it. A flee is a short run: a route that needs more than this is no escape.
 * The limits are taken for the length of the skill and put back as they were, since the other movers (move-to, mining) want the defaults.
 */

/** How long one path search may think before it hands back the best partial route (the library's default is 5000). */
export const FLEE_THINK_TIMEOUT_MS = 600;
/** How long the search works in one physics tick (the library's default is 40; a tick is 50 ms). */
export const FLEE_TICK_TIMEOUT_MS = 25;
/** How much dearer than the straight line a route may be before the search drops it (cost units, about blocks); the library's default is no limit. */
export const FLEE_SEARCH_RADIUS = 24;
/** A scan that loops over many blocks or mobs gives the event loop back when a slice of work has run this long. */
export const FLEE_SLICE_MS = 8;

type PathfinderLimits = { thinkTimeout?: number; tickTimeout?: number; searchRadius?: number };

/** Off by switch (MINEBOT_FLEE_SEARCH_LIMIT=off): the flee searches with the library's own limits, as before run 21. */
export function fleeSearchLimitsEnabled(): boolean {
  return String(process.env.MINEBOT_FLEE_SEARCH_LIMIT ?? '').toLowerCase() !== 'off';
}

/**
 * Sets the flee's search limits on the body's pathfinder and returns the function that puts back what was there. A limit another
 * controller has changed since is left alone.
 */
export function applyFleeSearchLimits(bot: { pathfinder?: unknown }): () => void {
  const pathfinder = bot.pathfinder as PathfinderLimits | undefined;
  if (!pathfinder || !fleeSearchLimitsEnabled()) return () => undefined;
  const wanted: Required<PathfinderLimits> = { thinkTimeout: FLEE_THINK_TIMEOUT_MS, tickTimeout: FLEE_TICK_TIMEOUT_MS, searchRadius: FLEE_SEARCH_RADIUS };
  const before: PathfinderLimits = {};
  const keys = Object.keys(wanted) as Array<keyof PathfinderLimits>;
  for (const key of keys) {
    before[key] = pathfinder[key];
    // Never loosen a limit someone already made tighter (thinkTimeout, tickTimeout); a radius of -1 means "none".
    const current = pathfinder[key];
    const tighter = key === 'searchRadius' ? typeof current === 'number' && current >= 0 && current < wanted[key] : typeof current === 'number' && current < wanted[key];
    if (!tighter) pathfinder[key] = wanted[key];
  }
  return () => {
    for (const key of keys) {
      if (pathfinder[key] !== wanted[key]) continue;
      if (before[key] === undefined) delete pathfinder[key]; else pathfinder[key] = before[key];
    }
  };
}

/** A turn of the event loop (other timers, the network and the physics tick run in it). */
export const yieldToEventLoop = (): Promise<void> => new Promise<void>(resolve => {
  if (typeof setImmediate === 'function') setImmediate(resolve); else setTimeout(resolve, 0);
});

/**
 * `items.filter(test)`, with the event loop given back whenever a slice of the work has run FLEE_SLICE_MS: the test may be a line-of-sight
 * ray and a flood fill over the cave (threatExposure), a few milliseconds each and a few dozen mobs. Nothing is yielded while the work is
 * quick, so a caller with nothing to scan does not wait on a timer.
 */
export async function filterSliced<T>(items: readonly T[], test: (item: T) => boolean, sliceMs = FLEE_SLICE_MS): Promise<T[]> {
  const kept: T[] = [];
  let sliceStart = performance.now();
  for (const item of items) {
    if (test(item)) kept.push(item);
    if (performance.now() - sliceStart > sliceMs) { await yieldToEventLoop(); sliceStart = performance.now(); }
  }
  return kept;
}
