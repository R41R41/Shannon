import { type Cell } from '../localMap.js';
import { itemsPerFuel } from '../fuelValues.js';
import { blockAt, cellText, eyeDistance, findItem, guard, inventoryCount, placeText, stopped, StepStopped, USE_REACH, wait,
  type StepContext, type StepOutcome } from './common.js';

/**
 * furnace: at the furnace given, put the input and the fuel, or take out a slot (design mb-llm-centric 2.3). It is neither placed nor
 * walked to. The answer always says what the three slots hold afterwards, and when the batch will be done (also kept for the
 * observation: `bot.activeFurnaces`, the marks' "焼き上がり n 秒後").
 *
 * `furnaceWork` is the same thing with its numbers kept (what went in, what the slots hold, how long the batch has to go): the smelt hand
 * (primitives/smelt) is built on it. `limitByFuel` (smelt only) puts the fuel first and then no more input than the fuel in the furnace
 * will smelt; the rest stays in the pack and is counted in `heldBack`.
 */
export interface FurnaceArgs {
  at: Cell; put?: { item: string; count?: number }; fuel?: { item: string; count?: number }; take?: 'output' | 'input' | 'fuel' | 'all';
  limitByFuel?: boolean;
}

/** What a furnace's three slots hold after the hand, and whether and for how long it burns. */
export interface FurnaceLook {
  kind: string;
  input: { name: string; count: number } | null; fuel: { name: string; count: number } | null; output: { name: string; count: number } | null;
  burning: boolean;
  /** Seconds until the input is smelted, by the furnace's own progress (null: nothing in the input). */
  remainingSec: number | null;
}
export interface FurnaceWork {
  outcome: StepOutcome;
  look?: FurnaceLook;
  /** What this call moved: input and fuel put in, and input left in the pack for want of fuel (limitByFuel). */
  moved: { input: number; fuel: number; heldBack: number };
  /** The input slot already held another item (or the furnace could not take the item): the name it holds. */
  occupiedBy?: string;
}

const KINDS = new Set(['furnace', 'blast_furnace', 'smoker']);
const slotText = (item: any) => item ? `${item.name}×${item.count}` : '空';
const stackOf = (item: any) => item ? { name: String(item.name), count: Number(item.count) } : null;

/** How many inputs the fuel in a furnace will smelt: its slot at the fuel's worth, and the piece burning now as one more. */
function fuelCoverage(window: any): number {
  const fuel = window.fuelItem();
  return (fuel ? fuel.count * itemsPerFuel(String(fuel.name)) : 0) + (Number(window.fuel ?? 0) > 0 ? 1 : 0);
}

