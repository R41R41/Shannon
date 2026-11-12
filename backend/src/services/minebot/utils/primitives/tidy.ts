import { scanLoadedBlocks } from '../loadedBlockScan.js';
import { feetCell, type Cell } from '../localMap.js';
import { describeHeaps, planTidy, DEFAULT_ROOM, type TidyArgs, type TidyFacts, type TidyPlan, type TidyStack } from '../tidyPlan.js';
import { eyeDistance, freeSlots, inventoryCount, stopped, USE_REACH, type StepContext, type StepOutcome } from './common.js';
import { drop } from './body.js';
import { furnace, furnaceBusy } from './furnace.js';
import { make } from './make.js';
import { smelt } from './smelt.js';

/**
 * tidy: make room in the pack (design flow-1111 A). One hand where the planner used to send `drop` seven times (run 9, 11/13: a full pack stayed full for 1,294 s, twenty acts to clear it):
 * the body picks what to throw (utils/tidyPlan, the planner's `items` and `keep` first), turns hay blocks into bread at a table, puts raw iron into a furnace within reach (and takes
 * the ingots after the throw), throws the rest into a hole (the drop's own way, with its checks) and says the free slots before and after. The planner reads the pack in the next state.
 */
export interface TidyHandArgs extends TidyArgs { seconds?: number }

const FURNACES = ['furnace', 'blast_furnace'];
/** A furnace within this many metres is worth the walk. */
const FURNACE_M = 16;
const TABLE_M = 5;
const DEFAULT_SECONDS = 90;
const clamp = (value: number, least: number, most: number) => Math.max(least, Math.min(most, value));

const stacksNow = (bot: any): TidyStack[] => ((bot.inventory?.items?.() ?? []) as any[]).map(item => ({
  name: String(item.name), count: Number(item.count), stackSize: Number(item.stackSize) > 0 ? Number(item.stackSize) : undefined,
  maxDurability: item.maxDurability, durabilityUsed: item.durabilityUsed,
}));
const countsOf = (stacks: TidyStack[]) => { const map = new Map<string, number>(); for (const s of stacks) map.set(s.name, (map.get(s.name) ?? 0) + s.count); return map; };

/** The nearest furnace block within FURNACE_M that holds no batch of the body's. */
function nearbyFurnace(bot: any): Cell | null {
  try {
    const feet = feetCell(bot);
    const hits = scanLoadedBlocks(bot, FURNACES, { maxDistance: FURNACE_M, maxHits: 6 }).hits as Array<{ position: { x: number; y: number; z: number } }>;
    const cells = hits.map(hit => ({ x: hit.position.x, y: hit.position.y, z: hit.position.z })).filter(cell => !furnaceBusy(bot, cell));
    if (!feet) return cells[0] ?? null;
    return cells.sort((a, b) => Math.hypot(a.x - feet.x, a.z - feet.z) - Math.hypot(b.x - feet.x, b.z - feet.z))[0] ?? null;
  } catch { return null; }
}
function tableNear(bot: any): boolean {
  try { return scanLoadedBlocks(bot, ['crafting_table'], { maxDistance: TABLE_M, maxHits: 4 }).hits.some(hit => eyeDistance(bot, { x: hit.position.x, y: hit.position.y, z: hit.position.z }) <= USE_REACH + 1); } catch { return false; }
}
const planksHeld = (bot: any) => ((bot.inventory?.items?.() ?? []) as any[]).filter(item => /_planks$/u.test(item.name)).reduce((sum, item) => sum + item.count, 0);

/** What the pack and the place allow: a table (near, carried, or four planks to make one), a furnace (near, carried, or eight stones and a table to make one). */
export function readTidyFacts(bot: any): TidyFacts & { furnaceCell: Cell | null; tableAtHand: boolean; furnaceCarried: boolean } {
  const atHand = tableNear(bot);
  const table = atHand || inventoryCount(bot, 'crafting_table') > 0 || planksHeld(bot) >= 4;
  const furnaceCell = nearbyFurnace(bot);
  const carried = inventoryCount(bot, 'furnace') > 0;
  const stones = inventoryCount(bot, 'cobblestone') + inventoryCount(bot, 'cobbled_deepslate');
  return { free: freeSlots(bot), table, furnace: !!furnaceCell || carried || (table && stones >= 8), furnaceCell, tableAtHand: atHand, furnaceCarried: carried, nether: String(bot.game?.dimension ?? '').includes('nether') };
}

const fmt = (pairs: Array<{ item: string; count: number }>) => pairs.map(entry => `${entry.item}×${entry.count}`).join('・');

