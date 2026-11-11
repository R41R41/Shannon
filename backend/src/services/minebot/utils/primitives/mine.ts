import { canHarvest } from '../toolChoice.js';
import { feetCell, peekMapStop, type Cell } from '../localMap.js';
import { closedWord } from '../actReport.js';
import { blockAt, cellNow, cellText, eyeDistance, findItem, freeSlots, inventoryCount, placeText, stopped, wait,
  type StepContext, type StepOutcome } from './common.js';
import { cheaperThanAsked, dig } from './dig.js';
import { pickup } from './pickup.js';
import { canWorkOn } from './getNear.js';
import { go } from './go.js';
import { dugCellName, noteDugCell } from './dugCells.js';
import { steadyInWater } from './footing.js';
import { withProgress } from './progressUnits.js';

/**
 * mine: a vein, cell by cell (hands-contract.md 3). The planner names the block (`iron_ore`; `deepslate_iron_ore` is the same kind of ore, so a vein
 * straddling y=0 is one vein) and the cells it starts from (`at`, one to four of that block; one is enough), and how many to take (the whole vein, up to
 * DEFAULT_COUNT, when not said). The body follows the cells of that same block that
 * touch the ones it has (a face, an edge or a corner), nearest first, digs each with the quickest tool that makes it drop, and picks
 * what falls. It looks for no other ore and no other block: the vein is what the planner's cells are joined to. A cell it cannot stand
 * near is gone to by the hand `go` (a way that digs only what `canDig` names, at most `maxDig` blocks; without them it digs no way at all), at most
 * `APPROACH_SECONDS` a cell, and the hand gives up when `UNREACHABLE_CELLS` cells have not been reached (run 40: 8 stops of 5 to 51 s, 194 s in all). It makes
 * no tunnel and no stair (those are repeat and go), and never digs a cell with lava beside it (water beside it is let in: the body steadies its feet and goes on).
 */
export interface MineArgs {
  block: string; at: Cell[]; count?: number; tool?: string; collect?: boolean; seconds?: number; canDig?: readonly string[]; maxDig?: number;
}

/** Cells of the vein the body will follow: a hard stop on a vein that does not end (a block as common as stone). */
const MAX_TRACE = 256;
const DEFAULT_COUNT = 24;
const DEFAULT_SECONDS = 60;
const DEFAULT_MAX_DIG = 16;
/** The rock a way to an ore is dug through, said in a stop that had no dig list (end1109o04). `go` reads the words stone and dirt as its categories, so cobblestone, sandstone, terracotta, clay and the like are dug as well; never an ore. */
const ROCK_ROAD = 'stone,dirt,gravel,andesite,diorite,granite,tuff,deepslate';
/** A start cell that is no longer the block (dug already, or one off): the same kind within this many cells of it starts the hand (run 5 q45: no_block at once). */
const START_TOLERANCE = 2;
/** Nothing within START_TOLERANCE: the same kind within this many cells of the first cell given starts the hand (a cube of 4,913 cells, read only on a miss), the nearest four. */
const START_WIDE = 8;
/** A drop the pick-up could not reach (it fell into a pocket the dig opened): walked to through natural rock, this long in all, this many drops, this long a drop, this much rock a drop at least. */
const POCKET_SECONDS_ALL = 20;
const POCKET_SECONDS_EACH = 8;
const POCKET_DROPS = 4;
const POCKET_MIN_DIG = 6;
/** A dig that fails this many times in a row stops the hand (something is wrong that another cell will not mend). */
const FAILS_IN_A_ROW = 3;
/** The longest the way to one cell may take, and how many cells that cannot be reached end the hand (the cells behind the same rock will not be reached either). */
const APPROACH_SECONDS = 15;
const UNREACHABLE_CELLS = 2;
const PICK_EVERY = 3;
const NEIGHBOURS: Array<[number, number, number]> = [];
for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) NEIGHBOURS.push([dx, dy, dz]);
const FACES: Array<[number, number, number]> = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

