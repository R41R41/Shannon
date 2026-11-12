import { surplusPickaxes } from './inventoryTidy.js';

/**
 * tidy's plan (design flow-1111 A): what to throw, what to smelt and what to make so that the pack has room, decided from the pack and a few facts, with no body and no world.
 * Run 9 (11/13): a full pack stayed full for 1,294 s and "make room" acts were sent 20 times. The planner may name what to throw (`items`) and what to keep (`keep`);
 * with nothing named the body picks, in this order, stopping when `room` free slots are reached: scraps, rock that is not the scaffold, wooden tools beside better ones and a
 * stone sword beside an iron one, the scaffold above 64, raw copper.
 * Raw iron and raw gold are never scraps: they are smelted when a furnace is within reach and fuel is held (an ingot stacks with the ingots; iron is armour, a shield, a bucket),
 * and thrown only as the last of all, when the ingots are enough and the furnace or the fuel is not there.
 */
export interface TidyStack { name: string; count: number; stackSize?: number; maxDurability?: number; durabilityUsed?: number }
export interface TidyArgs {
  items?: Array<{ item: string; count?: number }>;
  keep?: Array<{ item: string; count: number }>;
  room?: number;
  smelt?: boolean;
}
export interface TidyFacts {
  /** Free slots now (9..44). */
  free: number;
  /** A crafting table within reach, or one that can be put down (carried, or four planks / a log to make it from). */
  table: boolean;
  /** A furnace within 16 m that is not busy, or one carried, or the cobblestone and the table to make one. */
  furnace: boolean;
  /** Kept for callers; raw gold is smelted whenever a furnace and fuel are there. */
  goldWanted?: boolean;
  /** Flint is wanted (a flint and steel to make): a little gravel is kept. */
  flintWanted?: boolean;
  /** In the Nether: netherrack then counts as scaffold; elsewhere it is rock to throw (cobblestone is the scaffold). */
  nether?: boolean;
}
export interface TidyPlan {
  smelt: Array<{ item: string; count: number }>;
  fuel: { item: string; count: number } | null;
  make: Array<{ item: string; count: number; from: string }>;
  throw: Array<{ item: string; count: number }>;
  /** Free slots after the plan (estimated from stack sizes). */
  after: number;
  /** Why something was left (for the line). */
  why: string[];
}

