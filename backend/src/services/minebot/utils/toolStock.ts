/**
 * Keeping a cheap tool for the routine digging. The wear-aware choice (utils/toolChoice) spends the cheap
 * pickaxes first, but once the last of them broke, the only tool left that could break stone was the iron one,
 * and every block of a tunnel went to it: crafted at 00:51:29, broken at 01:05:34, while the body carried 29
 * iron ingots, some 400 cobblestone, sticks and planks and never made a stone pickaxe again (paid run L111; the
 * iron pickaxe of L109 went the same way in 21 minutes).
 *
 * So before an action spends a tool on blocks a cheaper tool could also break and harvest, the body makes that
 * cheaper tool, if it can right now from what it carries (any recipe the registry knows, with the sticks,
 * planks and crafting table on the way). "Cheaper" and "adequate" come from the cost model (time plus the worth
 * of one point of wear) and the block's own harvest tools, not from a list of items. Once per action at most,
 * never in an emergency or a fight, never with materials missing (that is only said).
 */
import { isLlmCentric } from './llmCentric.js';
import { Vec3 } from 'vec3';
import { currentAction, nativeActionHost } from '../execution/ActionExecution.js';
import { isEngaged } from './engagement.js';
import { pickaxeAllowance } from './inventoryTidy.js';
import { canHarvest, chooseTool, NEARLY_BROKEN_USES, toolCost, usesLeft, wearCostSeconds, type BlockLike, type ToolLike } from './toolChoice.js';

type Cell = number | null | undefined | { id?: number } | Cell[];
interface RawRecipe { inShape?: Cell[][]; ingredients?: Cell[]; result: { id: number; count?: number } | number }
interface ItemDef { id: number; name: string; maxDurability?: number }
export interface StockRegistry {
  items: Record<number, ItemDef | undefined>;
  itemsByName: Record<string, ItemDef | undefined>;
  recipes?: Record<number, RawRecipe[] | undefined>;
}
export interface CarriedItem extends ToolLike { count: number }

interface Recipe { needs: Map<number, number>; out: number; table: boolean }

const recipeCache = new WeakMap<object, Map<number, Recipe[]>>();
function cellId(cell: Cell): number | null {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'number') return cell >= 0 ? cell : null;
  if (Array.isArray(cell)) return cell.length ? cellId(cell[0]) : null;
  return typeof cell.id === 'number' && cell.id >= 0 ? cell.id : null;
}
function recipesOf(registry: StockRegistry, id: number): Recipe[] {
  let byId = recipeCache.get(registry);
  if (!byId) { byId = new Map(); recipeCache.set(registry, byId); }
  const cached = byId.get(id);
  if (cached) return cached;
  const parsed: Recipe[] = [];
  for (const raw of registry.recipes?.[id] ?? []) {
    const needs = new Map<number, number>();
    const cells = raw.inShape ? raw.inShape.flat() : raw.ingredients ?? [];
    for (const cell of cells) {
      const need = cellId(cell);
      if (need !== null) needs.set(need, (needs.get(need) ?? 0) + 1);
    }
    const shapeTooBig = !!raw.inShape && (raw.inShape.length > 2 || raw.inShape.some(row => row.length > 2));
    const table = shapeTooBig || [...needs.values()].reduce((sum, n) => sum + n, 0) > 4;
    const out = typeof raw.result === 'number' ? 1 : Math.max(1, Number(raw.result?.count ?? 1));
    if (needs.size) parsed.push({ needs, out, table });
  }
  byId.set(id, parsed);
  return parsed;
}

export interface CraftStep { item: string; count: number }
export interface CraftPlan {
  item: string;
  /** In order, each a craft-one call: the item and how many of it are wanted. */
  steps: CraftStep[];
  /** What the plan takes from the carried materials (the crafting table aside). */
  uses: Array<[string, number]>;
  /** Where the crafting table comes from, when the recipe needs one. */
  table: 'near' | 'carried' | 'made' | null;
}
/** shortfall: how many items short of the nearest recipe the bag is (the smaller, the nearer to being made). */
export type CraftOutcome = { plan: CraftPlan } | { missing: string; shortfall?: number };

/** Intermediates made on the way (sticks, planks, a table) are at most this deep, and a plan this many crafts. */
const MAX_DEPTH = 2;
const MAX_STEPS = 5;

