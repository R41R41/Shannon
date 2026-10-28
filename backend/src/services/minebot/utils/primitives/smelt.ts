import { type Cell } from '../localMap.js';
import { fuelFor } from '../fuelValues.js';
import { blockAt, cellText, findItem, inventoryCount, placeText, stopped, type StepContext, type StepOutcome } from './common.js';
import { furnaceWork, type FurnaceLook } from './furnace.js';
import { canWorkOn, getNear } from './getNear.js';
import { placeNearby } from './placeSpot.js';
import { withProgress } from './progressUnits.js';
import type { WayNotes } from './walk.js';

/**
 * smelt: a load into furnaces, and the hand is over (hands-contract.md 6). The planner says what to smelt, how many furnaces to split it over, which
 * furnaces (`at`; with none, the hand puts down furnaces it carries) and the fuel. The body goes to each furnace, puts its share of the input
 * (every kind of input in its own furnaces: one furnace takes one kind) and the fuel, and goes on: it does not wait for the batch and does
 * not take it out (the furnace hand, op take, does). Each batch is written in `bot.activeFurnaces`, which the observation's jobs, the
 * marks' "焼き上がり n 秒後", the `furnace:x,y,z` condition and the body's "furnace.done" event read. A furnace is given no more input than
 * its fuel smelts; what is held back is said (`fuel_short`) and stays in the pack.
 */
export interface SmeltArgs { items: Array<{ item: string; count?: number }>; fuel?: string; fuelCount?: number; furnaces?: number; at?: Cell[]; seconds?: number }

const FURNACE_KINDS = new Set(['furnace', 'blast_furnace', 'smoker']);
const DEFAULT_SECONDS = 30;
const clamp = (value: number, least: number, most: number) => Math.max(least, Math.min(most, value));

interface Load { item: string; count: number }

/** The share of each kind: every kind gets a furnace, the rest go to the kind with the biggest share per furnace; a kind's count is split as evenly as it goes. */
function split(items: Load[], furnaces: number): Load[] {
  const shares = items.map(() => 1);
  for (let spare = furnaces - items.length; spare > 0; spare--) {
    let widest = 0;
    items.forEach((entry, index) => { if (entry.count / shares[index] > items[widest].count / shares[widest] + 1e-9) widest = index; });
    shares[widest]++;
  }
  const loads: Load[] = [];
  items.forEach((entry, index) => {
    const n = Math.min(shares[index], entry.count);
    const base = Math.floor(entry.count / n), extra = entry.count % n;
    for (let part = 0; part < n; part++) loads.push({ item: entry.item, count: base + (part < extra ? 1 : 0) });
  });
  return loads;
}

const fail = (bot: any, reason: string, text: string, at?: Cell, code?: string): StepOutcome => ({ ...stopped(bot, reason, `smelt 止まった ${reason}: ${text}`, at), ...(code ? { code } : {}) });

/**
 * Continue contracts (1): progress in items (`done` the input put into furnaces, `left` what was asked and not put). There is no "already": the input is not in the pack, or a
 * furnace holds another kind, or it is put (an input the pack lacks stops as failed with the code `missing_item`, nothing put).
 */
export async function smelt(ctx0: StepContext, args: SmeltArgs): Promise<StepOutcome> {
  const tally = { put: 0 };
  const asked = (args.items ?? []).reduce((sum, entry) => sum + (Number.isFinite(Math.round(Number(entry.count))) ? Math.max(0, Math.round(Number(entry.count))) : 0), 0);
  return withProgress(() => smeltInto(ctx0, args, tally), () => ({ unit: 'item', done: tally.put, left: Math.max(0, asked - tally.put) }));
}