const keyOf = (cell: Cell) => `${cell.x},${cell.y},${cell.z}`;
const clamp = (value: number, least: number, most: number) => Math.max(least, Math.min(most, value));
const isLiquid = (name: string | undefined) => name === 'water' || name === 'lava';
const isLava = (name: string | undefined) => name === 'lava';
/** `deepslate_iron_ore` and `iron_ore` are one kind of ore (the same drop, the same tool): a vein at y=0 runs through both. */
const kindOf = (name: string | undefined): string | undefined => name === undefined ? undefined : /^deepslate_.+_ore$/u.test(name) ? name.slice('deepslate_'.length) : name;

function packCounts(bot: any): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of (bot.inventory?.items?.() ?? []) as Array<{ name: string; count: number }>) out.set(item.name, (out.get(item.name) ?? 0) + item.count);
  return out;
}
/** What the pack holds more of now than at `before`: "raw_iron×4". */
function gainedText(bot: any, before: Map<string, number>): string {
  const gained: string[] = [];
  for (const [name, count] of packCounts(bot)) if (count > (before.get(name) ?? 0)) gained.push(`${name}×${count - (before.get(name) ?? 0)}`);
  return gained.slice(0, 4).join(' ');
}
/** Whether the pack can take what this block drops: a free slot, or a stack of it that is not full. */
function roomForDrops(bot: any, block: string): boolean {
  if (freeSlots(bot) > 0) return true;
  const drops = ((bot.registry?.blocksByName?.[block]?.drops ?? []) as number[]).map(id => bot.registry?.items?.[id]).filter(Boolean);
  if (!drops.length) return false;
  return drops.some((drop: any) => ((bot.inventory?.items?.() ?? []) as any[]).some(held => held.name === drop.name && held.count < Number(drop.stackSize ?? 64)));
}

/**
 * Continue contracts (1): progress in items (`done` the cells of the vein dug, `left` the count not yet reached). `count` keeps its meaning (how many to take, from
 * the pack as it is: a pack that holds some already is not "already"); a vein that ran out is ok with `left` above 0.
 */
export async function mine(ctx0: StepContext, args: MineArgs): Promise<StepOutcome> {
  const result = { dug: 0, visited: 0, road: 0 };
  const count = clamp(Math.round(Number(args.count ?? DEFAULT_COUNT)), 1, 64);
  return withProgress(() => mineVein(ctx0, args, result), () => ({ unit: 'item', done: result.dug, left: Math.max(0, count - result.dug) }));
}