interface Sim { inv: Map<number, number>; table: boolean; tableFrom: CraftPlan['table']; usedTable: boolean; steps: CraftStep[] }
const cloneSim = (sim: Sim): Sim => ({ ...sim, inv: new Map(sim.inv), steps: [...sim.steps] });
const take = (inv: Map<number, number>, id: number, n: number) => inv.set(id, (inv.get(id) ?? 0) - n);

function tryRecipe(registry: StockRegistry, id: number, count: number, recipe: Recipe, start: Sim, depth: number): { sim: Sim } | { missing: Map<number, number> } {
  const times = Math.ceil(count / recipe.out);
  let sim = cloneSim(start);
  const missing = new Map<number, number>();
  if (recipe.table) sim.usedTable = true;
  if (recipe.table && !sim.table) {
    const tableId = registry.itemsByName.crafting_table?.id;
    if (tableId === undefined) missing.set(-1, 1);
    else if ((sim.inv.get(tableId) ?? 0) > 0) { take(sim.inv, tableId, 1); sim.table = true; sim.tableFrom = 'carried'; }
    else {
      const made = make(registry, tableId, 1, sim, depth + 1);
      if ('sim' in made) { sim = made.sim; take(sim.inv, tableId, 1); sim.table = true; sim.tableFrom = 'made'; }
      else missing.set(tableId, 1);
    }
  }
  for (const [need, n] of recipe.needs) {
    const want = n * times;
    const have = sim.inv.get(need) ?? 0;
    if (have >= want) continue;
    const made = make(registry, need, want - have, sim, depth + 1);
    if ('sim' in made) sim = made.sim; else missing.set(need, want - have);
  }
  if (missing.size) return { missing };
  for (const [need, n] of recipe.needs) take(sim.inv, need, n * times);
  sim.inv.set(id, (sim.inv.get(id) ?? 0) + recipe.out * times);
  sim.steps.push({ item: registry.items[id]?.name ?? String(id), count });
  return { sim };
}

function make(registry: StockRegistry, id: number, count: number, start: Sim, depth: number): { sim: Sim } | { missing: Map<number, number> } {
  let best: Sim | null = null;
  let fewest: Map<number, number> | null = null;
  if (depth <= MAX_DEPTH) {
    for (const recipe of recipesOf(registry, id)) {
      const tried = tryRecipe(registry, id, count, recipe, start, depth);
      if ('sim' in tried) {
        if (tried.sim.steps.length <= MAX_STEPS && (!best || tried.sim.steps.length < best.steps.length)) best = tried.sim;
      } else if (!fewest || total(tried.missing) < total(fewest)) fewest = tried.missing;
    }
  }
  return best ? { sim: best } : { missing: fewest ?? new Map([[id, count]]) };
}
const total = (missing: Map<number, number>) => [...missing.values()].reduce((sum, n) => sum + n, 0);

function carriedCounts(items: Array<{ type: number; count: number }>): Map<number, number> {
  const inv = new Map<number, number>();
  for (const item of items) inv.set(item.type, (inv.get(item.type) ?? 0) + item.count);
  return inv;
}

function describeMissing(registry: StockRegistry, missing: Map<number, number>): string {
  return [...missing].map(([id, n]) => id < 0 ? '作業台' : `${registry.items[id]?.name ?? id}×${n}`).join('・');
}

/**
 * How to make one of the item from what is carried, by the registry's recipes: the crafts in order, what they
 * use, and where the crafting table comes from. Or, when it cannot be made, what is missing (the closest recipes).
 */