export const DEFAULT_ROOM = 6;
/** The scaffold kept at ease; with room still short it is cut to SCAFFOLD_TIGHT. */
const SCAFFOLD_KEEP = 128;
const SCAFFOLD_TIGHT = 64;
/** Cobblestone and cobbled deepslate are one pool (either is a scaffold block); netherrack is its own, the scaffold only in the Nether. */
const COBBLE_POOL = ['cobbled_deepslate', 'cobblestone'];
/** Cobblestone held back while a furnace or a stone tool may still be made. */
const STONE_FOR_MAKING = 8;
const SMALL_STACK = new Map<string, number>([['ender_pearl', 16], ['snowball', 16], ['egg', 16], ['bucket', 16], ['honey_bottle', 16]]);
/** Ingots wanted before raw iron is no longer worth a smelt (a full set of armour, shield, bucket, flint and steel). */
const INGOTS_ENOUGH = 24;
const FLOWERS = /^(dandelion|poppy|blue_orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|lilac|rose_bush|peony|sunflower|wither_rose|torchflower|pink_petals|[a-z]+_tulip|short_grass|tall_grass|fern|large_fern|dead_bush|vine|glow_lichen|sugar_cane_unused)$/u;
const JUNK_ALWAYS = /^(rotten_flesh|spider_eye|poisonous_potato|leaf_litter|wheat_seeds|beetroot_seeds|pumpkin_seeds|melon_seeds|torchflower_seeds|pitcher_pod|calcite|dripstone_block|pointed_dripstone)$|_sapling$|_propagule$|_door$|_terracotta$|_banner$|_sign$|_hanging_sign$/u;
/** Rock and soil that is not the scaffold: thrown to nothing (gravel keeps 4, dirt 16 when there is no scaffold rock). */
const OTHER_ROCK = new Set(['andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'stone', 'dirt', 'coarse_dirt', 'rooted_dirt', 'mud', 'sand', 'red_sand', 'gravel', 'basalt', 'smooth_basalt', 'blackstone', 'cobbled_deepslate', 'cobblestone', 'netherrack']);
const TOOL_TIER = ['wooden', 'stone', 'golden', 'iron', 'diamond', 'netherite'];

const stackOf = (item: TidyStack): number => item.stackSize ?? SMALL_STACK.get(item.name) ?? (item.maxDurability && item.maxDurability > 0 ? 1 : 64);
export const slotsFor = (count: number, stack: number): number => count <= 0 ? 0 : Math.ceil(count / Math.max(1, stack));

/** The fuel to smelt `n` items with: coal and charcoal first, then logs and planks; null when none covers even one. */
function chooseFuel(items: TidyStack[], n: number, keep: Map<string, number>): { item: string; count: number; covers: number } | null {
  const options: Array<{ name: string; per: number }> = [{ name: 'coal', per: 8 }, { name: 'charcoal', per: 8 }];
  for (const stack of items) if (/_log$|_planks$/u.test(stack.name)) options.push({ name: stack.name, per: 1.5 });
  for (const option of options) {
    // keep only stops a throw, never a smelt: coal and charcoal are all fuel (the head holds coal back for the iron itself). Wood keeps what a table, tools, a shield and a bed are made of (4 logs, 8 planks) at least.
    const wood = /_log$/u.test(option.name) ? 4 : /_planks$/u.test(option.name) ? 8 : 0;
    const held = wood > 0 ? Math.max(keep.get(option.name) ?? 0, wood) : 0;
    const have = items.filter(stack => stack.name === option.name).reduce((sum, stack) => sum + stack.count, 0) - held;
    if (have <= 0) continue;
    const need = Math.max(1, Math.ceil(n / option.per - 1e-9));
    return { item: option.name, count: Math.min(have, need), covers: Math.min(n, Math.floor(Math.min(have, need) * option.per + 1e-9)) };
  }
  return null;
}

export function planTidy(items: TidyStack[], args: TidyArgs, facts: TidyFacts): TidyPlan {
  const have = new Map<string, number>();
  const stackSizes = new Map<string, number>();
  for (const item of items) { have.set(item.name, (have.get(item.name) ?? 0) + item.count); stackSizes.set(item.name, stackOf(item)); }
  const count = (name: string) => have.get(name) ?? 0;
  const keep = new Map<string, number>((args.keep ?? []).map(entry => [entry.item, Math.max(0, Math.round(entry.count))]));
  const room = Math.max(1, Math.min(20, Math.round(args.room ?? DEFAULT_ROOM)));
  const slotsOf = (name: string) => slotsFor(count(name), stackSizes.get(name) ?? 64);
  const plan: TidyPlan = { smelt: [], fuel: null, make: [], throw: [], after: facts.free, why: [] };
  let free = facts.free;
  const change = (name: string, delta: number) => {
    const before = slotsOf(name);
    have.set(name, Math.max(0, count(name) + delta));
    free += before - slotsOf(name);
  };

  // 1. Compress (a table within reach): hay blocks into bread (3 bread to the block).
  const hay = count('hay_block');
  if (hay > 0 && !keep.has('hay_block')) {
    if (facts.table) {
      const blocks = Math.min(hay, Math.floor(64 / 3));
      plan.make.push({ item: 'bread', count: blocks * 3, from: `hay_block×${blocks}` });
      stackSizes.set('bread', stackSizes.get('bread') ?? 64);
      change('hay_block', -blocks);
      change('bread', blocks * 3);
    } else plan.why.push('作業台が無く hay_block はパンにできない');
  }

  // 2. Smelt: raw iron (and raw gold when gold is wanted) when a furnace and fuel are there. Smelting keeps the slot (raw 8 -> ingot 8) but joins an ingot stack and counts for have:iron_ingot.
  const rawIron = count('raw_iron'), rawGold = count('raw_gold');
  // Whatever raw iron or gold is left is smelted (a furnace and fuel being there): the rest joins the ingot stack. `keep` only stops a throw, never a smelt (smelting keeps the value).
  const wantIron = rawIron > 0;
  const wantGold = rawGold > 0;
  let smeltable = false;
  if (args.smelt === false) plan.why.push('smelt=off で焼かない');
  else if ((wantIron || wantGold) && !facts.furnace) plan.why.push('炉が遠い（16m 超）か無いので原石は焼かず持ち続ける');
  else if (wantIron || wantGold) smeltable = true;
  if (smeltable) {
    const total = (wantIron ? rawIron : 0) + (wantGold ? rawGold : 0);
    const fuel = chooseFuel(items, Math.min(64, total), keep);
    if (!fuel) { plan.why.push('燃料（石炭・木炭・原木）が無く原石は焼かない'); smeltable = false; }
    else {
      let budget = fuel.covers;
      const loads: Array<{ item: string; count: number }> = [];
      if (wantIron) { const n = Math.min(64, rawIron, budget); if (n > 0) { loads.push({ item: 'raw_iron', count: n }); budget -= n; } }
      if (wantGold && budget > 0) { const n = Math.min(64, rawGold, budget); if (n > 0) loads.push({ item: 'raw_gold', count: n }); }
      if (loads.length) {
        plan.smelt = loads;
        const used = loads.reduce((sum, load) => sum + load.count, 0);
        plan.fuel = { item: fuel.item, count: Math.max(1, Math.min(fuel.count, Math.ceil(used / (fuel.item === 'coal' || fuel.item === 'charcoal' ? 8 : 1.5) - 1e-9))) };
        if (used < total) plan.why.push(`燃料が ${used} 個ぶんしか無く、原石の残りは焼かない`);
        for (const load of loads) {
          const out = load.item === 'raw_iron' ? 'iron_ingot' : 'gold_ingot';
          change(load.item, -load.count);
          change(out, load.count);
        }
      } else smeltable = false;
    }
  }

  // 3. What to throw.
  const asked = new Map<string, number>();
  const explicit = (args.items ?? []).length > 0;
  const push = (name: string, n: number, force: boolean) => {
    const reserve = keep.get(name) ?? 0;
    // The last pickaxe of a kind is never thrown (the drop keeps it), so it frees no slot.
    const n2 = Math.min(n, count(name) - reserve - (/_pickaxe$/u.test(name) ? 1 : 0));
    if (n2 <= 0) return;
    const before = slotsOf(name);
    const after = slotsFor(count(name) - n2, stackSizes.get(name) ?? 64);
    if (!force && before === after) return;
    asked.set(name, (asked.get(name) ?? 0) + n2);
    change(name, -n2);
  };
  if (explicit) {
    for (const want of args.items ?? []) {
      const n = Math.max(1, Math.round(want.count ?? count(want.item)));
      push(want.item, n, true);
    }
  } else {
    const done = () => free >= room;
    const names = () => [...have.keys()].filter(name => count(name) > 0);
    // (1) scraps
    for (const name of names()) {
      if (done()) break;
      if (JUNK_ALWAYS.test(name) || FLOWERS.test(name)) push(name, count(name), false);
      else if ((name === 'emerald' || name === 'gold_nugget') && count(name) < 9) push(name, count(name), false);
    }
    // (2) rock that is not the scaffold. Cobblestone and cobbled deepslate are one pool: a kind goes here only when the rest of the pool still holds SCAFFOLD_TIGHT;
    // otherwise the pool is trimmed in (4). 8 cobblestone stay for a furnace and stone tools. Netherrack is scaffold only in the Nether (or when there is no cobble at all).
    const pool = () => COBBLE_POOL.reduce((sum, name) => sum + count(name), 0);
    const netherScaffold = !!facts.nether || pool() === 0;
    for (const name of names()) {
      if (done()) break;
      if (!OTHER_ROCK.has(name)) continue;
      if (name === 'netherrack' && netherScaffold) continue;
      let stay = 0;
      if (COBBLE_POOL.includes(name)) {
        stay = pool() - count(name) >= SCAFFOLD_TIGHT ? 0 : count(name);
        if (name === 'cobblestone') stay = Math.max(stay, Math.min(count(name), STONE_FOR_MAKING));
      } else if (name === 'gravel') stay = 4;
      else if (name === 'dirt' && pool() === 0 && count('netherrack') === 0) stay = 16;
      push(name, count(name) - stay, false);
    }
    // (3) tools beside better ones, extra pickaxes
    const tools = items.filter(item => /_(pickaxe|axe|shovel|hoe|sword)$/u.test(item.name));
    for (const kind of ['pickaxe', 'axe', 'shovel', 'hoe', 'sword']) {
      const rank = (name: string) => TOOL_TIER.indexOf(name.replace(new RegExp(`_${kind}$`, 'u'), ''));
      const best = Math.max(-1, ...tools.filter(tool => tool.name.endsWith(`_${kind}`)).map(tool => rank(tool.name)));
      for (const name of [...new Set(tools.filter(tool => tool.name.endsWith(`_${kind}`)).map(tool => tool.name))]) {
        if (done()) break;
        const r = rank(name);
        const worthless = name === 'stone_sword' ? best >= TOOL_TIER.indexOf('iron') : name.startsWith('wooden_') ? best > r : false;
        if (worthless && count(name) > 0) push(name, count(name), false);
      }
    }
    // The Nether trip wants 3 pickaxes (iron one each, diamond three): iron and better are not thrown while they are 3 or fewer in all.
    const heldPickaxes = tools.filter(tool => /^(iron|diamond|netherite)_pickaxe$/u.test(tool.name)).reduce((sum, tool) => sum + tool.count, 0);
    for (const surplus of surplusPickaxes(tools.map(tool => ({ ...tool })))) {
      if (done()) break;
      if (/^(iron|diamond|netherite)_pickaxe$/u.test(surplus.name) && heldPickaxes <= 3) continue;
      push(surplus.name, surplus.count, false);
    }
    // (4) the scaffold above SCAFFOLD_KEEP, then above SCAFFOLD_TIGHT, only while room is short: the cobble pool (deepslate first, 8 cobblestone stay), and netherrack when it is the scaffold
    const trimTo = (limit: number) => {
      let over = pool() - limit;
      for (const name of COBBLE_POOL) {
        if (done() || over <= 0) break;
        const floor = name === 'cobblestone' ? Math.min(count(name), STONE_FOR_MAKING) : 0;
        const n = Math.min(over, count(name) - floor);
        if (n > 0) { push(name, n, false); over -= n; }
      }
      if (netherScaffold && !done()) push('netherrack', count('netherrack') - limit, false);
    };
    if (!done()) trimTo(SCAFFOLD_KEEP);
    if (!done()) trimTo(SCAFFOLD_TIGHT);
    // (5) raw copper, then (6) raw ore that cannot be smelted (ingots enough, furnace or fuel missing): a handful that would be thrown away
    if (!done() && count('raw_copper') > 0) push('raw_copper', count('raw_copper'), false);
    if (!done()) {
      for (const [name, ingot] of [['raw_iron', 'iron_ingot'], ['raw_gold', 'gold_ingot']] as const) {
        if (done()) break;
        if (count(name) > 0 && count(name) <= 3 && count(ingot) >= INGOTS_ENOUGH && !smeltable && !keep.has(name)) push(name, count(name), false);
      }
    }
  }
  plan.throw = [...asked.entries()].map(([item, n]) => ({ item, count: n }));
  plan.after = free;
  return plan;
}

/** The pack's biggest heaps and what is held back, for a plan that has nothing to throw (reason no_room). */
export function describeHeaps(items: TidyStack[], keep: Array<{ item: string; count: number }> = []): string {
  const totals = new Map<string, { count: number; slots: number; stack: number }>();
  for (const item of items) {
    const entry = totals.get(item.name) ?? { count: 0, slots: 0, stack: stackOf(item) };
    entry.count += item.count;
    totals.set(item.name, entry);
  }
  for (const entry of totals.values()) entry.slots = slotsFor(entry.count, entry.stack);
  const heaps = [...totals].sort((a, b) => b[1].slots - a[1].slots || b[1].count - a[1].count).slice(0, 6).map(([name, entry]) => `${name}×${entry.count}`);
  const held = keep.length ? `・全部要る物（${keep.map(entry => `${entry.item}:${entry.count}`).join(' ')}）` : '・全部要る物（約束・防具の材料）';
  return `場所を取る物: ${heaps.join(' ') || 'なし'}${held}`;
}
