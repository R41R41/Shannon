import { canHarvest } from '../toolChoice.js';
import { feetCell, type Cell } from '../localMap.js';
import { blockAt, cellNow, cellText, eyeDistance, findItem, freeSlots, placeText, stopped, wait,
  type StepContext, type StepOutcome } from './common.js';
import { dig } from './dig.js';
import { pickup } from './pickup.js';
import { canWorkOn } from './getNear.js';
import { go } from './go.js';
import { withProgress } from './progressUnits.js';

/**
 * mine: a vein, cell by cell (hands-contract.md 3). The planner names the block (`iron_ore`; `deepslate_iron_ore` is another kind) and
 * the cells it starts from (`at`, one to four of that block), and how many to take. The body follows the cells of that same block that
 * touch the ones it has (a face, an edge or a corner), nearest first, digs each with the quickest tool that makes it drop, and picks
 * what falls. It looks for no other ore and no other block: the vein is what the planner's cells are joined to. A cell it cannot stand
 * near is gone to by the hand `go` (a way that digs only what `canDig` names, at most `maxDig` blocks; without them it digs no way at all), at most
 * `APPROACH_SECONDS` a cell, and the hand gives up when `UNREACHABLE_CELLS` cells have not been reached (run 40: 8 stops of 5 to 51 s, 194 s in all). It makes
 * no tunnel and no stair (those are repeat and go), and never digs a cell with water or lava beside it.
 */
export interface MineArgs {
  block: string; at: Cell[]; count?: number; tool?: string; collect?: boolean; seconds?: number; canDig?: readonly string[]; maxDig?: number;
}

