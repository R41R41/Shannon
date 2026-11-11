/**
 * What the route plan (utils/routePlan) is given from a live body, and what a hand that left its limits out gets from the plan.
 *
 * Run 7 (Lai: "集める原木が足りない…最低限の量とこれだけあれば安心という量を両方" — the same for the dig count): the body knows how many blocks a way needs, the head has to guess, and
 * it guessed 16 or 30 for a way that needed 33 (the same coal three times). A hand that gives no maxDig / maxPlace gets the plan's numbers (never under what it had); a hand that
 * gives one the plan cannot keep is told before the body moves, with the number the way needs. The plan is the body's reading only: nothing here digs or lays.
 */
import type { CustomBot } from '../types/CustomBot.js';
import { bodyReader, feetCell, type Cell } from './localMap.js';
import { planRoute, DEFAULT_CEILING, type RouteOptions, type RoutePlan } from './routePlan.js';

/** Whole blocks cheap to lay under the feet, in the order the body lays them (never ores, planks, a crafting block, nor a block that falls). */
const FOOTING = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone', 'basalt', 'sandstone', 'terracotta', 'end_stone'] as const;
/** The three the planner's `canPlace` gets when it names none (vertical's DEFAULT_FOOTING). */
export const DEFAULT_FOOTING_NAMES = ['cobblestone', 'cobbled_deepslate', 'dirt'] as const;

const held = (bot: any): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const item of (bot.inventory?.items?.() ?? []) as Array<{ name: string; count: number }>) counts.set(item.name, (counts.get(item.name) ?? 0) + Number(item.count ?? 0));
  return counts;
};

/** How many cheap whole blocks the pack can lay. */
export function placeBlocksHeld(bot: any): number {
  const counts = held(bot);
  let total = 0;
  for (const name of FOOTING) total += counts.get(name) ?? 0;
  return total;
}

/** The default footing the pack holds, as `canPlace` names (a hand that names none lays these). Empty when the pack holds none. */
export function footingHeld(bot: any): string[] {
  const counts = held(bot);
  return DEFAULT_FOOTING_NAMES.filter(name => (counts.get(name) ?? 0) > 0).map(String);
}

/** Seconds a block takes by hand: the pack holds no pickaxe (a stone is 7.5 s bare-handed, an ore twice that). */
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

/** The plan for a body at its feet to the goals, or null when it cannot be made (no body, a goal too far to plan in one go, a thrown read). Never throws. */
export function planFromBody(bot: any, goals: Cell[], extra: RouteOptions = {}): RoutePlan | null {
  try {
    const feet = feetCell(bot);
    if (!feet || !goals.length) return null;
    return planRoute(bodyReader(bot), feet, goals, routeOptionsOf(bot, extra));
  } catch { return null; }
}

/** How far a goal may be (straight, m) for a plan to be made before a hand moves: beyond it the walk goes in legs and each leg is planned in its turn. */
export const PLAN_BEFORE_M = 80;

export interface GoBudget {
  maxDig: number;
  maxPlace: number;
  /** Set when the plan digs or lays more than the hand's limit says: the stop's words, before the body moves. */
  over?: { code: 'limit_dig' | 'limit_place'; text: string; needed: number };
  plan: RoutePlan;
}

/**
 * The limits for a go. A limit the hand gave is kept as it is; one it left out is the plan's number with a fifth over and two (never under `floor`, what it was before), at
 * most DEFAULT_CEILING. A plan of status `over` says its blocks needed against the hand's limit.
 */