export function planCraft(registry: StockRegistry, items: Array<{ type: number; count: number }>, itemName: string, tableNear: boolean): CraftOutcome {
  const id = registry.itemsByName[itemName]?.id;
  if (id === undefined) return { missing: `${itemName}はこのバージョンにありません` };
  const start: Sim = { inv: carriedCounts(items), table: tableNear, tableFrom: tableNear ? 'near' : null, usedTable: false, steps: [] };
  const made = make(registry, id, 1, start, 0);
  if ('sim' in made) {
    const before = start.inv;
    const tableId = registry.itemsByName.crafting_table?.id;
    const uses: Array<[string, number]> = [];
    for (const [itemId, n] of before) {
      const left = made.sim.inv.get(itemId) ?? 0;
      if (left < n && itemId !== tableId) uses.push([registry.items[itemId]?.name ?? String(itemId), n - left]);
    }
    return { plan: { item: itemName, steps: made.sim.steps, uses, table: made.sim.usedTable ? made.sim.tableFrom : null } };
  }
  // What the closest recipes lack, one line each (three at most): "cobblestone×3 または blackstone×3".
  const shortages = recipesOf(registry, id).map(recipe => tryRecipe(registry, id, 1, recipe, start, 0))
    .filter((tried): tried is { missing: Map<number, number> } => 'missing' in tried).map(tried => tried.missing);
  if (!shortages.length) return { missing: `${itemName}のクラフトレシピがありません` };
  const least = Math.min(...shortages.map(total));
  const lines = [...new Set(shortages.filter(missing => total(missing) === least).map(missing => describeMissing(registry, missing)))];
  return { missing: lines.slice(0, 3).join(' または '), shortfall: least };
}

/** One line for a plan: "stone_pickaxe（cobblestone×3・stick×2を使う。作業台は所持品を置く）". */
export function describePlan(plan: CraftPlan): string {
  const made = plan.steps.slice(0, -1).map(step => step.item);
  const parts = [plan.uses.length ? `${plan.uses.map(([name, n]) => `${name}×${n}`).join('・')}を使う` : ''];
  if (made.length) parts.push(`先に${[...new Set(made)].join('・')}を作る`);
  if (plan.table === 'carried') parts.push('作業台は所持品を置く');
  return `${plan.item}（${parts.filter(Boolean).join('。')}）`;
}

export type RestockDecision =
  | { kind: 'make'; block: string; current: string; plan: CraftPlan; saving: number }
  | { kind: 'short'; block: string; current: string; wanted: string; missing: string };

/**
 * Tools never made or named as a cheaper stand-in: gold is quick but breaks after 32 blocks; copper needs its own ore dug and smelted,
 * which nothing on the way to the Nether asks for (run 23 named a copper pickaxe once gold was taken out).
 */
const NOT_A_STAND_IN = /^(golden|copper)_/;

/** Less than this saved per block (seconds of time and wear) is not worth a craft. */
const MIN_SAVING_S = 0.2;

/**
 * Whether digging these blocks would spend a tool that a cheaper one, makeable now, could stand in for. For
 * each block: the tool the dig would take (the cheapest carried that harvests it); the block's harvest tools of
 * a cheaper material that are not carried and would cost less per block; of those, the cheapest that can be made
 * from what is carried. Null when nothing is being spent that need not be.
 */
export function decideRestock(registry: StockRegistry, items: CarriedItem[], blocks: Array<BlockLike & { name: string }>,
  options: { tableNear: boolean; effects?: unknown }): RestockDecision | null {
  let short: RestockDecision | null = null;
  const carriedTypes = new Set(items.map(item => item.type));
  for (const block of blocks) {
    if (!block.harvestTools) continue;
    const current = chooseTool(block, items, { requireHarvest: true, effects: options.effects });
    const currentWear = wearCostSeconds(current);
    if (!current || currentWear <= 0) continue;
    const currentCost = toolCost(block, current, options.effects);
    const cheaper: Array<{ def: ItemDef; cost: number }> = [];
    for (const key of Object.keys(block.harvestTools)) {
      const def = registry.items[Number(key)];
      if (!def || !(Number(def.maxDurability) > 0) || carriedTypes.has(def.id)) continue;
      // Gold wears out after 32 uses: it is not a tool to make for digging, nor to point at (nothing on the way to the Nether needs it).
      if (NOT_A_STAND_IN.test(def.name)) continue;
      if (wearCostSeconds(def) >= currentWear) continue;
      const cost = toolCost(block, { type: def.id, name: def.name, maxDurability: def.maxDurability }, options.effects);
      if (cost <= currentCost - MIN_SAVING_S) cheaper.push({ def, cost });
    }
    cheaper.sort((a, b) => a.cost - b.cost);
    // The one nearest to being made is the one named when none can be (the cheapest in time is often the dearest to get: run 22 named a
    // golden pickaxe, three gold ingots away, on nearly every result, where a stone pickaxe was two sticks away).
    let nearest: { wanted: string; missing: string; shortfall: number } | null = null;
    for (const { def, cost } of cheaper) {
      const outcome = planCraft(registry, items, def.name, options.tableNear);
      if ('plan' in outcome) return { kind: 'make', block: block.name, current: current.name, plan: outcome.plan, saving: currentCost - cost };
      const shortfall = outcome.shortfall ?? Infinity;
      if (!nearest || shortfall < nearest.shortfall) nearest = { wanted: def.name, missing: outcome.missing, shortfall };
    }
    if (!short && nearest) short = { kind: 'short', block: block.name, current: current.name, wanted: nearest.wanted, missing: nearest.missing };
  }
  return short;
}

