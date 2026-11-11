/**
 * What the route plan (utils/routePlan) is given from a live body.
 *
 * Run 7: the body can read how many blocks a way would need before it moves, and `probe kind=route` says so. go walks the plan (utils/routeFollow, primitives/go: goPlanned) only when
 * the walk of its own route search stops (search_timeout, limit_dig, dead_end) or the plan digs clearly fewer; mine's approach to an ore goes by go. Nothing here digs or lays,
 * and nothing here changes a limit or a permission: go gives the plan its own canDig, canPlace, maxDig and maxPlace.
 */
import { bodyReader, feetCell, type Cell } from './localMap.js';
import { planRoute, type RouteOptions, type RoutePlan } from './routePlan.js';

/** The blocks go lays when its hand names none (vertical's DEFAULT_FOOTING), so the plan and the walk count the same blocks. */
const LAID_BY_DEFAULT = ['cobblestone', 'cobbled_deepslate', 'dirt'] as const;

const held = (bot: any): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const item of (bot.inventory?.items?.() ?? []) as Array<{ name: string; count: number }>) counts.set(item.name, (counts.get(item.name) ?? 0) + Number(item.count ?? 0));
  return counts;
};

/** How many blocks the pack can lay the way go lays them by default. */
export function placeBlocksHeld(bot: any): number {
  const counts = held(bot);
  let total = 0;
  for (const name of LAID_BY_DEFAULT) total += counts.get(name) ?? 0;
  return total;
}

/** Seconds a block takes by hand (an estimate for a pack with no pickaxe: a stone is 7.5 s bare-handed, an ore twice that). */
function handSeconds(name: string): number {
  if (/^(?:dirt|grass_block|coarse_dirt|podzol|mycelium|rooted_dirt|mud|clay|sand|red_sand|gravel|soul_sand|soul_soil|snow|snow_block)$/u.test(name)) return 0.9;
  if (/_log$|_wood$|_planks$|_fence$/u.test(name)) return 3;
  if (/_ore$|^ancient_debris$/u.test(name)) return 15;
  if (/deepslate/u.test(name)) return 11;
  return 7.5;
}

/** The options planRoute is given by a body: what it can lay, how long a block takes with its tools, and where a village lies. */
export function routeOptionsOf(bot: any, extra: RouteOptions = {}): RouteOptions {
  const items = (bot.inventory?.items?.() ?? []) as Array<{ name: string }>;
  const hasPick = items.some(item => /_pickaxe$/u.test(item.name));
  const villagers = Object.values(bot.entities ?? {}).filter((entity: any) => entity?.name === 'villager' && entity.position) as any[];
  return {
    placeBlocks: placeBlocksHeld(bot),
    ...(hasPick ? {} : { digSeconds: handSeconds }),
    ...(villagers.length ? { villageNear: (x: number, y: number, z: number) => villagers.some(entity => Math.hypot(entity.position.x - x, entity.position.y - y, entity.position.z - z) <= 40) } : {}),
    ...extra,
  };
}

/** The plan for a body at its feet to the goals, or null when it cannot be made (no body, a thrown read). Never throws. */
export function planFromBody(bot: any, goals: Cell[], extra: RouteOptions = {}): RoutePlan | null {
  try {
    const feet = feetCell(bot);
    if (!feet || !goals.length) return null;
    return planRoute(bodyReader(bot), feet, goals, routeOptionsOf(bot, extra));
  } catch { return null; }
}