/** Cells of the vein the body will follow: a hard stop on a vein that does not end (a block as common as stone). */
const MAX_TRACE = 256;
const DEFAULT_COUNT = 8;
const DEFAULT_SECONDS = 60;
const DEFAULT_MAX_DIG = 16;
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
  const roadWords = [...(args.canDig ?? [])];
  const roadBudget = roadWords.length ? clamp(Math.round(Number(args.maxDig ?? DEFAULT_MAX_DIG)), 0, 200) : 0;
  const packBefore = packCounts(bot);
  const idsBefore = new Set(Object.keys(bot.entities ?? {}).map(Number));
  const dugCells: Cell[] = [];
  const skipped: Array<{ cell: Cell; why: string; kind: 'liquid' | 'unreachable' | 'footing' | 'other' }> = [];
  const problem = (reason: string, text: string, at?: Cell): StepOutcome => stopped(bot, reason,
    `mine 止まった ${reason}: ${text}（${block} を掘れたのは ${result.dug} 個${result.dug ? `、${gainedText(bot, packBefore) || '何も増えていない'}` : ''}・たどった ${result.visited} マス）`, at);

  if (!bot.registry?.blocksByName?.[block]) return stopped(bot, 'no_block', `mine 止まった no_block: ${block} はブロックの名前ではない`);
  const cells = args.at ?? [];
  if (!cells.length) return stopped(bot, 'no_block', 'mine 止まった no_block: at（鉱脈のマス）が要る');
  const starts = cells.filter(cell => blockAt(bot, cell)?.name === block);
  if (!starts.length) {
    return stopped(bot, 'no_block', `mine 止まった no_block: at のマスは ${block} ではない: ${cells.map(cell => `${placeText(bot, cell)} は ${cellNow(bot, cell)}`).join('、')}`, cells[0]);
  }
  // The tool: the one asked for must make this block drop; else some tool carried must (dig picks the quickest of them).
  const sample = blockAt(bot, starts[0]);
  if (args.tool && args.tool !== 'hand') {
    const asked = findItem(bot, args.tool);
    if (!asked) return stopped(bot, 'no_tool', `mine 止まった no_tool: ${args.tool} を持っていない`, starts[0]);
    if (!canHarvest(sample, asked)) return stopped(bot, 'no_tool', `mine 止まった no_tool: ${args.tool} では ${block} は何も落ちない（掘れる道具: ${harvesters(bot, sample)}）`, starts[0]);
  } else if (!args.tool && sample.harvestTools && !((bot.inventory?.items?.() ?? []) as any[]).some(item => canHarvest(sample, item))) {
    return stopped(bot, 'no_tool', `mine 止まった no_tool: ${block} を掘って落とす道具を持っていない（掘れる道具: ${harvesters(bot, sample)}）`, starts[0]);
  }

  const seen = new Set<string>(starts.map(keyOf));
  const open = new Map<string, Cell>(starts.map(cell => [keyOf(cell), cell]));
  const attempts = new Map<string, number>();
  let sincePick = 0, failsInARow = 0, missedNote = '', capped = false;

  /** Picks up what the dug cells dropped. 'full' when the pack has no room for it. */
  const collectDrops = async (): Promise<'ok' | 'full'> => {
    sincePick = 0; missedNote = '';   // what is said at the end is what the last pick-up left
    if (!collect || !dugCells.length) return 'ok';
    const at = bot.entity?.position;
    const drops = Object.values(bot.entities ?? {}).filter((entity: any) => entity?.position && (entity.name === 'item' || entity.displayName === 'Item') && !idsBefore.has(entity.id)
      && dugCells.some(cell => Math.hypot(entity.position.x - cell.x - 0.5, entity.position.y - cell.y, entity.position.z - cell.z - 0.5) <= 3.5)) as any[];
    if (!drops.length) return 'ok';
    if (at) drops.sort((a, b) => a.position.distanceTo(at) - b.position.distanceTo(at));
    const picked = await pickup(ctx, { ids: drops.map(entity => entity.id) });
    if (!picked.ok && picked.reason === 'inventory_full') return 'full';
    const missed = /拾えなかった: (.*)$/u.exec(picked.text);
    if (missed) missedNote = `拾えなかった: ${missed[1]}`;
    else if (!picked.ok) missedNote = `拾えなかった: ${picked.text}`;
    return 'ok';
  };
  const reachable = (cell: Cell): boolean => canWorkOn(bot, cell);

  while (result.dug < count) {
    if (Date.now() >= ctx.deadline) return problem('limit_time', `${seconds} 秒の上限に着いた`, feetCell(bot) ?? undefined);
    // The next cell: one that is within reach and seen first, then the nearest. A cell that is no longer the block (dug by something else) is dropped.
    let pick: { cell: Cell; near: boolean; dist: number } | null = null;
    for (const [key, cell] of open) {
      if (blockAt(bot, cell)?.name !== block) { open.delete(key); continue; }
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
      if (blockAt(bot, next)?.name === block) { seen.add(nextKey); open.set(nextKey, next); }
    }
    // Water or lava beside the cell would run into the hole (and onto the body): the cell is left.
    const wet = FACES.map(([dx, dy, dz]) => ({ at: { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz } })).find(face => isLiquid(blockAt(bot, face.at)?.name));
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
      const now = blockAt(bot, cell)?.name;
      if (isLiquid(now)) return problem('danger', `${cellText(cell)} を掘ると ${now} が流れ込んだ`, cell);
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
      case 'threat_exposed': return problem('danger', outcome.text, cell);
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
  const road = result.road ? `・道を ${result.road} マス掘った` : '';
  const avoided = skipped.filter(entry => entry.kind === 'liquid' || entry.kind === 'footing' || entry.kind === 'other');
  const lost = missedNote ? `。${missedNote.length > 140 ? `${missedNote.slice(0, 139)}…` : missedNote}` : '';
  const aside = avoided.length ? `。掘らなかった: ${avoided.slice(0, 3).map(entry => entry.why).join('／')}${avoided.length > 3 ? ` ほか${avoided.length - 3}` : ''}` : '';
  const last = dugCells[dugCells.length - 1] ?? starts[0];
  if (result.dug >= count) {
    return { ok: true, at: last, text: `mine 済 ${block} ${result.dug} 個（${got ? `${got} を得た` : '拾っていない'}）・たどった ${result.visited} マス${road}${lost}${aside}` };
  }
  const unreached = skipped.filter(entry => entry.kind === 'unreachable');
  if (unreached.length) {
    return problem('unreachable', `まだ ${count - result.dug} 個ほしいが、${unreached.length} マスに届かない: ${unreached.slice(0, 2).map(entry => entry.why).join('／')}`, unreached[0].cell);
  }
  if (!result.dug) {
    const liquid = avoided.find(entry => entry.kind === 'liquid');
    if (liquid) return problem('danger', `掘れるマスが無い: ${avoided.slice(0, 2).map(entry => entry.why).join('／')}`, liquid.cell);
    return problem('no_block', avoided.length ? `掘れるマスが無い: ${avoided[0].why}` : `${block} のつながりに掘れるマスが無い`, starts[0]);
  }
  // The vein ran out before the count: that is an end, not a failure.
  return { ok: true, at: last, text: `mine 済 ${block} ${result.dug} 個（${got ? `${got} を得た` : '拾っていない'}）・たどった ${result.visited} マス・${capped ? `${MAX_TRACE} マスたどって止めた（つながりがまだ続く）` : 'つながりが尽きた'}（ほしい ${count} 個に足りない）${road}${lost}${aside}` };

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
    const roadLeft = roadWords.length ? Math.max(0, roadBudget - result.road) : 0;
    const gone = await go(ctx, { goals: beside, range: 0, canDig: roadLeft > 0 ? roadWords : undefined, maxDig: roadLeft, canPlace: undefined,
      seconds: Math.max(5, Math.min(APPROACH_SECONDS, (ctx.deadline - Date.now()) / 1000)) });
    result.road += Number(gone.data?.work?.dug ?? 0);
    await wait(ctx, 100);
    if (reachable(cell)) return null;
    const why = gone.ok ? `${placeText(bot, cell)} の隣まで行ったが、手が届かない・見えない` : gone.text.replace(/^go 止まった [a-z_]+: /u, '');
    if (!gone.ok && gone.reason === 'limit_dig') return { fatal: true, reason: 'limit_dig', text: `道を掘る上限 ${roadBudget} マスに着いた（${placeText(bot, cell)} にまだ届かない）` };
    // The hand's own seconds are the hand's limit; the approach's cap is only that this cell was not reached in that time.
    if (!gone.ok && gone.reason === 'limit_time' && Date.now() >= ctx.deadline) return { fatal: true, reason: 'limit_time', text: `${seconds} 秒の上限に着いた` };
    if (!gone.ok && gone.reason === 'limit_time') return { fatal: false, reason: 'unreachable', text: `${placeText(bot, cell)} へ ${APPROACH_SECONDS} 秒近づいても届かない` };
    const allowed = roadLeft > 0 ? `許された物（${roadWords.join('・')}）だけを掘っても` : '掘らずに（canDig が無い）';
    return { fatal: false, reason: 'unreachable', text: `${placeText(bot, cell)} へ${allowed}届く道が無い（${why.slice(0, 70)}）` };
  }
}

/** The tools that make this block drop, from its harvest table: "stone_pickaxe・iron_pickaxe・…". */
function harvesters(bot: any, block: any): string {
  const names = Object.keys(block?.harvestTools ?? {}).map(id => String(bot.registry?.items?.[Number(id)]?.name ?? id));
  return names.slice(0, 6).join('・') || '素手';
}
