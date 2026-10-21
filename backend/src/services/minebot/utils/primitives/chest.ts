import { type Cell } from '../localMap.js';
import { blockAt, cellText, eyeDistance, freeSlots, guard, inventoryCount, placeText, stopped, StepStopped, USE_REACH, wait,
  type StepContext, type StepOutcome } from './common.js';

/**
 * chest: open the container given and take or put what is named (design mb-llm-centric 2.3). Whose chest it is (a village's) is the
 * planner's to weigh: nothing is refused for it. The answer always lists what the container holds afterwards.
 */
export interface ChestArgs { at: Cell; take?: Array<{ item: string; count?: number }>; put?: Array<{ item: string; count?: number }>; takeAll?: boolean }

const CONTAINERS = /^(chest|trapped_chest|barrel|ender_chest|.*shulker_box)$/u;

/**
 * How many of an item the container holds, and how many the pack holds as the open window shows it. The pack (bot.inventory) is only
 * brought up to date when the window closes (mineflayer copies the window's inventory slots then), so counting it while the window is open
 * said "iron_pickaxe×0 を取った" for everything taken (run 28, 599 s, the smith's chest). The window's own slots are counted instead.
 */
function inContainer(window: any, name: string): number {
  return (window.containerItems?.() ?? []).filter((item: any) => item.name === name).reduce((sum: number, item: any) => sum + item.count, 0);
}
function inPack(bot: any, window: any, name: string): number {
  if (typeof window.items === 'function') return (window.items() ?? []).filter((item: any) => item.name === name).reduce((sum: number, item: any) => sum + item.count, 0);
  return inventoryCount(bot, name);
}

function contents(window: any): string {
  const counts = new Map<string, number>();
  for (const item of window.containerItems?.() ?? []) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return [...counts.entries()].map(([name, count]) => `${name}×${count}`).join(' ') || '空';
}

export async function chest(ctx: StepContext, args: ChestArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const cell = args.at;
  const block = blockAt(bot, cell);
  if (!block) return stopped(bot, 'unloaded', `${placeText(bot, cell)} は未ロード`, cell);
  // Scene replay 2026-10-21: a furnace was opened with chest three times in seven; the hand for it is furnace (op=take).
  if (!CONTAINERS.test(block.name)) return stopped(bot, 'not_container', `${placeText(bot, cell)} は ${block.name}（箱・樽ではない${/furnace|smoker/u.test(block.name) ? '。かまどは furnace の手' : ''}）`, cell);
  const distance = eyeDistance(bot, cell);
  if (distance > USE_REACH) return stopped(bot, 'out_of_reach', `${placeText(bot, cell)} の ${block.name} に届かない（目から${distance.toFixed(1)}m、${USE_REACH}m まで）`, cell);
  if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow); } catch { /* closing */ } await wait(ctx, 100); }
  let window: any;
  try {
    const opened = await guard(ctx, Promise.resolve(bot.openContainer(block)), 4000);
    if (!opened) return stopped(bot, 'not_opened', `${placeText(bot, cell)} の ${block.name} が開かなかった（時間切れ。上が塞がっているか、視線の途中に何かある）`, cell);
    window = opened.value;
  } catch (error) {
    if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error;
    return stopped(bot, 'not_opened', `${placeText(bot, cell)} の ${block.name} が開かなかった: ${String((error as Error)?.message ?? error).slice(0, 80)}`, cell);
  }
  const notes: string[] = [];
  try {
    const before = contents(window);
    // takeAll: every kind inside, as far as the pack has room.
    const wanted = args.takeAll ? [...new Set((window.containerItems?.() ?? []).map((item: any) => String(item.name)))].map(item => ({ item: item as string, count: undefined as number | undefined })) : args.take ?? [];
    for (const want of wanted) {
      const inside = (window.containerItems?.() ?? []).filter((item: any) => item.name === want.item);
      const available = inside.reduce((sum: number, item: any) => sum + item.count, 0);
      if (!available) { notes.push(`${want.item} は入っていない`); continue; }
      if (freeSlots(bot) === 0 && inPack(bot, window, want.item) === 0) { notes.push(`${want.item} を取る空きが持ち物に無い`); continue; }
      const count = Math.min(available, Math.max(1, Math.round(want.count ?? available)));
      const had = inPack(bot, window, want.item);
      let failed = '';
      try { await guard(ctx, Promise.resolve(window.withdraw(inside[0].type, null, count)), 4000); }
      catch (error) { if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error; failed = String((error as Error)?.message ?? error).slice(0, 60); }
      // Taken: what left the container, or what came into the pack's slots of the window (whichever the window shows more of).
      const taken = Math.max(available - inContainer(window, want.item), inPack(bot, window, want.item) - had, 0);
      notes.push(`${want.item}×${taken} を取った${taken < count ? `（頼んだのは ${count}${failed ? `。${failed}` : ''}）` : ''}`);
    }
    for (const give of args.put ?? []) {
      const have = inPack(bot, window, give.item);
      if (!have) { notes.push(`${give.item} を持っていない`); continue; }
      const count = Math.min(have, Math.max(1, Math.round(give.count ?? have)));
      const item = (typeof window.items === 'function' ? window.items() : bot.inventory?.items?.() ?? []).find((entry: any) => entry.name === give.item);
      const held = inContainer(window, give.item);
      try { await guard(ctx, Promise.resolve(window.deposit(item.type, null, count)), 4000); }
      catch (error) { if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error; }
      const put = Math.max(inContainer(window, give.item) - held, have - inPack(bot, window, give.item), 0);
      notes.push(`${give.item}×${put} を入れた`);
    }
    await wait(ctx, 150);
    const after = contents(window);
    const items = after === '空' ? [] : after.split(' ').slice(0, 27);
    return { ok: true, at: cell, data: { container: { at: cell, kind: block.name, items } }, text: `${notes.length ? `${notes.join('、')}。` : ''}${cellText(cell)} の ${block.name} の中身: ${after}${notes.length && before !== after ? `（前は ${before}）` : ''}` };
  } finally { try { window.close(); } catch { /* closed */ } }
}