export function budgetOf(plan: RoutePlan, asked: { maxDig?: number; maxPlace?: number }, floor: { maxDig: number; maxPlace: number }): GoBudget {
  const grown = (needed: number, least: number) => Math.max(least, Math.min(DEFAULT_CEILING, Math.ceil(needed * 1.2) + 2));
  const ok = plan.status === 'success' || plan.status === 'over';
  const maxDig = asked.maxDig ?? (ok ? grown(plan.over?.needed ?? plan.totals.dig, floor.maxDig) : floor.maxDig);
  const maxPlace = asked.maxPlace ?? (ok ? grown(plan.totals.place, floor.maxPlace) : floor.maxPlace);
  const result: GoBudget = { maxDig, maxPlace, plan };
  // Short: the stop's line is 160 characters and its hint is what is cut first; probe kind=route says the rest.
  const shaft = plan.over?.shaft ? `。縦穴なら約 ${plan.over.shaft.dig}` : '';
  const dig = plan.status === 'over' && plan.over ? plan.over.needed : plan.totals.dig;
  if (asked.maxDig !== undefined && dig > asked.maxDig && (plan.status === 'over' || plan.status === 'success')) {
    result.over = { code: 'limit_dig', needed: dig, text: `この道は掘る所が ${dig} あり、上限 ${asked.maxDig} を超える（動く前の見積り${shaft}）` };
  } else if (plan.status === 'success' && asked.maxPlace !== undefined && plan.totals.place > asked.maxPlace) {
    result.over = { code: 'limit_place', needed: plan.totals.place, text: `この道は置く所が ${plan.totals.place} あり、上限 ${asked.maxPlace} を超える（動く前の見積り）` };
  }
  return result;
}

/**
 * go's use of the plan, in one call: the budget for a go from where the body stands to `goals` (null: no plan was made, the go keeps its defaults and its route search).
 * `placeBlocks` is what the hand's canPlace lets it lay (held blocks only), `diggable` what its canDig lets it cut. A limit the hand set to 0 is not read as a ceiling to
 * check (it means "no digging", which the route search already says in its own words).
 */
export function goBudgetFor(bot: any, goals: Cell[], input: { range: number; maxDrop: number; waterOk: boolean; asked: { maxDig?: number; maxPlace?: number };
  diggable: (name: string) => boolean; placeBlocks: number; floor: { maxDig: number; maxPlace: number } }): GoBudget | null {
  const feet = feetCell(bot);
  if (!feet || !goals.length) return null;
  if (Math.min(...goals.map(goal => Math.hypot(goal.x - feet.x, goal.y - feet.y, goal.z - feet.z))) > PLAN_BEFORE_M) return null;
  const ceiling = input.asked.maxDig !== undefined && input.asked.maxDig > 0 ? input.asked.maxDig : undefined;
  const plan = planFromBody(bot, goals, { range: input.range, maxDrop: input.maxDrop, waterOk: input.waterOk, diggable: input.asked.maxDig === 0 ? () => false : input.diggable, placeBlocks: input.asked.maxPlace === 0 ? 0 : input.placeBlocks, ms: 150,
    ...(ceiling !== undefined ? { maxDig: ceiling } : {}) });
  if (!plan) return null;
  const budget = budgetOf(plan, { maxDig: input.asked.maxDig, maxPlace: input.asked.maxPlace }, input.floor);
  if (input.asked.maxPlace === 0 && budget.over?.code === 'limit_place') budget.over = undefined;
  if (input.asked.maxDig === 0 && budget.over?.code === 'limit_dig') budget.over = undefined;
  return budget;
}

/**
 * The blocks a mine's way to a cell needs, grown by a fifth and two (at most DEFAULT_CEILING), or null when no way is planned (a hand that gave no maxDig is given this
 * instead of a fixed 16: run 7, the same coal asked for with 16, 30 and 30 while the way needed 33).
 */
export function roadNeeded(bot: any, goals: Cell[], diggable: (name: string) => boolean, placeBlocks = 0): number | null {
  const plan = planFromBody(bot, goals, { diggable, placeBlocks, ms: 150 });
  if (!plan || (plan.status !== 'success' && plan.status !== 'over')) return null;
  const needed = plan.over?.needed ?? plan.totals.dig;
  return Math.min(DEFAULT_CEILING, Math.ceil(needed * 1.2) + 2);
}