export type SkillCall = (skill: string, ...args: unknown[]) => Promise<{ success: boolean; result: string; failureType?: string }>;

interface StockBody {
  registry?: StockRegistry;
  entity?: { position?: { x: number; y: number; z: number; distanceTo?(other: unknown): number }; effects?: unknown };
  inventory?: { items(): CarriedItem[] };
  minebotControlState?: string;
  findBlocks?(options: { matching: number; maxDistance: number; count: number }): Array<{ x: number; y: number; z: number }>;
  blockAt?(position: unknown): (BlockLike & { name: string; boundingBox?: string; diggable?: boolean }) | null;
}

/** A crafting table this close is used where it stands (craft-one walks no further for it); otherwise one is put down. */
export const RESTOCK_TABLE_REACH = 4;
const restocked = new WeakSet<object>();
const shortagesSaid = new WeakMap<object, { text: string; at: number }>();
const SHORTAGE_REPEAT_MS = 90_000;
const notesByAction = new WeakMap<object, string[]>();

function tablesNear(bot: StockBody, reach: number): Array<{ x: number; y: number; z: number }> {
  const id = (bot.registry as unknown as { blocksByName?: Record<string, { id: number } | undefined> } | undefined)?.blocksByName?.crafting_table?.id;
  if (id === undefined || typeof bot.findBlocks !== 'function') return [];
  try { return bot.findBlocks({ matching: id, maxDistance: reach, count: 8 }); } catch { return []; }
}

function note(root: object, text: string): void {
  const list = notesByAction.get(root) ?? [];
  if (!list.includes(text)) list.push(text);
  notesByAction.set(root, list);
}

/** What the restock did or could not do in this action, for its result. Taken once. */
export function takeToolStockNotes(action: object | null | undefined): string[] {
  if (!action) return [];
  const list = notesByAction.get(action) ?? [];
  notesByAction.delete(action);
  return list;
}

/**
 * Before an action digs these blocks: if it would spend a dearer tool where a cheaper one, makeable now, would
 * do, make it (craft-one through `call`, then take back a crafting table it put down). Once per action; not in
 * an emergency, a fight or a reflex; nothing is crafted when materials are missing (the action's result says
 * so). Returns what was made, or null.
 */
export async function keepCheapTool(bot: StockBody, blocks: Array<BlockLike & { name: string }>, call: SkillCall): Promise<string | null> {
  // The LLM-centric body makes no tool by itself: what to make is the planner's (MINEBOT_LLM_CENTRIC).
  if (isLlmCentric(bot)) return null;
  const context = currentAction(bot) as unknown as { root?: object; priority?: number; safetyLease?: boolean } | undefined;
  if (!context || !blocks.length) return null;
  const root = context.root ?? context;
  const rank = root as { priority?: number; safetyLease?: boolean };
  // A task the planner called runs at rank 0; reflexes, escapes and fights above it are not the time to craft.
  if ((rank.priority ?? 0) !== 0 || rank.safetyLease) return null;
  const host = nativeActionHost(bot) as StockBody;
  if (String(host.minebotControlState ?? '').startsWith('emergency') || isEngaged(host)) return null;
  if (restocked.has(root)) return null;
  const registry = bot.registry;
  const items = bot.inventory?.items?.() ?? [];
  if (!registry?.recipes || !items.length) return null;
  const tablesBefore = tablesNear(bot, RESTOCK_TABLE_REACH + 2);
  const tableNear = tablesNear(bot, RESTOCK_TABLE_REACH).length > 0;
  const decision = decideRestock(registry, items, blocks, { tableNear, effects: bot.entity?.effects });
  if (!decision) return null;
  if (decision.kind === 'short') {
    // The same shortage is said once a minute and a half, not on every result of a long run (it was on nearly all of run 22's).
    const text = `道具の補充: ${decision.block}を${decision.current}で掘っています。より安く済む${decision.wanted}は材料が足りず作れません（不足: ${decision.missing}）。`;
    const said = shortagesSaid.get(host as object);
    if (!said || said.text !== text || Date.now() - said.at > SHORTAGE_REPEAT_MS) { shortagesSaid.set(host as object, { text, at: Date.now() }); note(root, text); }
    return null;
  }
  restocked.add(root);
  const { plan } = decision;
  for (const step of plan.steps) {
    const result = await call('craft-one', step.item, step.count, RESTOCK_TABLE_REACH);
    if (!result.success) {
      note(root, `道具の補充: ${decision.block}に${decision.current}を使わないよう${plan.item}を作ろうとしましたが、${step.item}のクラフトに失敗しました（${String(result.result).slice(0, 120)}）。`);
      return null;
    }
  }
  // A table put down for this is taken back: it would stand in the tunnel, and carried it saves planks next time.
  if (plan.table === 'carried' || plan.table === 'made') {
    const known = new Set(tablesBefore.map(p => `${p.x},${p.y},${p.z}`));
    const placed = tablesNear(bot, RESTOCK_TABLE_REACH + 2).find(p => !known.has(`${p.x},${p.y},${p.z}`));
    if (placed) {
      try { await call('dig-block-at', placed.x, placed.y, placed.z, true, 'target', true); } catch { /* the tool is made either way */ }
    }
  }
  note(root, `道具の補充: ${decision.block}に${decision.current}を使わないよう、${describePlan(plan)}を作りました（1ブロックあたり約${decision.saving.toFixed(1)}秒分の節約）。`);
  return plan.item;
}

