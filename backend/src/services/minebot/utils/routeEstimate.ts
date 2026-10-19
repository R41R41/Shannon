import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

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

/** What the server's answer to a dig adds to the block's own time (the start, the confirmation, the step into the gap). */
const DIG_OVERHEAD_MS = 250;
/** The straight line is read at most this far: a walk is cut to the action's time well before it would matter. */
const TUNNEL_SCAN_LIMIT = 96;

interface TunnelBot {
  blockAt?(position: any): { name?: string; boundingBox?: string; diggable?: boolean; harvestTools?: Record<string, boolean> | null;
    digTime?(type: number | null, creative: boolean, inWater: boolean, notOnGround: boolean, enchants: unknown[], effects: unknown): number } | null;
  inventory?: { items(): Array<{ type: number; name: string; maxDurability?: number }> };
  entity?: { effects?: unknown };
}

/**
 * The time the digging of a walk takes, by the straight line: every whole block in the two cells a body fills along it, at the
 * time of the tool the route would choose for it (`chooseTool`: the cheapest in time and wear, the stone pickaxe on stone even with
 * an iron one in the bag). A walk to diamonds 37 m off through rock was given the 30 s that walking it takes, ran out with most of
 * the tunnel to dig, and was taken for a place that could not be reached; the next call started a new stair elsewhere (run 16).
 */
export function tunnelDigMs(bot: TunnelBot, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number },
  choose: (block: any, items: any[], effects: unknown) => { type: number } | null): number {
  if (typeof bot.blockAt !== 'function') return 0;
  const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  // A block a metre along the line, for the first TUNNEL_SCAN_LIMIT metres only.
  const steps = Math.ceil(distance);
  const items = (() => { try { return bot.inventory?.items() ?? []; } catch { return []; } })();
  const seen = new Set<string>();
  let total = 0;
  for (let i = 1; i <= Math.min(steps, TUNNEL_SCAN_LIMIT); i++) {
    const t = i / steps;
    const x = Math.floor(from.x + (to.x - from.x) * t), y = Math.floor(from.y + (to.y - from.y) * t), z = Math.floor(from.z + (to.z - from.z) * t);
    for (const dy of [0, 1]) {
      const key = `${x},${y + dy},${z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let block: ReturnType<NonNullable<TunnelBot['blockAt']>> = null;
      try { block = bot.blockAt(new Vec3(x, y + dy, z)) ?? null; } catch { block = null; }
      if (!block || block.boundingBox !== 'block' || block.diggable === false || typeof block.digTime !== 'function') continue;
      let ms = 0;
      try {
        const tool = choose(block, items, bot.entity?.effects ?? {});
        ms = Number(block.digTime(tool ? tool.type : null, false, false, false, [], bot.entity?.effects ?? {}));
      } catch { ms = 0; }
      if (Number.isFinite(ms) && ms > 0) total += ms + DIG_OVERHEAD_MS;
    }
  }
  return total;
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
