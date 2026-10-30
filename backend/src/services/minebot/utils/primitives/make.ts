import { Vec3 } from 'vec3';
import { feetCell, relativeWords, type Cell } from '../localMap.js';
import { cellText, freeSlots, guard, inventoryCount, stopped, StepStopped, wait, type StepContext, type StepOutcome } from './common.js';
import { nearestTable, tableInReach } from './craft.js';
import { placeNearby } from './placeSpot.js';
import { withProgress } from './progressUnits.js';
import { craftEvents } from './craftEvents.js';

/**
 * make: one item, and the parts it is made of, in a chain of crafts (hands-contract.md 4). The planner says what and how many; the body
 * works the parts out of what the pack holds: planks from logs, sticks from planks, the tool from both. A 3x3 recipe needs a crafting
 * table within reach: one standing near is used, else the one the pack holds is put down (and left there); with neither it stops
 * (`no_table`). When the pack cannot make it, nothing is made: the stop lists what is missing (`missing: oak_log×2・cobblestone×3`),
 * counted in the things the body cannot craft itself. It does not gather materials, and makes one kind of item and what it is made of.
 */
export interface MakeArgs { item: string; count?: number }

interface Step { item: string; recipe: any; times: number; per: number }
interface State { stock: Map<string, number>; steps: Step[]; short: Map<string, number>; nodes: number }

const MAX_NODES = 40_000;
const MAX_CANDIDATES = 16;
const nameOf = (bot: any, id: number): string => String(bot.registry?.items?.[id]?.name ?? id);

/** What a recipe takes: its ingredients by item name and count (the negative entries of the recipe's delta). */
function ingredientsOf(bot: any, recipe: any): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of recipe.delta ?? []) if (entry.count < 0) out.set(nameOf(bot, entry.id), (out.get(nameOf(bot, entry.id)) ?? 0) - entry.count);
  return out;
}
const perCraft = (recipe: any): number => Math.max(1, Number(recipe.result?.count ?? 1));
/** Every recipe of an item, those of the 3x3 table too. */
function recipesFor(bot: any, name: string): any[] {
  const item = bot.registry?.itemsByName?.[name];
  if (!item) return [];
  try { return (bot.recipesAll?.(item.id, null, true) ?? []) as any[]; } catch { return []; }
}
const clone = (state: State): State => ({ stock: new Map(state.stock), steps: [...state.steps], short: new Map(state.short), nodes: state.nodes });
const shortTotal = (state: State) => [...state.short.values()].reduce((sum, n) => sum + n, 0);
/** Of materials that are as short as each other, the common kind is the one told (oak before cherry, cobblestone before cobbled deepslate). */
const commonness = (state: State) => [...state.short].reduce((sum, [name, n]) => sum + n * (/^(oak_|cobblestone$|stick$|iron_ingot$|gold_ingot$|diamond$|string$|leather$)/u.test(name) ? 0 : 1), 0);

/**
 * Gets `qty` of `name` into the state's stock by crafting what the stock lacks, from what it holds: the recipe whose parts the pack
 * (and, failing that, the parts' own recipes) can give. A thing that cannot be crafted and is not held is recorded in `short`. The parts of
 * a craft are taken out of the stock as they are found, so two parts do not count the same log twice. True when the stock has `qty`.
 */