/** Uses a pickaxe is counted to have left for a job: its last NEARLY_BROKEN_USES are kept (toolChoice leaves them alone). */
function usableUses(item: CarriedItem): number {
  const left = usesLeft(item);
  return left === null ? Infinity : Math.max(0, left - NEARLY_BROKEN_USES);
}

/**
 * Uses the pickaxes carried have between them for these blocks: only those that can break every one of them count, each less its last
 * two uses. Infinity when one of them does not say how worn it is.
 */
export function pickaxeUsesFor(items: CarriedItem[], blocks: Array<BlockLike & { name: string }>): number {
  let total = 0;
  for (const item of items) {
    if (!item.name.endsWith('_pickaxe')) continue;
    if (!blocks.every(block => !block.harvestTools || canHarvest(block, item))) continue;
    total += usableUses(item);
  }
  return total;
}

/** Crafts made to keep a pickaxe in hand, per action: a second try at what failed is not worth the seconds. */
const spareCrafts = new WeakMap<object, number>();
const MAX_SPARE_CRAFTS = 2;
/** Pickaxes in the order they are made as a spare: stone (131 uses, a few cobblestone), wood (59), then iron and the rest. */
const SPARE_ORDER = ['stone_pickaxe', 'wooden_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];

export interface ToolUsesCheck {
  /** Uses the pickaxes carried have for these blocks (before any spare was made), or after, when one was. */
  have: number;
  need: number;
  /** The spare that was made, if one was. */
  made: string | null;
  /** True when the pickaxes carried (with what was made) cover the need. */
  enough: boolean;
  /** One sentence for the result: what was made, or why no spare could be, empty when nothing is to be said. */
  note: string;
}

/**
 * Before a job that wears a pickaxe by about `need` uses (blocks to mine times one and a fifth, the stone dug on the way, the levels
 * of a stair): if the pickaxes carried that can break `blocks` have fewer between them, a spare is made when it can be now from what
 * is carried (a stone pickaxe from cobblestone and sticks, with a table put down and taken back as in keepCheapTool). Run 20 broke its
 * only stone pickaxe on the twelfth iron ore (1 of 131 left, 75 cobblestone in the pack) and the order ended as tool_broke. Nothing is
 * crafted in an emergency, a fight or a reflex; when no spare can be made the note says how little is left and what is missing.
 */
export async function ensureToolUses(bot: StockBody, blocks: Array<BlockLike & { name: string }>, need: number, call: SkillCall): Promise<ToolUsesCheck> {
  const items = bot.inventory?.items?.() ?? [];
  const have = pickaxeUsesFor(items, blocks);
  const fine: ToolUsesCheck = { have, need, made: null, enough: true, note: '' };
  if (have >= need) return fine;
  const short = (note: string, now = have): ToolUsesCheck => ({ have: now, need, made: null, enough: false, note });
  // The LLM-centric body makes no spare by itself: the shortfall is said, the making is the planner's (MINEBOT_LLM_CENTRIC).
  if (isLlmCentric(bot)) return short(`ツルハシの残り耐久は合計${have}で、これから掘る見込み${need}ブロックに足りません`);
  const context = currentAction(bot) as unknown as { root?: object; priority?: number; safetyLease?: boolean } | undefined;
  const root = context ? (context.root ?? context) : null;
  const registry = bot.registry;
  const describe = (missing: string) => `ツルハシの残り耐久は合計${have}で、これから掘る見込み${need}ブロックに足りません。予備のツルハシは作れません（${missing}）`;
  if (!registry?.recipes) return short(describe('レシピが分かりません'));
  const rank = root as { priority?: number; safetyLease?: boolean } | null;
  const host = nativeActionHost(bot) as StockBody;
  if (!root || (rank!.priority ?? 0) !== 0 || rank!.safetyLease || String(host.minebotControlState ?? '').startsWith('emergency') || isEngaged(host)) {
    return short(`ツルハシの残り耐久は合計${have}で、これから掘る見込み${need}ブロックに足りません（いまは予備を作る時ではありません）`);
  }
  // The pickaxes that break every one of the blocks, in the order a spare is made.
  const defs = Object.values(registry.itemsByName)
    .filter((def): def is ItemDef => !!def && def.name.endsWith('_pickaxe') && Number(def.maxDurability) > 0 && !NOT_A_STAND_IN.test(def.name))
    .filter(def => blocks.every(block => !block.harvestTools || canHarvest(block, { type: def.id })))
    .sort((a, b) => (SPARE_ORDER.indexOf(a.name) + 1 || 99) - (SPARE_ORDER.indexOf(b.name) + 1 || 99));
  const made: string[] = [];
  let now = have;
  let lastMissing = '';
  while (now < need && (spareCrafts.get(root) ?? 0) < MAX_SPARE_CRAFTS) {
    const carried = bot.inventory?.items?.() ?? [];
    const tableNear = tablesNear(bot, RESTOCK_TABLE_REACH).length > 0;
    const shortfall = need - now;
    const plans: Array<{ def: ItemDef; plan: CraftPlan }> = [];
    let withheld = '';
    for (const def of defs) {
      // At most one spare of a tier (two carried), and none beside a good pickaxe of a higher tier: run 21 made a "spare" stone pickaxe
      // action after action (MAX_SPARE_CRAFTS is per action) and carried five of them beside an iron one, in a pack that was full.
      const holds = carried.filter(entry => entry.name === def.name).reduce((sum, entry) => sum + entry.count, 0);
      if (holds >= pickaxeAllowance(carried as never, def.name)) {
        withheld = withheld || `${def.name}はすでに${holds}本持っています（同じ種類の予備は1本まで、より良いツルハシがあれば作りません）`;
        continue;
      }
      const outcome = planCraft(registry, carried, def.name, tableNear);
      if ('plan' in outcome) plans.push({ def, plan: outcome.plan }); else lastMissing = lastMissing || `${def.name}: ${outcome.missing}`;
    }
    // The first (cheapest) that covers what is short, else the one with the most uses.
    const chosen = plans.find(entry => entry.def.maxDurability! - NEARLY_BROKEN_USES >= shortfall)
      ?? [...plans].sort((a, b) => b.def.maxDurability! - a.def.maxDurability!)[0];
    if (!chosen) { if (withheld) lastMissing = lastMissing ? `${lastMissing}。${withheld}` : withheld; break; }
    spareCrafts.set(root, (spareCrafts.get(root) ?? 0) + 1);
    const tablesBefore = tablesNear(bot, RESTOCK_TABLE_REACH + 2);
    let failed = '';
    // A cancelled action must not be swallowed here; any other failure of the craft is only "not made".
    const cancelled = () => !!(context as unknown as { controller?: { signal?: { aborted?: boolean } } } | undefined)?.controller?.signal?.aborted;
    for (const step of chosen.plan.steps) {
      try {
        const result = await call('craft-one', step.item, step.count, RESTOCK_TABLE_REACH);
        if (!result.success) { failed = `${step.item}のクラフトに失敗（${String(result.result).slice(0, 100)}）`; break; }
      } catch (error) {
        if (cancelled()) throw error;
        failed = `${step.item}のクラフトでエラー（${error instanceof Error ? error.message.slice(0, 100) : 'unknown'}）`; break;
      }
    }
    if (chosen.plan.table === 'carried' || chosen.plan.table === 'made') {
      const known = new Set(tablesBefore.map(p => `${p.x},${p.y},${p.z}`));
      const placed = tablesNear(bot, RESTOCK_TABLE_REACH + 2).find(p => !known.has(`${p.x},${p.y},${p.z}`));
      if (placed) { try { await call('dig-block-at', placed.x, placed.y, placed.z, true, 'target', true); } catch (error) { if (cancelled()) throw error; } }
    }
    if (failed) { lastMissing = failed; break; }
    made.push(chosen.def.name);
    now = pickaxeUsesFor(bot.inventory?.items?.() ?? [], blocks);
  }
  if (made.length) {
    return { have: now, need, made: made.join('・'), enough: now >= need,
      note: `道具の補充: ツルハシの残りが${have}で、これから掘る見込み${need}ブロックに足りなかったため、予備の${made.join('・')}を作りました（残り合計${now}）${now >= need ? '' : '。それでも見込みには足りません'}` };
  }
  const why = lastMissing || ((spareCrafts.get(root) ?? 0) >= MAX_SPARE_CRAFTS ? '作る回数の上限' : '材料（丸石3か鉄3、棒2）が足りません');
  return short(describe(why));
}

/**
 * The diggable blocks a straight walk or tunnel from one point to another would meet (feet and head height),
 * one of each kind: what a dig on the way is likely to spend a tool on.
 */
export function blocksAlong(bot: StockBody, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number },
  maxKinds = 6): Array<BlockLike & { name: string }> {
  if (typeof bot.blockAt !== 'function') return [];
  const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const steps = Math.min(64, Math.ceil(distance));
  const seen = new Map<string, BlockLike & { name: string }>();
  for (let i = 1; i <= steps && seen.size < maxKinds; i++) {
    const t = i / steps;
    const x = Math.floor(from.x + (to.x - from.x) * t), y = Math.floor(from.y + (to.y - from.y) * t), z = Math.floor(from.z + (to.z - from.z) * t);
    for (const dy of [0, 1]) {
      let block: ReturnType<NonNullable<StockBody['blockAt']>> = null;
      try { block = bot.blockAt(new Vec3(x, y + dy, z)) ?? null; } catch { block = null; }
      if (!block || block.boundingBox !== 'block' || block.diggable === false || !block.harvestTools || seen.has(block.name)) continue;
      seen.set(block.name, block);
    }
  }
  return [...seen.values()];
}

