import { scanLoadedBlocks } from '../loadedBlockScan.js';
import { feetCell, relativeWords, type Cell } from '../localMap.js';
import { cellText, eyeDistance, guard, inventoryCount, stopped, StepStopped, USE_REACH, wait, type StepContext, type StepOutcome } from './common.js';

/**
 * craft: `count` of an item (design mb-llm-centric 2.3). A recipe of the 2x2 grid is made in the hand; one that needs the 3x3 uses a
 * crafting table within reach (4.5 m from the eyes) and is refused without one: no table is placed or walked to. A shortfall is said
 * item by item, from the recipe nearest to what is carried.
 */
export interface CraftArgs { item: string; count?: number }

function tableInReach(bot: any): any {
  let hits: Array<{ position: any }> = [];
  try { hits = scanLoadedBlocks(bot, ['crafting_table'], { maxDistance: 8, maxHits: 4 }).hits; } catch { hits = []; }
  for (const hit of hits) {
    const cell = { x: hit.position.x, y: hit.position.y, z: hit.position.z };
    if (eyeDistance(bot, cell) <= USE_REACH) return bot.blockAt(hit.position);
  }
  return null;
}
function nearestTable(bot: any): Cell | null {
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

export async function craft(ctx: StepContext, args: CraftArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const item = bot.registry?.itemsByName?.[args.item];
  if (!item) return stopped(bot, 'invalid_item', `${args.item} は物の名前ではない`);
  const count = Math.max(1, Math.min(64 * 9, Math.round(args.count ?? 1)));
  const table = tableInReach(bot);
  const all: any[] = [...(bot.recipesAll?.(item.id, null, null) ?? []), ...(table ? bot.recipesAll?.(item.id, null, table) ?? [] : [])];
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
    return stopped(bot, 'missing_material', `${args.item}×${count} の材料が足りない: ${best.short.map(x => `${x.name} ${x.need - x.have}（持っている ${x.have}／要る ${x.need}）`).join('、')}`);
  }
  const usesTable = ready.requiresTable === true;
  const times = Math.ceil(count / perCraft(ready));
  const before = inventoryCount(bot, args.item);
  if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow); } catch { /* closing */ } await wait(ctx, 100); }
  try {
    const made = await guard(ctx, Promise.resolve(bot.craft(ready, times, usesTable ? table : undefined)), 4000 + times * 400);
    if (!made) return stopped(bot, 'timeout', `${args.item} を作る途中で時間切れ（今 ${inventoryCount(bot, args.item)} 個）`);
  } catch (error) {
    if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error;
    return stopped(bot, 'craft_failed', `${args.item} を作れなかった: ${String((error as Error)?.message ?? error).slice(0, 100)}`);
  }
  await wait(ctx, 150);
  const after = inventoryCount(bot, args.item);
  if (after <= before) return stopped(bot, 'craft_failed', `${args.item} が増えていない（前 ${before} 個、今 ${after} 個）`);
  return { ok: true, text: `${args.item} を ${after - before} 個作った（今 ${after} 個${usesTable ? '、作業台で' : ''}）` };
}