async function mineVein(ctx0: StepContext, args: MineArgs, result: { dug: number; visited: number; road: number }): Promise<StepOutcome> {
  const bot = ctx0.bot;
  const startedAt = Date.now();
  const block = String(args.block ?? '');
  const seconds = clamp(Number(args.seconds ?? DEFAULT_SECONDS), 5, 120);
  const ctx: StepContext = { ...ctx0, deadline: Math.min(ctx0.deadline, startedAt + seconds * 1000) };
  const count = clamp(Math.round(Number(args.count ?? DEFAULT_COUNT)), 1, 64);
  const collect = args.collect !== false;
  // Ore lies inside rock: without a dig list the way is dug through the rock and earth words of ROCK_ROAD (never an ore, a chest, a door or a bed), at most DEFAULT_MAX_DIG blocks.
  const roadWords = args.canDig?.length ? [...args.canDig] : ROCK_ROAD.split(',');
  const roadBudget = clamp(Math.round(Number(args.maxDig ?? DEFAULT_MAX_DIG)), 0, 200);
  const asked = args.count !== undefined;
  const wanted = kindOf(block);
  const isKind = (name: string | undefined) => name !== undefined && kindOf(name) === wanted;
  const packBefore = packCounts(bot);
  const idsBefore = new Set(Object.keys(bot.entities ?? {}).map(Number));
  const dugCells: Cell[] = [];
  const skipped: Array<{ cell: Cell; why: string; kind: 'liquid' | 'unreachable' | 'footing' | 'other' }> = [];
  const problem = (reason: string, text: string, at?: Cell): StepOutcome => stopped(bot, reason,
    `mine 止まった ${reason}: ${text}（${block} を掘れたのは ${result.dug} 個${result.dug ? `、${gainedText(bot, packBefore) || '何も増えていない'}` : ''}・たどった ${result.visited} マス）`, at);

  if (!bot.registry?.blocksByName?.[block]) return stopped(bot, 'no_block', `mine 止まった no_block: ${block} はブロックの名前ではない`);
  const cells = args.at ?? [];
  if (!cells.length) return stopped(bot, 'no_block', 'mine 止まった no_block: at（鉱脈のマス）が要る');
  let starts = cells.filter(cell => isKind(blockAt(bot, cell)?.name));
  let startNote = '';
  if (!starts.length) {
    // One cell off, or dug already: the same kind within START_TOLERANCE of the cells given starts the hand (nearest to them first, at most four).
    const near = new Map<string, { cell: Cell; d: number }>();
    for (const given of cells) for (let dx = -START_TOLERANCE; dx <= START_TOLERANCE; dx++) for (let dy = -START_TOLERANCE; dy <= START_TOLERANCE; dy++) for (let dz = -START_TOLERANCE; dz <= START_TOLERANCE; dz++) {
      const cell = { x: given.x + dx, y: given.y + dy, z: given.z + dz };
      if (!isKind(blockAt(bot, cell)?.name)) continue;
      const d = Math.hypot(dx, dy, dz), was = near.get(keyOf(cell));
      if (!was || d < was.d) near.set(keyOf(cell), { cell, d });
    }
    starts = [...near.values()].sort((a, b) => a.d - b.d).slice(0, 4).map(entry => entry.cell);
    // Still none (a vein or a tree the hand before took whole): the same kind within START_WIDE of the first cell, nearest first.
    if (!starts.length) {
      const first = cells[0], wide: Array<{ cell: Cell; d: number }> = [];
      for (let dx = -START_WIDE; dx <= START_WIDE; dx++) for (let dy = -START_WIDE; dy <= START_WIDE; dy++) for (let dz = -START_WIDE; dz <= START_WIDE; dz++) {
        const cell = { x: first.x + dx, y: first.y + dy, z: first.z + dz };
        if (isKind(blockAt(bot, cell)?.name)) wide.push({ cell, d: Math.hypot(dx, dy, dz) });
      }
      starts = wide.sort((a, b) => a.d - b.d).slice(0, 4).map(entry => entry.cell);
    }
    if (starts.length) startNote = `。at の ${placeText(bot, cells[0])} は ${cellNow(bot, cells[0])} だったので、近くの ${placeText(bot, starts[0])} から始めた`;
  }
  if (!starts.length && cells.every(cell => { const name = dugCellName(bot, cell); return name !== null && isKind(name); })) {
    // Every cell given was dug out by an earlier hand of this body: the work is done, and the hands after it go on.
    return { ok: true, goal: 'already', code: 'already_mined', at: cells[0], text: `mine 済（at のマスは前の手が掘り終えた ${block}。今 ${inventoryCount(bot, block)} 個）` };
  }
  if (!starts.length) {
    return stopped(bot, 'no_block', `mine 止まった no_block: at のマスは ${block} ではない: ${cells.map(cell => `${placeText(bot, cell)} は ${cellNow(bot, cell)}`).join('、')}`, cells[0]);
  }
  // The tool: the one asked for must make this block drop; else some tool carried must (dig picks the quickest of them).
  const sample = blockAt(bot, starts[0]);
  let keptNote = '';
  if (args.tool && args.tool !== 'hand') {
    const asked = findItem(bot, args.tool);
    if (!asked) return stopped(bot, 'no_tool', `mine 止まった no_tool: ${args.tool} を持っていない`, starts[0]);
    if (!canHarvest(sample, asked)) return stopped(bot, 'no_tool', `mine 止まった no_tool: ${args.tool} では ${block} は何も落ちない（掘れる道具: ${harvesters(bot, sample)}）`, starts[0]);
    // end1109o05: dig takes the cheaper tool that also makes the block drop; the result says so once, so the next tool= is left off.
    const cheaper = cheaperThanAsked(bot, sample, asked);
    if (cheaper) keptNote = `。${block} は ${cheaper.name} で足りるので ${asked.name} は取っておいた（減りが大きい道具は、それでしか落ちない物だけに使う）`;
  } else if (!args.tool && sample.harvestTools && !((bot.inventory?.items?.() ?? []) as any[]).some(item => canHarvest(sample, item))) {
    return stopped(bot, 'no_tool', `mine 止まった no_tool: ${block} を掘って落とす道具を持っていない（掘れる道具: ${harvesters(bot, sample)}）`, starts[0]);
  }

  const seen = new Set<string>(starts.map(keyOf));
  const open = new Map<string, Cell>(starts.map(cell => [keyOf(cell), cell]));
  const attempts = new Map<string, number>();
  let sincePick = 0, failsInARow = 0, missedNote = '', capped = false, footNote = '';
  let pocketDug = 0, pocketMs = 0, pocketDrops = 0;
  const pocketTried = new Set<number>();

  /** Picks up what the dug cells dropped. 'full' when the pack has no room for it. */
  const collectDrops = async (walkIn = true): Promise<'ok' | 'full'> => {
    sincePick = 0; missedNote = '';   // what is said at the end is what the last pick-up left
    if (!collect || !dugCells.length) return 'ok';
    const at = bot.entity?.position;
    const drops = Object.values(bot.entities ?? {}).filter((entity: any) => entity?.position && (entity.name === 'item' || entity.displayName === 'Item') && !idsBefore.has(entity.id)
      && dugCells.some(cell => Math.hypot(entity.position.x - cell.x - 0.5, entity.position.y - cell.y, entity.position.z - cell.z - 0.5) <= 3.5)) as any[];
    if (!drops.length) return 'ok';
    if (at) drops.sort((a, b) => a.position.distanceTo(at) - b.position.distanceTo(at));
    // This pick-up digs nothing (canDig []): digging to a drop that lies in rock is the walk-in below, one rule; its rock counts against maxDig for the road too, but each walked-to drop may dig at least POCKET_MIN_DIG cells even when the budget is spent, and maxDig 0 digs nothing (the pick-up's own 1-3 cell dig,
    // issue 3, is for the hands that name a drop and have no walk-in of their own; with both here the same drop would be tried twice).
    const picked = await pickup(ctx, { ids: drops.map(entity => entity.id), canDig: [] });
    if (!picked.ok && picked.reason === 'inventory_full') return 'full';
    const missed = /拾えなかった: (.*)$/u.exec(picked.text);
    if (missed) missedNote = `拾えなかった: ${missed[1]}`;
    else if (!picked.ok) missedNote = `拾えなかった: ${picked.text}`;
    // A drop left in a pocket the dig opened (a dig reaches 5 m through cells it sees; the pick-up digs nothing): the body goes in through natural rock within a small fixed
    // budget and takes it. No wait is added; what still cannot be reached is told as before.
    // maxDig 0 means no digging at all; the rock dug for a drop counts against the same budget as the road (a small floor each, so a drop one block in is still reached).
    const lying = () => drops.filter(entity => bot.entities?.[entity.id]);
    let tried = false;
    for (const entity of walkIn && roadBudget > 0 ? lying() : []) {
      if (pocketDrops >= POCKET_DROPS || pocketMs >= POCKET_SECONDS_ALL * 1000 || Date.now() >= ctx.deadline) break;
      // Not one already walked to, not one an earlier walk took on the way, and none when the pack has no room (the pick-up left those).
      if (pocketTried.has(entity.id) || !bot.entities?.[entity.id]) continue;
      if (!roomForDrops(bot, block)) break;
      pocketTried.add(entity.id);
      tried = true;
      pocketDrops++;
      const began = Date.now();
      const spot = { x: Math.floor(entity.position.x), y: Math.floor(entity.position.y + 1e-3), z: Math.floor(entity.position.z) };
      const seconds = Math.max(5, Math.min(POCKET_SECONDS_EACH, (POCKET_SECONDS_ALL * 1000 - pocketMs) / 1000, (ctx.deadline - began) / 1000));
      const gone = await go(ctx, { goals: [spot], range: 0, canDig: roadWords, maxDig: Math.max(POCKET_MIN_DIG, roadBudget - result.road - pocketDug), canPlace: undefined, seconds });
      pocketDug += Number(gone.data?.work?.dug ?? 0);
      if (bot.entities?.[entity.id]) {
        const taken = await pickup(ctx, { ids: [entity.id], canDig: [] });
        if (!taken.ok && taken.reason === 'inventory_full') return 'full';
      }
      pocketMs += Date.now() - began;
    }
    if (missedNote && tried) missedNote = lying().length ? `${missedNote}（岩を掘って近づく手も試した）` : '';
    return 'ok';
  };
  const reachable = (cell: Cell): boolean => canWorkOn(bot, cell);

  while (result.dug < count) {
    if (Date.now() >= ctx.deadline) {
      // What the last cells dropped is taken before the stop (a short pick-up only: no walk into rock, no wait).
      if (sincePick > 0) { ctx.deadline = Date.now() + 4000; await collectDrops(false); }
      return problem('limit_time', `${seconds} 秒の上限に着いた`, feetCell(bot) ?? undefined);
    }
    // The next cell: one that is within reach and seen first, then the nearest. A cell that is no longer the block (dug by something else) is dropped.
    let pick: { cell: Cell; near: boolean; dist: number } | null = null;
    for (const [key, cell] of open) {
      if (!isKind(blockAt(bot, cell)?.name)) { open.delete(key); continue; }
      const near = reachable(cell), dist = eyeDistance(bot, cell);
      if (!pick || (near && !pick.near) || (near === pick.near && dist < pick.dist)) pick = { cell, near, dist };
    }
    if (!pick) break;
    const cell = pick.cell, key = keyOf(cell);
    open.delete(key);
    result.visited++;
    if (result.visited > MAX_TRACE) { open.clear(); capped = true; break; }
    // The vein goes on through this cell whether or not it is dug: its neighbours of the same block are the next to follow.
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const next = { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz }, nextKey = keyOf(next);
      if (seen.has(nextKey)) continue;
      if (isKind(blockAt(bot, next)?.name)) { seen.add(nextKey); open.set(nextKey, next); }
    }
    // Lava beside the cell would run into the hole (and onto the body): the cell is left. Water beside it is let in (the body's footing and dam hold it).
    const wet = FACES.map(([dx, dy, dz]) => ({ at: { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz } })).find(face => isLava(blockAt(bot, face.at)?.name));
    if (wet) {
      skipped.push({ cell, kind: 'liquid', why: `${cellText(cell)} は隣の ${cellText(wet.at)} が ${blockAt(bot, wet.at)?.name}` });
      continue;
    }
    if (!roomForDrops(bot, block)) {
      await collectDrops();
      if (!roomForDrops(bot, block)) return problem('full', '持ち物が満杯で、落ちる物を入れる所が無い', cell);
    }
    if (!pick.near) {
      if (await collectDrops() === 'full') return problem('full', '拾った物で持ち物が満杯になった', cell);
      const gone = await approach(cell);
      if (gone) {
        if (gone.fatal) return problem(gone.reason, gone.text, cell);
        skipped.push({ cell, kind: 'unreachable', why: gone.text });
        if (skipped.filter(entry => entry.kind === 'unreachable').length >= UNREACHABLE_CELLS) break;
        continue;
      }
    }
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
    const outcome = await dig(ctx, { at: [cell], tool: args.tool, collect: false });
    if (outcome.ok) {
      failsInARow = 0;
      result.dug++; sincePick++;
      dugCells.push(cell);
      noteDugCell(bot, cell, block);
      const now = blockAt(bot, cell)?.name;
      if (isLava(now)) return problem('danger', `${cellText(cell)} を掘ると ${now} が流れ込んだ`, cell);
      // Water came in with the hole: the body is put on its feet (a block under them, the stream stopped) and the vein goes on.
      if (isLiquid(now)) { const steady = await steadyInWater(ctx, { toward: cell }); if (steady.words) footNote = steady.words; }
      if (collect && sincePick >= PICK_EVERY && await collectDrops() === 'full') return problem('full', '拾った物で持ち物が満杯になった', cell);
      ctx.progress?.(`${result.dug}/${count}`);
      continue;
    }
    switch (outcome.reason) {
      case 'out_of_reach': case 'not_visible': {
        if ((attempts.get(key) ?? 0) < 2) { open.set(key, cell); result.visited--; continue; }
        skipped.push({ cell, kind: 'unreachable', why: outcome.text });
        continue;
      }
      case 'lava_behind': skipped.push({ cell, kind: 'liquid', why: outcome.text }); continue;
      case 'footing': case 'falling_above': skipped.push({ cell, kind: 'footing', why: outcome.text }); continue;
      case 'threat_exposed': return problem('threat_exposed', outcome.text, cell);
      // The breath cannot pay for this dig and its way back: another try at the next cell spends the same breath, so the hand ends here.
      case 'breathing_work': return problem('breathing_work', outcome.text, cell);
      case 'no_harvest_tool': return result.dug ? problem('tool_broke', `道具が壊れて次の道具が無い（${outcome.text}）`, cell) : problem('no_tool', outcome.text, cell);
      case 'equip_failed': return problem('no_tool', outcome.text, cell);
      case 'unbreakable': case 'protected': case 'unloaded': skipped.push({ cell, kind: 'other', why: outcome.text }); continue;
      default: {
        // A dig that timed out, the server did not confirm, or failed: once more, then the cell is left; three in a row end the hand.
        if (++failsInARow >= FAILS_IN_A_ROW) return problem('unreachable', `掘りが ${FAILS_IN_A_ROW} 回続けて失敗した: ${outcome.text}`, cell);
        if ((attempts.get(key) ?? 0) < 2) { open.set(key, cell); result.visited--; } else skipped.push({ cell, kind: 'other', why: outcome.text });
      }
    }
  }
  if (await collectDrops() === 'full') return problem('full', '拾った物で持ち物が満杯になった', feetCell(bot) ?? undefined);

  const got = gainedText(bot, packBefore);
  const road = `${result.road ? `・道を ${result.road} マス掘った` : ''}${pocketDug ? `・落とし物へ岩を ${pocketDug} マス掘って近づいた` : ''}${footNote ? `・${footNote}` : ''}${startNote}`;
  const avoided = skipped.filter(entry => entry.kind === 'liquid' || entry.kind === 'footing' || entry.kind === 'other');
  const lost = missedNote ? `。${missedNote.length > 140 ? `${missedNote.slice(0, 139)}…` : missedNote}` : '';
  const aside = avoided.length ? `。掘らなかった: ${avoided.slice(0, 3).map(entry => entry.why).join('／')}${avoided.length > 3 ? ` ほか${avoided.length - 3}` : ''}` : '';
  const last = dugCells[dugCells.length - 1] ?? starts[0];
  if (result.dug >= count) {
    return { ok: true, at: last, text: `mine 済 ${block} ${result.dug} 個（${got ? `${got} を得た` : '拾っていない'}）・たどった ${result.visited} マス${road}${keptNote}${lost}${aside}` };
  }
  const unreached = skipped.filter(entry => entry.kind === 'unreachable');
  if (unreached.length) {
    return problem('unreachable', `${asked ? `まだ ${count - result.dug} 個ほしいが、` : 'つながりの残りのうち '}${unreached.length} マスに届かない: ${unreached.slice(0, 2).map(entry => entry.why).join('／')}`, unreached[0].cell);
  }
  if (!result.dug) {
    const liquid = avoided.find(entry => entry.kind === 'liquid');
    if (liquid) return problem('danger', `掘れるマスが無い: ${avoided.slice(0, 2).map(entry => entry.why).join('／')}`, liquid.cell);
    return problem('no_block', avoided.length ? `掘れるマスが無い: ${avoided[0].why}` : `${block} のつながりに掘れるマスが無い`, starts[0]);
  }
  // The vein ran out before the count: that is an end, not a failure.
  return { ok: true, at: last, text: `mine 済 ${block} ${result.dug} 個（${got ? `${got} を得た` : '拾っていない'}）・たどった ${result.visited} マス・${capped ? `${MAX_TRACE} マスたどって止めた（つながりがまだ続く）` : 'つながりが尽きた'}${asked ? `（ほしい ${count} 個に足りない）` : ''}${road}${keptNote}${lost}${aside}` };

  /**
   * What a stop at the way's dig limit says: the maxDig that covers everything dug so far in this mine and the way still to dig (go's count is only the way still
   * to dig: a number under the limit just reached can never be enough, and a body told it lowered the limit to it and asked again). The second stop at the same
   * place gives no number, but the two ways that need none. Short, and at the start: the act's line is cut from the back.
   */
  function digAdvice(cell: Cell, need: number): string {
    if (!Number.isFinite(need) || need <= 0) return '';
    const before = peekMapStop(bot, { kind: 'mine', at: cell, reason: closedWord('limit_dig') }) + peekMapStop(bot, { kind: 'mine', at: cell, reason: closedWord('unreachable') });
    const total = result.road + pocketDug + need;
    // A stop again at the same place: the estimate was short once, so it grows with each stop, and the number is still said (the other two ways are only added).
    const said = Math.max(total + 2 + 3 * before, roadBudget + 2 + 3 * before);
    const again = before >= 1 ? `（前にも止まった所。数で足りなければ、go で ${cellText({ x: cell.x, y: cell.y + 1, z: cell.z })} の近くまで行く（range 2、canDig に岩）か、上から掘る）` : '';
    return `道を掘る上限 ${roadBudget} に着いた。この mine にはあと約 ${need} マス要る（合計 ${total}）。maxDig=${said} で同じ mine${again}`;
  }

  /**
   * Gets the body to where it can dig the cell: the hand `go` to a cell beside it (any of its six faces), digging only what `canDig` names and no more than what is left
   * of `maxDig`; without `canDig` it digs nothing. The way is drawn first and not walked half, and a way that makes no headway is given up after a few redraws
   * (go's own rules), so a cell that cannot be reached is told at once.
   */
  async function approach(cell: Cell): Promise<{ fatal: boolean; reason: string; text: string } | null> {
    if (Date.now() >= ctx.deadline) return { fatal: true, reason: 'limit_time', text: `${seconds} 秒の上限に着いた` };
    const beside = FACES.map(([dx, dy, dz]) => ({ x: cell.x + dx, y: cell.y + dy, z: cell.z + dz }))
      .filter(at => { const name = blockAt(bot, at)?.name; return name !== undefined && !isLiquid(name); });
    if (!beside.length) return { fatal: false, reason: 'unreachable', text: `${placeText(bot, cell)} のまわりに立てる所が無い` };
    const roadLeft = Math.max(0, roadBudget - result.road - pocketDug);
    const gone = await go(ctx, { goals: beside, range: 0, canDig: roadLeft > 0 ? roadWords : undefined, maxDig: roadLeft, canPlace: undefined,
      seconds: Math.max(5, Math.min(APPROACH_SECONDS, (ctx.deadline - Date.now()) / 1000)) });
    result.road += Number(gone.data?.work?.dug ?? 0);
    await wait(ctx, 100);
    if (reachable(cell)) return null;
    const why = gone.ok ? `${placeText(bot, cell)} の隣まで行ったが、手が届かない・見えない` : gone.text.replace(/^go 止まった [a-z_]+: /u, '');
    if (!gone.ok && gone.reason === 'limit_dig') {
      // go says how many it would dig ("掘る所が N"): the maxDig that covers what is dug so far in this mine and that way is what the next mine is sent with, said at the start of the line.
      const need = Number(/掘る所が (\d+)/u.exec(gone.text)?.[1]);
      const advice = digAdvice(cell, need);
      return { fatal: true, reason: 'limit_dig', text: advice ? `${advice}（${placeText(bot, cell)} にまだ届かない）` : `道を掘る上限 ${roadBudget} マスに着いた（${placeText(bot, cell)} にまだ届かない）` };
    }
    // The hand's own seconds are the hand's limit; the approach's cap is only that this cell was not reached in that time.
    if (!gone.ok && gone.reason === 'limit_time' && Date.now() >= ctx.deadline) return { fatal: true, reason: 'limit_time', text: `${seconds} 秒の上限に着いた` };
    if (!gone.ok && gone.reason === 'limit_time') return { fatal: false, reason: 'unreachable', text: `${placeText(bot, cell)} へ ${APPROACH_SECONDS} 秒近づいても届かない` };
    const spent = roadBudget > 0 && roadLeft === 0;
    const allowed = roadLeft > 0 ? `許された物（${roadWords.join('・')}）だけを掘っても` : spent ? `道の掘り ${result.road} マス（maxDig ${roadBudget} を使い切った）で` : '掘らずに（maxDig が 0）';
    // end1109o04: iron ore 14 blocks down "had no way without digging"; the hand was not sent again with a dig list, and she called the
    // iron far and waited for the night. Without one, the stop says the same hand with the rock to dig.
    const needed = Number(/掘る所が (\d+)/u.exec(gone.text)?.[1]);
    const advice = spent && Number.isFinite(needed) && needed > 0 ? digAdvice(cell, needed) : '';
    if (advice) return { fatal: false, reason: 'unreachable', text: `${advice}（${placeText(bot, cell)} へ届く道が無い）` };
    const retry = spent ? (Number.isFinite(needed) && needed > 0 ? ''
        : `。まだ遠いなら maxDig を ${roadBudget} より大きくする（ただし近くの別の鉱脈のほうが早くないか先に見る）`) : roadLeft > 0 ? '' : `。maxDig を 1 以上にすれば（既定 ${DEFAULT_MAX_DIG}）、岩（${ROCK_ROAD}）を掘って近づく（鉱石は岩の中にあるので、掘る道なら普通は届く）`;
    return { fatal: false, reason: 'unreachable', text: `${placeText(bot, cell)} へ${allowed}届く道が無い（${why.slice(0, 70)}）${retry}` };
  }
}

/** The tools that make this block drop, from its harvest table: "stone_pickaxe・iron_pickaxe・…". */
function harvesters(bot: any, block: any): string {
  const names = Object.keys(block?.harvestTools ?? {}).map(id => String(bot.registry?.items?.[Number(id)]?.name ?? id));
  return names.slice(0, 6).join('・') || '素手';
}