/**
 * For the planner when a tool breaks: of the same kind of tool (the name's ending, as in *_pickaxe), the ones the
 * carried materials can make, cheapest material first; or what the same tool again would need.
 */
export function describeToolOptions(bot: unknown, brokenNames: string[]): string {
  const body = bot as StockBody;
  const registry = body?.registry;
  const items = body?.inventory?.items?.() ?? [];
  if (!registry?.recipes) return '';
  const tableNear = tablesNear(body, RESTOCK_TABLE_REACH).length > 0;
  const lines: string[] = [];
  for (const broken of [...new Set(brokenNames)]) {
    const kind = broken.includes('_') ? broken.slice(broken.lastIndexOf('_')) : null;
    if (!kind || !registry.itemsByName[broken]) continue;
    const sameKind = Object.values(registry.itemsByName)
      .filter((def): def is ItemDef => !!def && def.name.endsWith(kind) && Number(def.maxDurability) > 0)
      .sort((a, b) => wearCostSeconds(a) - wearCostSeconds(b));
    const makeable = sameKind.map(def => planCraft(registry, items, def.name, tableNear))
      .filter((outcome): outcome is { plan: CraftPlan } => 'plan' in outcome).slice(0, 3).map(outcome => describePlan(outcome.plan));
    if (makeable.length) lines.push(`手持ちの材料で作れる${kind.slice(1)}: ${makeable.join('、')}`);
    else {
      const again = planCraft(registry, items, broken, tableNear);
      lines.push(`手持ちの材料では${kind.slice(1)}を作れません（${broken}には ${'missing' in again ? again.missing : ''} が足りません）`);
    }
  }
  return lines.join('。');
}
