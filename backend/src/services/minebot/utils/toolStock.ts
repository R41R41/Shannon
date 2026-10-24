/**
 * What the pickaxes carried come to for a job, and what the carried materials can make when a tool breaks. The body makes no tool by
 * itself (design mb-llm-centric): which tool to make, and when, is the planner's; the body says what is short.
 */
import { Vec3 } from 'vec3';
import { canHarvest, NEARLY_BROKEN_USES, usesLeft, wearCostSeconds, type BlockLike, type ToolLike } from './toolChoice.js';

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

interface StockBody {
  registry?: StockRegistry;
  entity?: { position?: { x: number; y: number; z: number; distanceTo?(other: unknown): number }; effects?: unknown };
  inventory?: { items(): CarriedItem[] };
  findBlocks?(options: { matching: number; maxDistance: number; count: number }): Array<{ x: number; y: number; z: number }>;
  blockAt?(position: unknown): (BlockLike & { name: string; boundingBox?: string; diggable?: boolean }) | null;
}

/** A crafting table this close counts as at hand for what can be made. */
const TABLE_REACH = 4;

function tablesNear(bot: StockBody, reach: number): Array<{ x: number; y: number; z: number }> {
  const id = (bot.registry as unknown as { blocksByName?: Record<string, { id: number } | undefined> } | undefined)?.blocksByName?.crafting_table?.id;
  if (id === undefined || typeof bot.findBlocks !== 'function') return [];
  try { return bot.findBlocks({ matching: id, maxDistance: reach, count: 8 }); } catch { return []; }
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

export interface ToolUsesCheck {
  /** Uses the pickaxes carried have for these blocks. */
  have: number;
  need: number;
  /** True when the pickaxes carried cover the need. */
  enough: boolean;
  /** One sentence for the result when they do not, empty when nothing is to be said. */
  note: string;
}

/**
 * Before a job that wears a pickaxe by about `need` uses (blocks to mine times one and a fifth, the stone dug on the way, the levels
 * of a stair): whether the pickaxes carried that can break `blocks` have that many between them. Run 20 broke its only stone pickaxe
 * on the twelfth iron ore (1 of 131 left). No spare is made: the shortfall is said, the making is the planner's.
 */
export function pickaxeUsesCheck(bot: StockBody, blocks: Array<BlockLike & { name: string }>, need: number): ToolUsesCheck {
  const have = pickaxeUsesFor(bot.inventory?.items?.() ?? [], blocks);
  if (have >= need) return { have, need, enough: true, note: '' };
  return { have, need, enough: false, note: `ツルハシの残り耐久は合計${have}で、これから掘る見込み${need}ブロックに足りません` };
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
  const tableNear = tablesNear(body, TABLE_REACH).length > 0;
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
