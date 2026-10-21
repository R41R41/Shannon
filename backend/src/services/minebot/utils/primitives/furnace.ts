import { type Cell } from '../localMap.js';
import { blockAt, cellText, eyeDistance, findItem, guard, inventoryCount, placeText, stopped, StepStopped, USE_REACH, wait,
  type StepContext, type StepOutcome } from './common.js';

/**
 * furnace: at the furnace given, put the input and the fuel, or take out a slot (design mb-llm-centric 2.3). It is neither placed nor
 * walked to. The answer always says what the three slots hold afterwards, and when the batch will be done (also kept for the
 * observation: `bot.activeFurnaces`, the marks' "焼き上がり n 秒後").
 */
export interface FurnaceArgs { at: Cell; put?: { item: string; count?: number }; fuel?: { item: string; count?: number }; take?: 'output' | 'input' | 'fuel' | 'all' }

const KINDS = new Set(['furnace', 'blast_furnace', 'smoker']);
const slotText = (item: any) => item ? `${item.name}×${item.count}` : '空';

export async function furnace(ctx: StepContext, args: FurnaceArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const cell = args.at;
  const block = blockAt(bot, cell);
  if (!block) return stopped(bot, 'unloaded', `${placeText(bot, cell)} は未ロード`, cell);
  if (!KINDS.has(block.name)) return stopped(bot, 'not_furnace', `${placeText(bot, cell)} は ${block.name}（かまどではない）`, cell);
  const distance = eyeDistance(bot, cell);
  if (distance > USE_REACH) return stopped(bot, 'out_of_reach', `${placeText(bot, cell)} の ${block.name} に届かない（目から${distance.toFixed(1)}m、${USE_REACH}m まで）`, cell);
  if (args.put && !findItem(bot, args.put.item)) return stopped(bot, 'missing_item', `${args.put.item} を持っていない`, cell);
  if (args.fuel && !findItem(bot, args.fuel.item)) return stopped(bot, 'missing_item', `燃料の ${args.fuel.item} を持っていない`, cell);
  if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow); } catch { /* closing */ } await wait(ctx, 100); }
  let window: any;
  try {
    const opened = await guard(ctx, Promise.resolve(bot.openFurnace(block)), 4000);
    if (!opened) return stopped(bot, 'not_opened', `${placeText(bot, cell)} の ${block.name} が開かなかった（時間切れ。視線の途中に何かある）`, cell);
    window = opened.value;
  } catch (error) {
    if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error;
    return stopped(bot, 'not_opened', `${placeText(bot, cell)} の ${block.name} が開かなかった: ${String((error as Error)?.message ?? error).slice(0, 80)}`, cell);
  }
  const notes: string[] = [];
  try {
    if (args.take) {
      for (const slot of args.take === 'all' ? ['output', 'input', 'fuel'] : [args.take]) {
        const item = slot === 'output' ? window.outputItem() : slot === 'input' ? window.inputItem() : window.fuelItem();
        if (!item) continue;
        const taken = await guard(ctx, Promise.resolve(slot === 'output' ? window.takeOutput() : slot === 'input' ? window.takeInput() : window.takeFuel()), 3000);
        notes.push(taken ? `${slot === 'output' ? '出来上がり' : slot === 'input' ? '材料' : '燃料'}の ${item.name}×${item.count} を取った` : `${slot} を取れなかった（時間切れ）`);
      }
    }
    if (args.put) {
      const current = window.inputItem();
      if (current && current.name !== args.put.item) {
        notes.push(`材料の枠には既に ${current.name}×${current.count} があり、${args.put.item} は入れていない（先に take:"input"）`);
      } else {
        const have = inventoryCount(bot, args.put.item);
        const count = Math.min(have, Math.max(1, Math.round(args.put.count ?? have)), 64 - (current?.count ?? 0));
        const item = findItem(bot, args.put.item);
        if (count > 0 && item) {
          const done = await guard(ctx, Promise.resolve(window.putInput(item.type, null, count)), 3000);
          notes.push(done ? `${args.put.item}×${count} を入れた` : `${args.put.item} を入れられなかった（時間切れ）`);
        }
      }
    }
    if (args.fuel) {
      const current = window.fuelItem();
      if (current && current.name !== args.fuel.item) {
        notes.push(`燃料の枠には既に ${current.name}×${current.count} があり、${args.fuel.item} は入れていない`);
      } else {
        const have = inventoryCount(bot, args.fuel.item);
        const count = Math.min(have, Math.max(1, Math.round(args.fuel.count ?? 1)), 64 - (current?.count ?? 0));
        const item = findItem(bot, args.fuel.item);
        if (count > 0 && item) {
          const done = await guard(ctx, Promise.resolve(window.putFuel(item.type, null, count)), 3000);
          notes.push(done ? `燃料 ${args.fuel.item}×${count} を入れた` : `燃料を入れられなかった（時間切れ）`);
        }
      }
    }
    await wait(ctx, 200);
    const input = window.inputItem(), fuel = window.fuelItem(), output = window.outputItem();
    const burning = Number(window.fuel ?? 0) > 0;
    const secondsEach = block.name === 'furnace' ? 10 : 5;
    const progress = Number(window.progress ?? 0);
    const remaining = input ? Math.max(0, input.count * secondsEach - progress * secondsEach) : 0;
    const host = bot as { activeFurnaces?: any[] };
    host.activeFurnaces = (host.activeFurnaces ?? []).filter(f => !(f.pos.x === cell.x && f.pos.y === cell.y && f.pos.z === cell.z));
    if (input && (fuel || burning)) {
      host.activeFurnaces.push({ pos: { ...cell }, item: input.name, count: input.count, startedAt: Date.now(), readyAt: Date.now() + Math.round(remaining * 1000),
        dimension: String(bot.game?.dimension ?? '') });
    }
    const timing = input ? (fuel || burning ? `。焼き上がり 約${Math.round(remaining)}秒後` : '。燃料が無く、燃えてもいない（このままでは焼けない）') : '';
    const items = [input, fuel, output].filter(Boolean).map((item: any) => `×`);
    return { ok: true, at: cell, data: { container: { at: cell, kind: block.name, items } }, text: `${notes.length ? `${notes.join('、')}。` : ''}${cellText(cell)} の ${block.name}: 材料 ${slotText(input)}・燃料 ${slotText(fuel)}・出来上がり ${slotText(output)}${burning ? '（燃えている）' : ''}${timing}` };
  } finally { try { window.close(); } catch { /* closed */ } }
}