function obtain(bot: any, name: string, qty: number, state: State, path: readonly string[]): boolean {
  const have = state.stock.get(name) ?? 0;
  if (have >= qty) return true;
  const deficit = qty - have;
  if (++state.nodes > MAX_NODES) { state.short.set(name, (state.short.get(name) ?? 0) + deficit); return false; }
  const recipes = recipesFor(bot, name).filter(recipe => {
    const parts = ingredientsOf(bot, recipe);
    if (!parts.size || [...parts.keys()].some(part => part === name || path.includes(part))) return false;
    // A recipe that undoes another (an ingot from its block or its nuggets) is used only with what is held: the block is not made from the ingot to make the ingot.
    return ![...parts].some(([part, count]) => (state.stock.get(part) ?? 0) < count && recipesFor(bot, part).some(back => ingredientsOf(bot, back).has(name)));
  }).map(recipe => {
    const parts = ingredientsOf(bot, recipe);
    // The ones whose parts are in hand (or one craft from it: planks from the logs held) are tried first: a tool has a recipe for every kind of plank.
    let covered = 0;
    for (const [part, count] of parts) {
      const held = state.stock.get(part) ?? 0;
      covered += held >= count ? 1 : held > 0 ? 0.6 : recipesFor(bot, part).some(made => [...ingredientsOf(bot, made).keys()].every(inner => (state.stock.get(inner) ?? 0) > 0)) ? 0.5 : 0;
    }
    return { recipe, covered: covered / parts.size };
  }).sort((a, b) => b.covered - a.covered).slice(0, MAX_CANDIDATES);
  if (!recipes.length) { state.short.set(name, (state.short.get(name) ?? 0) + deficit); return false; }
  let best: { state: State; ok: boolean } | null = null;
  for (const { recipe } of recipes) {
    const trial = clone(state);
    const per = perCraft(recipe), times = Math.ceil(deficit / per);
    let ok = true;
    for (const [part, count] of ingredientsOf(bot, recipe)) {
      const wanted = count * times;
      if (!obtain(bot, part, wanted, trial, [...path, name])) ok = false;
      trial.stock.set(part, Math.max(0, (trial.stock.get(part) ?? 0) - wanted));
    }
    if (ok) {
      trial.steps.push({ item: name, recipe, times, per });
      trial.stock.set(name, have + times * per);
    }
    const better = !best || (ok && !best.ok) || (ok === best.ok && (ok ? trial.steps.length < best.state.steps.length
      : shortTotal(trial) < shortTotal(best.state) || (shortTotal(trial) === shortTotal(best.state) && commonness(trial) < commonness(best.state))));
    if (better) best = { state: trial, ok };
    if (ok && trial.steps.length === state.steps.length + 1) break;   // nothing is cheaper than one craft
    if (trial.nodes > MAX_NODES) break;
  }
  state.stock = best!.state.stock; state.steps = best!.state.steps; state.short = best!.state.short; state.nodes = best!.state.nodes;
  return best!.ok;
}

const stacksOut = (made: Map<string, number>) => [...made.entries()].map(([name, count]) => `${name}×${count}`);

/**
 * Continue contracts (1): progress in items (`done` what the pack gained of the item, `left` the count not yet made). `count` is how many MORE to make (the target is the
 * number held now plus count): a pack that holds that many already is not "already".
 */
export async function make(ctx: StepContext, args: MakeArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const wanted = Math.max(1, Math.min(64, Math.round(args.count ?? 1)));
  const had = inventoryCount(bot, String(args.item ?? ''));
  return withProgress(() => makeItem(ctx, args), () => {
    const gained = Math.max(0, inventoryCount(bot, String(args.item ?? '')) - had);
    return { unit: 'item', done: gained, left: Math.max(0, wanted - gained) };
  });
}