async function smeltInto(ctx0: StepContext, args: SmeltArgs, tally: { put: number }): Promise<StepOutcome> {
  const bot = ctx0.bot;
  const seconds = clamp(Number(args.seconds ?? DEFAULT_SECONDS), 5, 60);
  const ctx: StepContext = { ...ctx0, deadline: Math.min(ctx0.deadline, Date.now() + seconds * 1000) };
  // The input: one entry per kind.
  const wanted = new Map<string, number>();
  for (const entry of args.items ?? []) {
    const n = Math.round(Number(entry.count));
    if (!entry.item || !Number.isFinite(n) || n < 1) return fail(bot, 'missing', `items には物の名前と 1 以上の個数が要る（${entry.item ?? '?'}）`);
    wanted.set(entry.item, (wanted.get(entry.item) ?? 0) + n);
  }
  if (!wanted.size || wanted.size > 4) return fail(bot, 'missing', 'items は 1〜4 種類');
  const items: Load[] = [...wanted.entries()].map(([item, count]) => ({ item, count }));
  const lacking = items.filter(entry => inventoryCount(bot, entry.item) < entry.count);
  if (lacking.length) return fail(bot, 'missing', `入れる物が足りない: ${lacking.map(entry => `${entry.item}×${entry.count - inventoryCount(bot, entry.item)}（持っている ${inventoryCount(bot, entry.item)}／入れたい ${entry.count}）`).join('・')}（何も入れていない）`, undefined, 'missing_item');

  // How many furnaces, and the share of each.
  const asked = clamp(Math.round(Number(args.furnaces ?? 1)), 1, 4);
  if (items.length > asked) return fail(bot, 'no_furnace', `かまど 1 基に入る材料は 1 種類。${items.length} 種類（${items.map(entry => entry.item).join('・')}）には furnaces を ${items.length} 以上にする（今 ${asked}）`);
  const loads = split(items, asked);
  const biggest = loads.reduce((most, load) => Math.max(most, load.count), 0);
  if (biggest > 64) return fail(bot, 'no_furnace', `かまど 1 基の材料の枠は 64 個まで（${asked} 基では 1 基に ${biggest} 個）。furnaces を増やす`);

  // Which furnaces: the planner's cells, then furnaces from the pack. None is searched for.
  const given = (args.at ?? []).slice(0, loads.length);
  for (const cell of given) {
    const there = blockAt(bot, cell);
    if (!there) return fail(bot, 'no_furnace', `${placeText(bot, cell)} は未ロード`, cell);
    if (!FURNACE_KINDS.has(there.name)) return fail(bot, 'no_furnace', `${placeText(bot, cell)} は ${there.name}（かまどではない）`, cell);
  }
  const toPlace = loads.length - given.length;
  if (toPlace > inventoryCount(bot, 'furnace')) {
    return fail(bot, 'no_furnace', `かまどが ${loads.length} 基要るが、at は ${given.length} 基で、置ける furnace は持ち物に ${inventoryCount(bot, 'furnace')} 個`);
  }
  // The fuel: what each furnace is given. With no cell of the planner's every furnace is a new, empty one, and a fuel that is short is known now.
  const fuel = args.fuel || undefined;
  const fuelEach = loads.map(load => fuel ? (args.fuelCount !== undefined ? 0 : fuelFor(fuel, load.count)) : 0);
  if (fuel && args.fuelCount !== undefined) {
    const total = Math.max(0, Math.round(Number(args.fuelCount)));
    loads.forEach((_, index) => { fuelEach[index] = Math.floor(total / loads.length) + (index < total % loads.length ? 1 : 0); });
  }
  if (fuel && !findItem(bot, fuel)) return fail(bot, 'fuel_short', `燃料の ${fuel} を持っていない（何も入れていない）`);
  const carriedFuel = fuel ? inventoryCount(bot, fuel) : 0;
  if (fuel && given.length === 0 && carriedFuel < fuelEach.reduce((sum, n) => sum + n, 0)) {
    return fail(bot, 'fuel_short', `燃料 ${fuel} は ${fuelEach.reduce((sum, n) => sum + n, 0)} 個要る（${loads.map(load => `${load.item}×${load.count}`).join('・')} を焼くのに）が、持っているのは ${carriedFuel} 個（何も入れていない）`);
  }

  const notes: WayNotes = { opened: [], leaves: 0 };
  const placed: Cell[] = [];
  for (let n = 0; n < toPlace; n++) {
    const put = await placeNearby(ctx, 'furnace', [...given, ...placed]);
    if ('fail' in put) return fail(bot, 'no_furnace', `furnace を置けなかった: ${put.fail.text}${placed.length ? `（先に ${placed.map(cellText).join('・')} に置いた）` : ''}`);
    placed.push(put.cell);
  }
  const cells = [...given, ...placed];

  const done: Array<{ cell: Cell; load: Load; moved: number; fuel: number; look?: FurnaceLook }> = [];
  const heldBack: Array<{ cell: Cell; item: string; count: number }> = [];
  const blocked: string[] = [];
  const doneText = () => done.length ? `ここまでに ${done.map(entry => `${cellText(entry.cell)} に ${entry.load.item}×${entry.moved}`).join('、')} を入れた` : '何も入れていない';
  for (let index = 0; index < loads.length; index++) {
    const cell = cells[index], load = loads[index];
    if (Date.now() >= ctx.deadline) return fail(bot, 'limit_time', `${seconds} 秒の上限に着いた（${doneText()}）`, cell);
    if (!canWorkOn(bot, cell, 4.6)) {
      const near = await getNear(ctx, cell, notes, 4.2, Math.max(1000, ctx.deadline - Date.now()));
      if (!near.near) {
        return fail(bot, near.timedOut || Date.now() >= ctx.deadline ? 'limit_time' : 'unreachable',
          `${placeText(bot, cell)} のかまどに近づけない（${near.timedOut ? '時間切れ' : near.stuck ? '4 秒進めず' : '道が無いか、見える所に立てない'}。${doneText()}）`, cell);
      }
    }
    const fuelNow = fuel ? Math.min(fuelEach[index], inventoryCount(bot, fuel)) : 0;
    const worked = await furnaceWork(ctx, { at: cell, put: { item: load.item, count: load.count },
      ...(fuel && fuelNow > 0 ? { fuel: { item: fuel, count: fuelNow } } : {}), limitByFuel: true });
    if (!worked.outcome.ok) {
      const reason = worked.outcome.reason === 'not_furnace' ? 'no_furnace' : worked.outcome.reason === 'missing_item' ? 'missing' : 'unreachable';
      return fail(bot, reason, `${worked.outcome.text}（${doneText()}）`, cell);
    }
    if (worked.occupiedBy) { blocked.push(`${cellText(cell)} には既に ${worked.occupiedBy} が入っていて ${load.item} は入らない`); continue; }
    if (worked.moved.heldBack > 0) heldBack.push({ cell, item: load.item, count: worked.moved.heldBack });
    tally.put += worked.moved.input;
    done.push({ cell, load, moved: worked.moved.input, fuel: worked.moved.fuel, look: worked.look });
  }

  const put = new Map<string, number>();
  for (const entry of done) put.set(entry.load.item, (put.get(entry.load.item) ?? 0) + entry.moved);
  const putText = [...put.entries()].map(([item, count]) => `${item}×${count}`).join('・');
  const fuelPut = done.reduce((sum, entry) => sum + entry.fuel, 0);
  const wherePut = done.filter(entry => entry.moved > 0).map(entry => cellText(entry.cell)).join('・');
  const placedText = placed.length ? `。置いたかまど ${placed.map(cellText).join('・')}` : '';
  if (blocked.length) return fail(bot, 'no_furnace', `${blocked.join('、')}（${doneText()}）${placedText}`, cells[0]);
  if (heldBack.length) {
    const held = new Map<string, number>();
    for (const entry of heldBack) held.set(entry.item, (held.get(entry.item) ?? 0) + entry.count);
    return fail(bot, 'fuel_short', `燃料が足りず入れたのは ${putText || 'なし'} だけ（入れていない: ${[...held.entries()].map(([item, count]) => `${item}×${count}`).join('・')} は持ち物に残した。燃料${fuel ? ` ${fuel}` : ''} を足してから furnace の手で入れる）${placedText}`, heldBack[0].cell);
  }
  const ready = Math.max(0, ...done.map(entry => entry.look?.remainingSec ?? 0));
  const idle = done.find(entry => entry.look?.input && !entry.look.fuel && !entry.look.burning);
  if (idle) return fail(bot, 'fuel_short', `${cellText(idle.cell)} のかまどに燃料が無く、燃えてもいない（このままでは焼けない）。入れたのは ${putText}${placedText}`, idle.cell);
  const fuelText = fuelPut ? `・燃料 ${fuel}×${fuelPut}` : '';
  return { ok: true, at: done[done.length - 1]?.cell, text: `smelt 済 ${putText} を ${done.length} 基に入れた（${wherePut}）${fuelText}・焼き上がり 約 ${Math.round(ready)} 秒後${placedText}` };
}
