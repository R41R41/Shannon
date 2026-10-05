import pathfinder from 'mineflayer-pathfinder';

const { goals } = pathfinder;

export interface RouteEstimate {
  /** The navigator found a whole route within its thinking time. */
  reachable: boolean;
  /** The navigator's own cost of that route (walking, swimming, digging and placing all counted). */
  cost: number;
}

interface RoutingBot {
  entity?: { position: unknown };
  pathfinder?: { movements?: unknown;
    getPathFromTo?(movements: unknown, start: unknown, goal: unknown, options?: { timeout?: number; tickTimeout?: number }):
      Iterator<{ result?: { status?: string; cost?: number } }> };
}

/**
 * How far a place really is for this body, asked of the navigator that will
 * walk it. Straight-line distance says a ledge above a cliff is close; the
 * route says it is not. Uses the movement settings currently in force, so
 * the answer matches what a move started now would do. The search blocks for
 * at most the given time; null when there is no navigator to ask.
 */
export function estimateRoute(bot: RoutingBot, x: number, y: number, z: number, range: number, timeoutMs = 250): RouteEstimate | null {
  const navigator = bot.pathfinder;
  if (!navigator?.getPathFromTo || !navigator.movements || !bot.entity) return null;
  try {
    // One uninterrupted think of the given length: the navigator's default hands back a part-finished
    // search after one tick's worth (40ms), which says nothing about whether the place can be reached.
    const result = navigator.getPathFromTo(navigator.movements, bot.entity.position, new goals.GoalNear(x, y, z, range),
      { timeout: timeoutMs, tickTimeout: timeoutMs }).next().value?.result;
    if (!result || !Number.isFinite(result.cost)) return null;
    return { reachable: result.status === 'success', cost: Number(result.cost) };
  } catch {
    return null;
  }
}

/**
 * Order places by the route to them: reachable ones by the navigator's cost,
 * then the rest in the order given. The thinking is spread over turns of the
 * event loop so the body keeps ticking between estimates, and stops at the
 * first place that is good enough.
 */
export async function rankByRoute<T extends { x: number; y: number; z: number }>(bot: RoutingBot, sites: T[],
  options: { range?: number; timeoutMs?: number;
    /** Stop asking once a place this good has been found: the places are given in the caller's order of preference. */
    goodEnough?: (site: T, route: RouteEstimate) => boolean } = {}): Promise<Array<T & { route: RouteEstimate | null }>> {
  const ranked: Array<T & { route: RouteEstimate | null; order: number }> = [];
  let settled = false;
  for (const [order, site] of sites.entries()) {
    const route = settled ? null : estimateRoute(bot, site.x, site.y, site.z, options.range ?? 1.2, options.timeoutMs);
    ranked.push({ ...site, route, order });
    if (route?.reachable && options.goodEnough?.(site, route)) settled = true;
    if (!settled) await new Promise<void>(resolve => setImmediate(resolve));
  }
  ranked.sort((a, b) => Number(b.route?.reachable === true) - Number(a.route?.reachable === true)
    || (a.route?.reachable && b.route?.reachable ? a.route.cost - b.route.cost : 0) || a.order - b.order);
  return ranked.map(({ order: _order, ...site }) => site as unknown as T & { route: RouteEstimate | null });
}