export async function furnaceWork(ctx: StepContext, args: FurnaceArgs): Promise<FurnaceWork> {
  const bot = ctx.bot;
  const cell = args.at;
  const none = { input: 0, fuel: 0, heldBack: 0 };
  const fail = (outcome: StepOutcome): FurnaceWork => ({ outcome, moved: none });
  const block = blockAt(bot, cell);
  if (!block) return fail(stopped(bot, 'unloaded', `${placeText(bot, cell)} は未ロード`, cell));
  if (!KINDS.has(block.name)) return fail(stopped(bot, 'not_furnace', `${placeText(bot, cell)} は ${block.name}（かまどではない）`, cell));
  const distance = eyeDistance(bot, cell);
  if (distance > USE_REACH) return fail(stopped(bot, 'out_of_reach', `${placeText(bot, cell)} の ${block.name} に届かない（目から${distance.toFixed(1)}m、${USE_REACH}m まで）`, cell));
  if (args.put && !findItem(bot, args.put.item)) return fail(stopped(bot, 'missing_item', `${args.put.item} を持っていない`, cell));
  if (args.fuel && !findItem(bot, args.fuel.item)) return fail(stopped(bot, 'missing_item', `燃料の ${args.fuel.item} を持っていない`, cell));
  if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow); } catch { /* closing */ } await wait(ctx, 100); }
  let window: any;
  try {
    const opened = await guard(ctx, Promise.resolve(bot.openFurnace(block)), 4000);
    if (!opened) return fail(stopped(bot, 'not_opened', `${placeText(bot, cell)} の ${block.name} が開かなかった（時間切れ。視線の途中に何かある）`, cell));
    window = opened.value;
  } catch (error) {
    if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error;
    return fail(stopped(bot, 'not_opened', `${placeText(bot, cell)} の ${block.name} が開かなかった: ${String((error as Error)?.message ?? error).slice(0, 80)}`, cell));
  }
  const notes: string[] = [];
  const moved = { input: 0, fuel: 0, heldBack: 0 };
  let occupiedBy: string | undefined;
  const putFuel = async () => {
    if (!args.fuel) return;
    const current = window.fuelItem();
    if (current && current.name !== args.fuel.item) {
      notes.push(`燃料の枠には既に ${current.name}×${current.count} があり、${args.fuel.item} は入れていない`);
      return;
    }
    const have = inventoryCount(bot, args.fuel.item);
    const count = Math.min(have, Math.max(1, Math.round(args.fuel.count ?? 1)), 64 - (current?.count ?? 0));
    const item = findItem(bot, args.fuel.item);
    if (count > 0 && item) {
      const done = await guard(ctx, Promise.resolve(window.putFuel(item.type, null, count)), 3000);
      if (done) moved.fuel += count;
      notes.push(done ? `燃料 ${args.fuel.item}×${count} を入れた` : `燃料を入れられなかった（時間切れ）`);
    }
  };
  const putInput = async () => {
    if (!args.put) return;
    const current = window.inputItem();
    if (current && current.name !== args.put.item) {
      occupiedBy = String(current.name);
      notes.push(`材料の枠には既に ${current.name}×${current.count} があり、${args.put.item} は入れていない（先に take:"input"）`);
      return;
    }
    const have = inventoryCount(bot, args.put.item);
    const room = 64 - (current?.count ?? 0);
    const asked = Math.min(have, Math.max(1, Math.round(args.put.count ?? have)), room);
    // smelt: no more than the fuel in the furnace smelts (what is in the slot and burning, with the input already there).
    const smeltable = args.limitByFuel ? Math.max(0, Math.floor(fuelCoverage(window)) - (current?.count ?? 0)) : asked;
    const count = Math.min(asked, smeltable);
    if (args.limitByFuel && count < asked) moved.heldBack = asked - count;
    const item = findItem(bot, args.put.item);
    if (count > 0 && item) {
      const done = await guard(ctx, Promise.resolve(window.putInput(item.type, null, count)), 3000);
      if (done) moved.input += count;
      notes.push(done ? `${args.put.item}×${count} を入れた` : `${args.put.item} を入れられなかった（時間切れ）`);
    } else if (args.limitByFuel && moved.heldBack > 0) notes.push(`${args.put.item} は燃料が足りず入れていない（${moved.heldBack} 個）`);
  };
  try {
    if (args.take) {
      for (const slot of args.take === 'all' ? ['output', 'input', 'fuel'] : [args.take]) {
        const item = slot === 'output' ? window.outputItem() : slot === 'input' ? window.inputItem() : window.fuelItem();
        if (!item) continue;
        const taken = await guard(ctx, Promise.resolve(slot === 'output' ? window.takeOutput() : slot === 'input' ? window.takeInput() : window.takeFuel()), 3000);
        notes.push(taken ? `${slot === 'output' ? '出来上がり' : slot === 'input' ? '材料' : '燃料'}の ${item.name}×${item.count} を取った` : `${slot} を取れなかった（時間切れ）`);
      }
    }
    if (args.limitByFuel) { await putFuel(); await putInput(); } else { await putInput(); await putFuel(); }
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
    const items = [input, fuel, output].filter(Boolean).map((item: any) => `${item.name}×${item.count}`);
    const look: FurnaceLook = { kind: block.name, input: stackOf(input), fuel: stackOf(fuel), output: stackOf(output), burning, remainingSec: input ? remaining : null };
    return { moved, look, ...(occupiedBy ? { occupiedBy } : {}), outcome: { ok: true, at: cell, data: { container: { at: cell, kind: block.name, items } },
      text: `${notes.length ? `${notes.join('、')}。` : ''}${cellText(cell)} の ${block.name}: 材料 ${slotText(input)}・燃料 ${slotText(fuel)}・出来上がり ${slotText(output)}${burning ? '（燃えている）' : ''}${timing}` } };
  } finally { try { window.close(); } catch { /* closed */ } }
}

export async function furnace(ctx: StepContext, args: FurnaceArgs): Promise<StepOutcome> {
  return (await furnaceWork(ctx, args)).outcome;
}