export async function tidy(ctx: StepContext, args: TidyHandArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const room = clamp(Math.round(Number(args.room ?? DEFAULT_ROOM)), 1, 20);
  const seconds = clamp(Number(args.seconds ?? DEFAULT_SECONDS), 5, 180);
  const freeBefore = freeSlots(bot);
  const facts = readTidyFacts(bot);
  const stacks = stacksNow(bot);
  const plan: TidyPlan = planTidy(stacks, { ...args, room }, facts);
  const line = (after: number, parts: string[], tail = '') => `空き ${freeBefore}→${after} マス（${parts.length ? parts.join('／') : '何もしなかった'}／預けず）${tail}`;
  if (!plan.throw.length && !plan.smelt.length && !plan.make.length) {
    if (facts.free >= room && !(args.items ?? []).length) return { ok: true, goal: 'already', text: `${line(freeBefore, [], `。room ${room} に足りている`)}${plan.why.length ? `（${plan.why.join('・')}）` : ''}` };
    return stopped(bot, 'no_room', `tidy 止まった no_room: ${line(freeBefore, [])}。捨てる物が無い。${describeHeaps(stacks, args.keep)}${plan.why.length ? `。${plan.why.join('。')}` : ''}`);
  }
  const before = countsOf(stacks);
  const notes: string[] = [...plan.why];
  const did: string[] = [];

  // 1. Compress.
  for (const job of plan.make) {
    const made = await make(ctx, { item: job.item, count: job.count });
    if (made.ok) did.push(`作った ${job.item}×${job.count}（${job.from} から）`);
    else notes.push(`${job.item} は作れず（${String(made.text).slice(0, 60)}）`);
  }

  // 2. Smelt: the furnace in reach (one made or put down when none stands), the batch put in now, the ingots taken after the throw.
  let smeltedAt: Cell | null = null;
  const smeltedLoads: Array<{ item: string; count: number }> = [];
  if (plan.smelt.length && plan.fuel) {
    let cell = facts.furnaceCell;
    if (!cell && !facts.furnaceCarried) {
      const built = await make(ctx, { item: 'furnace', count: 1 });
      if (!built.ok) notes.push(`炉を作れず原石は焼かない（${String(built.text).slice(0, 50)}）`);
    }
    if (cell || inventoryCount(bot, 'furnace') > 0) {
      let fuelLeft = plan.fuel.count;
      for (let index = 0; index < plan.smelt.length; index++) {
        const load = plan.smelt[index];
        if (index > 0 && inventoryCount(bot, 'furnace') < 1) { notes.push(`${load.item} は炉がもう 1 基無く焼かない`); continue; }
        const used = Math.max(1, Math.round(fuelLeft / (plan.smelt.length - index)));
        const put = await smelt(ctx, { items: [load], fuel: plan.fuel.item, fuelCount: used, furnaces: 1, at: index === 0 && cell ? [cell] : undefined, seconds: 30 });
        if (put.ok) {
          smeltedLoads.push(load);
          fuelLeft -= used;
          smeltedAt = put.at ?? smeltedAt ?? cell;
        } else notes.push(`${load.item} は焼かず（${String(put.text).slice(0, 70)}）`);
      }
    }
  }

  // 3. Throw (the drop's own way: a hole, the throw along the look, the check that it went in).
  const stats = { inside: 0, outside: 0, unverified: 0, lava: 0, level: 0 };
  let threat = false;
  let dropFailed: StepOutcome | null = null;
  if (plan.throw.length) {
    const thrown = await drop(ctx, { items: plan.throw, allowRaw: true, stats });
    if (!thrown.ok) {
      if (thrown.reason === 'threat_exposed') threat = true;
      else dropFailed = thrown;
      notes.push(threat ? '敵が近く捨てられず' : `捨てられず（${String(thrown.text).slice(0, 70)}）`);
    }
  }

  // 4. Take the ingots (the batch is waited for up to `seconds`; a longer one is left and its place said).
  if (smeltedAt && smeltedLoads.length) {
    const sub: StepContext = { ...ctx, deadline: Math.min(ctx.deadline, Date.now() + (seconds + 25) * 1000) };
    const taken = await furnace(sub, { at: smeltedAt, take: 'output', waitDue: seconds });
    const ingots = smeltedLoads.map(load => ({ item: load.item === 'raw_iron' ? 'iron_ingot' : 'gold_ingot', count: load.count }));
    if (taken.ok && !/まだ/u.test(String(taken.text))) did.push(`焼いた ${smeltedLoads.map(l => `${l.item}×${l.count}`).join('・')}→${fmt(ingots)}`);
    else {
      did.push(`焼き始めた ${fmt(smeltedLoads)}`);
      notes.push(`炉 (${smeltedAt.x},${smeltedAt.y},${smeltedAt.z}) の中で焼いている最中（後で furnace take で取る）`);
    }
  }

  const after = countsOf(stacksNow(bot));
  const threw = plan.throw.map(entry => ({ item: entry.item, count: Math.max(0, (before.get(entry.item) ?? 0) - (after.get(entry.item) ?? 0)) })).filter(entry => entry.count > 0);
  const parts: string[] = [];
  if (threw.length) parts.push(`捨てた ${fmt(threw)}`);
  parts.push(...did);
  const freeAfter = freeSlots(bot);
  const hole = stats.inside + stats.outside + stats.unverified + stats.lava > 0 || threw.length ? `。${stats.lava ? `溶岩へ ${stats.lava} 個・` : ''}穴の中 ${stats.inside} 個・外 ${stats.outside} 個${stats.unverified ? `（確かめられず ${stats.unverified} 個）` : ''}` : '';
  const tail = `${hole}${notes.length ? `。${notes.join('。')}` : ''}`;
  if (freeAfter <= freeBefore && !threw.length && !did.length) {
    const reason = threat ? 'threat_exposed' : dropFailed ? (/limit_time|timeout/u.test(String(dropFailed.reason)) ? 'timeout' : String(dropFailed.reason ?? 'no_room')) : 'no_room';
    return stopped(bot, reason, `tidy 止まった ${reason}: ${line(freeAfter, parts, tail)}`);
  }
  return { ok: true, text: `tidy 済 ${line(freeAfter, parts, tail)}` };
}