async function makeItem(ctx: StepContext, args: MakeArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const name = String(args.item ?? '');
  const item = bot.registry?.itemsByName?.[name];
  if (!item) return fail(bot, 'no_recipe', `${name} は物の名前ではない`);
  const count = Math.max(1, Math.min(64, Math.round(args.count ?? 1)));
  if (!recipesFor(bot, name).length) return fail(bot, 'no_recipe', `${name} の作り方が無い（かまどで焼く物・掘る物・取引で得る物かもしれない）`);
  const stock = new Map<string, number>();
  for (const entry of (bot.inventory?.items?.() ?? []) as Array<{ name: string; count: number }>) stock.set(entry.name, (stock.get(entry.name) ?? 0) + entry.count);
  const before = stock.get(name) ?? 0;
  const state: State = { stock, steps: [], short: new Map(), nodes: 0 };
  if (!obtain(bot, name, before + count, state, [])) {
    const lacking = [...state.short.entries()].map(([part, n]) => `${part}×${n}`);
    const held = stacksOut(new Map([...stock.entries()].filter(([, n]) => n > 0).slice(0, 8)));
    return fail(bot, 'missing', `${lacking.join('・') || '?'}（作る物 ${name}×${count} と途中の物の分。何も作っていない${held.length ? `。持っている ${held.join(' ')}` : ''}）`);
  }
  // Room in the pack for what comes of it: a pack with no free slot takes the item only into a stack it already has.
  if (freeSlots(bot) === 0) {
    const room = ((bot.inventory?.items?.() ?? []) as any[]).some(entry => entry.name === name && entry.count < Number(item.stackSize ?? 64));
    if (!room) return fail(bot, 'full', `持ち物が満杯で ${name} を入れる所が無い（何も作っていない）`);
  }
  let table: any = null, placedAt: Cell | null = null;
  if (state.steps.some(step => step.recipe.requiresTable === true)) {
    table = tableInReach(bot);
    if (!table) {
      if (inventoryCount(bot, 'crafting_table') > 0) {
        const put = await placeNearby(ctx, 'crafting_table');
        if ('fail' in put) return fail(bot, 'no_table', `作業台が要る。持っている crafting_table を置けなかった: ${put.fail.text}`);
        placedAt = put.cell;
        table = bot.blockAt?.(new Vec3(put.cell.x, put.cell.y, put.cell.z), false) ?? null;
        if (!table || table.name !== 'crafting_table') table = tableInReach(bot);
        if (!table) return fail(bot, 'no_table', `作業台を ${cellText(put.cell)} に置いたが、使える作業台として見えない`);
      } else {
        const near = nearestTable(bot);
        const feet = feetCell(bot);
        return fail(bot, 'no_table', `${name} の途中に作業台（3x3）が要る。手の届く所に作業台が無く、持ってもいない${near && feet ? `（いちばん近い作業台 ${cellText(near)} 自分から${relativeWords(feet, near)}）` : near ? `（いちばん近い作業台 ${cellText(near)}）` : ''}`);
      }
    }
  }
  const made = new Map<string, number>();
  /** The pieces made on the way (planks for the sticks): the events of what is made of them say so (intermediate). */
  const madeNames = new Set<string>();
  for (const step of state.steps) {
    const gained = await craftStep(ctx, step, table, name, madeNames);
    if (gained.fail) return { ...gained.fail, text: `${gained.fail.text}${made.size ? `（ここまでに作った: ${stacksOut(made).join('・')}）` : ''}` };
    made.set(step.item, (made.get(step.item) ?? 0) + gained.n);
  }
  const final = made.get(name) ?? 0;
  made.delete(name);
  const parts = stacksOut(made);
  return { ok: true, text: `make 済 ${name}×${final}${parts.length ? `（${parts.join('・')} も作った）` : ''}${placedAt ? `。作業台を ${cellText(placedAt)} に置いた` : ''}（今 ${inventoryCount(bot, name)} 個）` };
}

function fail(bot: any, reason: string, text: string): StepOutcome {
  return stopped(bot, reason, `make 止まった ${reason}: ${text}`);
}

/** One craft of a plan: `times` of the recipe, in the table's window when it is a 3x3. What the pack gained of the result is counted, not assumed. */
async function craftStep(ctx: StepContext, step: Step, table: any, target: string, madeNames: Set<string>): Promise<{ n: number; fail?: StepOutcome }> {
  const bot = ctx.bot;
  const before = inventoryCount(bot, step.item);
  if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow); } catch { /* closing */ } await wait(ctx, 100); }
  const intermediate = step.item !== target;
  const record = craftEvents(ctx, step.recipe, step.item, intermediate, madeNames);
  try {
    try {
      const crafted = await guard(ctx, Promise.resolve(bot.craft(step.recipe, step.times, step.recipe.requiresTable === true ? table : undefined)), 4000 + step.times * 400);
      if (!crafted) return { n: 0, fail: fail(bot, 'craft_failed', `${step.item} を作る途中で時間切れ（今 ${inventoryCount(bot, step.item)} 個）`) };
    } catch (error) {
      if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error;
      return { n: 0, fail: fail(bot, freeSlots(bot) === 0 ? 'full' : 'craft_failed', `${step.item} を作れなかった: ${String((error as Error)?.message ?? error).slice(0, 100)}`) };
    }
    await wait(ctx, 150);
    const gained = inventoryCount(bot, step.item) - before;
    if (gained <= 0) return { n: 0, fail: fail(bot, freeSlots(bot) === 0 ? 'full' : 'craft_failed', `${step.item} が増えていない（前 ${before} 個、今 ${inventoryCount(bot, step.item)} 個）`) };
    return { n: gained };
  } finally { record(); if (intermediate && inventoryCount(bot, step.item) > before) madeNames.add(step.item); }
}
