import { scanLoadedBlocks } from '../loadedBlockScan.js';
import { feetCell, relativeWords, type Cell } from '../localMap.js';
import { cellText, eyeDistance, guard, inventoryCount, stopped, StepStopped, USE_REACH, wait, type StepContext, type StepOutcome } from './common.js';
import { withProgress } from './progressUnits.js';
import { craftEvents } from './craftEvents.js';
import { withWoodForms } from './woodRecipes.js';
import { resolveWoodName, roomFor, syncPack } from './craftSync.js';

/** Between two rounds of a craft in the hand the server's answer is let settle this long (see the loop below). */
export const ROUND_SETTLE_MS = 250;

/**
 * craft: `count` of an item (design mb-llm-centric 2.3). A recipe of the 2x2 grid is made in the hand; one that needs the 3x3 uses a
 * crafting table within reach (4.5 m from the eyes) and is refused without one: no table is placed or walked to. A shortfall is said
 * item by item, from the recipe nearest to what is carried.
 */
export interface CraftArgs { item: string; count?: number }

export function tableInReach(bot: any): any {
  let hits: Array<{ position: any }> = [];
  try { hits = scanLoadedBlocks(bot, ['crafting_table'], { maxDistance: 8, maxHits: 4 }).hits; } catch { hits = []; }
  for (const hit of hits) {
    const cell = { x: hit.position.x, y: hit.position.y, z: hit.position.z };
    if (eyeDistance(bot, cell) <= USE_REACH) return bot.blockAt(hit.position);
  }
  return null;
}
export function nearestTable(bot: any): Cell | null {
  try {
    const hit = scanLoadedBlocks(bot, ['crafting_table'], { maxDistance: 48, maxHits: 1 }).hits[0];
    return hit ? { x: hit.position.x, y: hit.position.y, z: hit.position.z } : null;
  } catch { return null; }
}

/** What one recipe still wants for `times` crafts: "stick 1（持っている 1／要る 2）". */
function shortfall(bot: any, recipe: any, times: number): Array<{ name: string; have: number; need: number }> {
  const wants = new Map<number, number>();
  for (const entry of recipe.delta ?? []) if (entry.count < 0) wants.set(entry.id, (wants.get(entry.id) ?? 0) - entry.count * times);
  const out: Array<{ name: string; have: number; need: number }> = [];
  for (const [id, need] of wants) {
    const name = String(bot.registry?.items?.[id]?.name ?? id);
    const have = inventoryCount(bot, name);
    if (have < need) out.push({ name, have, need });
  }
  return out;
}

/**
 * What the planner can do about a shortfall, said with it (S5 rig, c1, 2026-11-05: a head asked craft ender_eye 12 with 11 powder and three rods in the pack, was told
 * only "blaze_powder 1 short", and went on to craft one eye at a time, a pearl and a powder each, for a quarter of an hour): how many the pack makes now, and for each
 * short ingredient that the pack itself makes (in the hand or at the table in reach), how many of it the pack holds the makings of and the craft that makes it.
 */
export function shortfallHelp(bot: any, recipe: any, short: Array<{ name: string; have: number; need: number }>, perCraft: number, table: any): string {
  const parts: string[] = [];
  let rounds = Infinity;
  for (const entry of recipe.delta ?? []) {
    if (entry.count >= 0) continue;
    const name = String(bot.registry?.items?.[entry.id]?.name ?? entry.id);
    rounds = Math.min(rounds, Math.floor(inventoryCount(bot, name) / -entry.count));
  }
  if (Number.isFinite(rounds) && rounds > 0) parts.push(`今作れるのは ${rounds * perCraft} 個`);
  for (const lack of short) {
    const id = bot.registry?.itemsByName?.[lack.name]?.id;
    if (typeof id !== 'number') continue;
    let recipes: any[] = [];
    try { recipes = [...(bot.recipesAll?.(id, null, null) ?? []), ...(table ? bot.recipesAll?.(id, null, table) ?? [] : [])]; } catch { recipes = []; }
    for (const sub of recipes) {
      const each = Math.max(1, sub.result?.count ?? 1);
      let subRounds = Infinity;
      const from: string[] = [];
      for (const entry of sub.delta ?? []) {
        if (entry.count >= 0) continue;
        const name = String(bot.registry?.items?.[entry.id]?.name ?? entry.id);
        subRounds = Math.min(subRounds, Math.floor(inventoryCount(bot, name) / -entry.count));
        from.push(`${name}×${-entry.count}`);
      }
      if (!Number.isFinite(subRounds) || subRounds < 1) continue;
      const missing = lack.need - lack.have;
      parts.push(`${lack.name} は ${from.join('+')} から ${each} 個ずつ作れる（持ち物で ${subRounds * each} 個まで。足りない ${missing} 個は craft item=${lack.name} count=${Math.ceil(missing / each) * each}、まとめては make item=${recipe.result?.id !== undefined ? String(bot.registry?.items?.[recipe.result.id]?.name ?? '') : ''} count=…）`);
      break;
    }
  }
  return parts.length ? `。${parts.join('。')}` : '';
}

/**
 * Continue contracts (1): progress in items (`done` what the pack gained of the item, `left` the count not yet made). `count` is how many MORE to make: a pack that
 * holds that many already is not "already".
 */
export async function craft(ctx: StepContext, input: CraftArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  // 12:58Z of task 193a86b0: 「craft item=planks」 was refused twice; a generic wood name is the kind the pack holds.
  const args: CraftArgs = { ...input, item: resolveWoodName(bot, input.item) };
  const wanted = Math.max(1, Math.min(64 * 9, Math.round(args.count ?? 1)));
  // The pack as the server holds it before the progress is counted from it and the recipe chosen (`craftSync.ts`, task 193a86b0): a copy
  // that said 0 planks where the server held 5 would count +5 made by nothing.
  if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow); } catch { /* closing */ } await wait(ctx, 100); }
  await syncPack(bot);
  const had = inventoryCount(bot, args.item);
  return withProgress(() => craftItem(ctx, args), () => {
    const gained = Math.max(0, inventoryCount(bot, args.item) - had);
    return { unit: 'item', done: gained, left: Math.max(0, wanted - gained) };
  });
}

async function craftItem(ctx: StepContext, args: CraftArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const item = bot.registry?.itemsByName?.[args.item];
  if (!item) return stopped(bot, 'invalid_item', `${args.item} は物の名前ではない`);
  const count = Math.max(1, Math.min(64 * 9, Math.round(args.count ?? 1)));
  const table = tableInReach(bot);
  const all: any[] = withWoodForms(bot, args.item, [...(bot.recipesAll?.(item.id, null, null) ?? []), ...(table ? bot.recipesAll?.(item.id, null, table) ?? [] : [])]);
  if (!all.length) {
    const needsTable = (bot.recipesAll?.(item.id, null, true) ?? []).length > 0;
    if (needsTable) {
      const near = nearestTable(bot);
      const feet = feetCell(bot)!;
      return stopped(bot, 'no_table_in_reach', `${args.item} は作業台が要る。手の届く所（${USE_REACH}m）に作業台が無い${near ? `（いちばん近い作業台 ${cellText(near)} ${relativeWords(feet, near)}）` : '（48m 内に無い）'}`);
    }
    return stopped(bot, 'no_recipe', `${args.item} の作り方が無い（かまどで焼く物か、作れない物）`);
  }
  const perCraft = (recipe: any) => Math.max(1, recipe.result?.count ?? 1);
  const ready = all.find(recipe => shortfall(bot, recipe, Math.ceil(count / perCraft(recipe))).length === 0);
  if (!ready) {
    const best = all.map(recipe => ({ recipe, short: shortfall(bot, recipe, Math.ceil(count / perCraft(recipe))) }))
      .sort((a, b) => a.short.reduce((s, x) => s + x.need - x.have, 0) - b.short.reduce((s, x) => s + x.need - x.have, 0))[0];
    return stopped(bot, 'missing_material', `${args.item}×${count} の材料が足りない: ${best.short.map(x => `${x.name} ${x.need - x.have}（持っている ${x.have}／要る ${x.need}）`).join('、')}${shortfallHelp(bot, best.recipe, best.short, perCraft(best.recipe), table)}`);
  }
  const usesTable = ready.requiresTable === true;
  const times = Math.ceil(count / perCraft(ready));
  if (!roomFor(bot, args.item, ready, times)) return stopped(bot, 'full', `持ち物が満杯で ${args.item} を入れる所が無い（何も作っていない。要らない物を drop するか箱へ）`);
  const before = inventoryCount(bot, args.item);
  if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow); } catch { /* closing */ } await wait(ctx, 100); }
  const record = craftEvents(ctx, ready, args.item, false);
  try {
    try {
      if (usesTable || times === 1) {
        const made = await guard(ctx, Promise.resolve(bot.craft(ready, times, usesTable ? table : undefined)), 4000 + times * 400);
        if (!made) return stopped(bot, 'timeout', `${args.item} を作る途中で時間切れ（今 ${inventoryCount(bot, args.item)} 個）`);
      } else {
        // In the hand, one round at a time: mineflayer's own loop starts the next round before the first one's result has settled, and a second round of a recipe of two
        // ingredients lost its materials and the results (lab: ender_eye x6 took two pairs of pearl and powder, left no eye and ended "missing ingredient"; rounds of one made every eye).
        for (let round = 0; round < times; round++) {
          const roundStart = inventoryCount(bot, args.item);
          const made = await guard(ctx, Promise.resolve(bot.craft(ready, 1, undefined)), 4000);
          if (!made) return stopped(bot, 'timeout', `${args.item} を作る途中で時間切れ（${round}/${times} 回目まで。今 ${inventoryCount(bot, args.item)} 個）`);
          if (round + 1 < times) await wait(ctx, ROUND_SETTLE_MS);
          if (inventoryCount(bot, args.item) <= roundStart && round + 1 < times) await wait(ctx, ROUND_SETTLE_MS);
        }
      }
    } catch (error) {
      if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error;
      await syncPack(bot);
      return stopped(bot, roomFor(bot, args.item) ? 'craft_failed' : 'full', `${args.item} を作れなかった: ${String((error as Error)?.message ?? error).slice(0, 100)}`);
    }
    await wait(ctx, 150);
    let after = inventoryCount(bot, args.item);
    // The copy may say "not more" of what the server gave, or more than it gave: the server's pack decides.
    if (after <= before && await syncPack(bot)) after = inventoryCount(bot, args.item);
    if (after <= before) return stopped(bot, roomFor(bot, args.item) ? 'craft_failed' : 'full', `${args.item} が増えていない（前 ${before} 個、今 ${after} 個。持ち物はサーバーと照合した）`);
    return { ok: true, text: `${args.item} を ${after - before} 個作った（今 ${after} 個${usesTable ? '、作業台で' : ''}）` };
  } finally { record(); }
}
