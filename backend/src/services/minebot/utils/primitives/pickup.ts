import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { bodyReader, feetCell, relativeWords, type Cell } from '../localMap.js';
import { isSelfDropped } from '../selfDropped.js';
import { solidBetween } from '../probeTools.js';
import { cellText, freeSlots, letGo, packLine, stopped, StepStopped, wait, type StepContext, type StepOutcome } from './common.js';
import { goWith, walkMovements, wayWords, whyBlocked, type WayNotes } from './walk.js';
import { magmaAtFootprint } from '../magmaFootprint.js';
// go -> dig -> pickup -> go: a cycle that is only called into, never read when the modules load.
import { go } from './go.js';

const { goals } = pathfinder;

/**
 * pickup: walk to dropped items and take them (design mb-llm-centric 2.3). By id, or every item within a radius, nearest first. The walk is
 * the walk's (no dig, no block laid; doors opened, leaves broken). What is gained is counted from the pack, not assumed. An item not taken
 * is said with where it lies, where it is from the body, how far, and what stands between (r5: run 28's 19 "拾えなかった" said none of it).
 */
/**
 * `item`: only drops of that name (end1108h7b S7: 「pickup target=blaze_rod」 from 10 m off took the nearest brick, failed on it and never went
 * for the rod; the name was dropped on the way to the body). A named kind is looked for out to NAMED_RADIUS unless a radius is given.
 */
export interface PickupArgs {
  radius?: number; ids?: number[]; item?: string;
  /**
   * Issue 3 (run 5: a raw_iron behind 1-2 blocks of rock cost 3 minutes and 14 queue items): what the hand may dig to reach a drop it cannot walk to.
   * Left out: stone and dirt (and the ordinary ore that stands on the straight line), DIG_PER_DROP a drop and DIG_PER_HAND in all. Given, it is the whole
   * rule (an empty list digs nothing) and `maxDig` the most cells for the hand.
   */
  canDig?: readonly string[]; maxDig?: number;
}

const DEFAULT_RADIUS = 6;
const MAX_RADIUS = 16;
const NAMED_RADIUS = 24;
const ITEM_WAIT_MS = 2500;
/** The longest a drop still in the air is waited for to come to rest before the hand walks to it or waits for it. */
const SETTLE_MS = 1500;
/** A body takes an item its box, grown by 1 across and 0.5 up and down, touches (the item's own box is 0.25 wide). */
const TAKE_ACROSS = 1.3 + 0.125;
const TAKE_BELOW = 0.5 + 0.25;
const TAKE_ABOVE = 1.8 + 0.5;
/** Dug to reach one drop and in one hand, and the longest one drop's dig may take (seconds): the hand has no wait of its own to add. */
const DIG_PER_DROP = 3;
const DIG_PER_HAND = 6;
const DIG_SECONDS = 12;
const DIG_WORDS = ['stone', 'dirt'];
/** An ore that stands on the line to the drop is dug as rock is; the rare ones (diamond, emerald, ancient debris) are not. */
const ORDINARY_ORE = /^(?:deepslate_)?(?:iron|coal|copper|gold|redstone|lapis)_ore$/u;
/** A nudge inside the cell: the farthest past the box's edge it is tried for (m), and the longest it holds the key down (ms). */
const NUDGE_REACH = 0.7;
const NUDGE_MS = 600;
const NOT_STOOD_IN = /(?:lava|water|fire|cactus|web|magma|powder_snow|sweet_berry|bubble|kelp|seagrass)/u;

function droppedName(bot: any, entity: any): string {
  try {
    const item = entity.getDroppedItem?.();
    if (item?.name) return String(item.name);
  } catch { /* by its id below */ }
  const meta = Array.isArray(entity.metadata) ? entity.metadata.find((value: any) => value && typeof value === 'object' && ('itemId' in value || 'blockId' in value)) : null;
  const id = meta?.itemId ?? meta?.blockId;
  return typeof id === 'number' ? String(bot.registry?.items?.[id]?.name ?? 'item') : 'item';
}

export function itemEntitiesNear(bot: any, radius: number): any[] {
  const at = bot.entity?.position;
  if (!at) return [];
  return Object.values(bot.entities ?? {}).filter((entity: any) => entity?.position && (entity.name === 'item' || entity.displayName === 'Item')
    && entity.position.distanceTo(at) <= radius).sort((a: any, b: any) => a.position.distanceTo(at) - b.position.distanceTo(at));
}

/** Whether the body's box would take an item at `item` now. */
export function withinTake(body: { x: number; y: number; z: number }, item: { x: number; y: number; z: number }): boolean {
  return Math.abs(item.x - body.x) <= TAKE_ACROSS && Math.abs(item.z - body.z) <= TAKE_ACROSS && item.y >= body.y - TAKE_BELOW && item.y <= body.y + TAKE_ABOVE;
}

/**
 * Where an item lies from the body, as facts: its cell, the way from the feet, the distance, whether the body's box takes it, and the solid
 * cells between the body's middle and it.
 */
export function itemFacts(bot: any, position: { x: number; y: number; z: number }): string {
  const body = bot.entity?.position;
  const cell: Cell = { x: Math.floor(position.x), y: Math.floor(position.y + 1e-3), z: Math.floor(position.z) };
  const feet = feetCell(bot);
  if (!body || !feet) return cellText(cell);
  const distance = Math.hypot(position.x - body.x, position.y - body.y, position.z - body.z);
  const facts = [`${cellText(cell)} 自分から${relativeWords(feet, cell)}・${distance.toFixed(1)}m`];
  if (!withinTake(body, position)) facts.push('拾える所（体から横 1.4m・上 2.3m・下 0.7m）に無い');
  let between: Cell[] = [];
  try { between = solidBetween(bodyReader(bot), [body.x, body.y + 0.9, body.z], [position.x, position.y + 0.125, position.z]); } catch { between = [];}
  if (between.length) {
    const read = bodyReader(bot);
    facts.push(`間に ${between.slice(0, 2).map(c => `${cellText(c)} ${read(c.x, c.y, c.z)?.name ?? '未ロード'}`).join('、')}${between.length > 2 ? ' ほか' : ''}`);
  }
  return facts.join('、');
}

/** Whether the pack takes a drop of this name: a free slot, or a stack of it that is not full (as mine's roomForDrops). */
function roomFor(bot: any, name: string): boolean {
  if (freeSlots(bot) > 0) return true;
  return ((bot.inventory?.items?.() ?? []) as any[]).some(held => held.name === name
    && held.count < Number(held.stackSize ?? bot.registry?.itemsByName?.[name]?.stackSize ?? 64));
}


/** A cell a body may stand in at a point: a floor under it, the feet and the head free, nothing that burns, drowns or hurts. */
function standableAt(bot: any, x: number, y: number, z: number): boolean {
  const read = (dy: number) => { try { return bot.blockAt?.(new Vec3(Math.floor(x), Math.floor(y + 1e-3) + dy, Math.floor(z)), false) ?? null; } catch { return null; } };
  const feet = read(0), head = read(1), floor = read(-1);
  if (!feet || !head || !floor) return false;
  const free = (block: any) => block.boundingBox === 'empty' && !NOT_STOOD_IN.test(String(block.name));
  return free(feet) && free(head) && floor.boundingBox === 'block' && !NOT_STOOD_IN.test(String(floor.name));
}

/**
 * Issue 3 (run 5, the owner's case): a drop 0.15 m beyond the take box, in a cell with a low ceiling the walk will not enter. The body steps toward it
 * inside cells it can stand in (a floor, room for the head), as far as the box needs and no more, and the key is let go at once. No dig; no wait of
 * its own (NUDGE_MS at most, and only while the body moves). Whether the box takes the drop afterwards.
 */
async function nudgeToward(ctx: StepContext, where: () => { x: number; y: number; z: number }): Promise<boolean> {
  const bot = ctx.bot;
  const body = bot.entity?.position;
  if (!body) return false;
  const item = where();
  const length = Math.hypot(item.x - body.x, item.z - body.z);
  const gap = Math.max(Math.abs(item.x - body.x), Math.abs(item.z - body.z)) - TAKE_ACROSS;
  if (gap <= 0 || gap > NUDGE_REACH || item.y < body.y - TAKE_BELOW || item.y > body.y + TAKE_ABOVE || length < 1e-6) return false;
  const reach = gap + 0.3;
  if (!standableAt(bot, body.x + (item.x - body.x) / length * reach, body.y, body.z + (item.z - body.z) / length * reach)) return false;
  const start = { x: body.x, z: body.z };
  try {
    await bot.lookAt?.(new Vec3(item.x, body.y + 1.62, item.z), true);
    bot.setControlState?.('forward', true);
    for (const until = Date.now() + NUDGE_MS; Date.now() < until && !withinTake(bot.entity.position, where())
      && Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z) < reach;) await wait(ctx, 25);
  } catch { /* the walk below goes on without it */ } finally { try { bot.setControlState?.('forward', false); } catch { /* released */ } }
  return withinTake(bot.entity.position, where());
}

/** The solid cells in the box round the way from the body to the drop (read before and after a go: what is no longer solid was dug). */
function solidCellsAround(bot: any, from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): Array<{ at: Cell; name: string }> {
  const lo = { x: Math.floor(Math.min(from.x, to.x)) - 1, y: Math.floor(Math.min(from.y, to.y)) - 1, z: Math.floor(Math.min(from.z, to.z)) - 1 };
  const hi = { x: Math.floor(Math.max(from.x, to.x)) + 1, y: Math.floor(Math.max(from.y, to.y)) + 3, z: Math.floor(Math.max(from.z, to.z)) + 1 };
  const out: Array<{ at: Cell; name: string }> = [];
  if ((hi.x - lo.x + 1) * (hi.y - lo.y + 1) * (hi.z - lo.z + 1) > 600) return out;
  for (let x = lo.x; x <= hi.x; x++) for (let y = lo.y; y <= hi.y; y++) for (let z = lo.z; z <= hi.z; z++) {
    let block: any = null;
    try { block = bot.blockAt?.(new Vec3(x, y, z), false); } catch { block = null; }
    if (block?.boundingBox === 'block') out.push({ at: { x, y, z }, name: String(block.name) });
  }
  return out;
}

/** What one hand has dug to reach drops: the cells, and how many more it may dig. */
interface DigLedger { dug: Array<{ at: Cell; name: string }>; left: number }

/**
 * Issue 3: digs through a little rock to a drop the walk cannot reach, by the hand `go` (its guards: no lava or water behind the cell, no gravel above
 * it, nothing exposed that is not let in, no ore that is not named, no protected block). Tried once a drop. '' when it dug or had nothing to say; else
 * the words of why it did not (or stopped).
 */
async function digToDrop(ctx: StepContext, args: PickupArgs, item: { x: number; y: number; z: number }, ledger: DigLedger): Promise<string> {
  const bot = ctx.bot;
  const body = bot.entity?.position;
  if (!body) return '';
  const cell = { x: Math.floor(item.x), y: Math.floor(item.y + 1e-3), z: Math.floor(item.z) };
  const here = (() => { try { return bot.blockAt?.(new Vec3(cell.x, cell.y, cell.z), false) ?? null; } catch { return null; } })();
  if (!here) return '';
  if (here.boundingBox === 'block') return '';
  if (here.name === 'water' || here.name === 'lava') return `落とし物の所が ${here.name} なので掘って近づかない`;
  if (args.canDig && !args.canDig.length) return '';
  if (ledger.left <= 0) return `この手で掘る上限に着いている（${ledger.dug.length} マス）`;
  if (ctx.deadline - Date.now() < 3000) return '';
  const words = args.canDig ? [...args.canDig] : [...DIG_WORDS];
  if (!args.canDig) {
    let between: Cell[] = [];
    try { between = solidBetween(bodyReader(bot), [body.x, body.y + 0.9, body.z], [item.x, item.y + 0.125, item.z]); } catch { between = []; }
    const read = bodyReader(bot);
    for (const at of between) { const name = read(at.x, at.y, at.z)?.name; if (name && ORDINARY_ORE.test(name) && !words.includes(name)) words.push(name); }
  }
  const before = solidCellsAround(bot, body, item);
  const maxDig = Math.min(DIG_PER_DROP, ledger.left);
  let out: StepOutcome;
  try { out = await go(ctx, { goals: [cell], range: 0.5, canDig: words, maxDig, seconds: Math.min(DIG_SECONDS, Math.max(5, Math.floor((ctx.deadline - Date.now()) / 1000))) }); }
  catch (error) {
    if (ctx.stop.aborted || error instanceof StepStopped || /interrupted/iu.test(String((error as Error)?.message))) throw error;
    out = stopped(bot, 'go_failed', `go が例外で止まった: ${String((error as Error)?.message ?? error).slice(0, 60)}`, cell);
  }
  const dug = before.filter(cellBefore => {
    try { return bot.blockAt?.(new Vec3(cellBefore.at.x, cellBefore.at.y, cellBefore.at.z), false)?.boundingBox !== 'block'; } catch { return false; }
  });
  ledger.dug.push(...dug);
  ledger.left -= Math.max(dug.length, Number(out.data?.work?.dug ?? 0));
  if (out.ok) return '';
  return `${out.reason ?? 'go'}: ${out.text.length > 90 ? `${out.text.slice(0, 90)}…` : out.text}`;
}

export async function pickup(ctx: StepContext, args: PickupArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const readFloor = (x: number, y: number, z: number): string | null => {
    try { return bot.blockAt?.(new Vec3(x, y, z), false)?.name ?? null; } catch { return null; }
  };
  const unsafe = magmaAtFootprint(readFloor, bot.entity?.position);
  if (unsafe) return stopped(bot, 'unsafe', `足幅が ${cellText(unsafe)} の magma_block に掛かるため拾いを止めた。安全な床へ離れてから`, unsafe);
  const named = args.item && !args.ids?.length ? args.item : undefined;
  const radius = named ? Math.min(NAMED_RADIUS, Math.max(1, args.radius ?? NAMED_RADIUS)) : Math.min(MAX_RADIUS, Math.max(1, args.radius ?? DEFAULT_RADIUS));
  const wanted = args.ids?.length ? new Set(args.ids) : null;
  // What the body threw away itself is not picked up again by a radius (by id it is: the planner asked for that one).
  const targets = (wanted ? Object.values(bot.entities ?? {}).filter((entity: any) => entity && wanted.has(entity.id))
    : itemEntitiesNear(bot, radius).filter(entity => !isSelfDropped(bot, entity) && (!named || droppedName(bot, entity) === named))) as any[];
  if (!targets.length) {
    // An arrow shot is not a drop: one that met a creature is gone, one stuck in a block is not taken by this hand (end1108h7b: four hands asked for arrows).
    if (named) return { ok: true, text: `拾う対象がない: ${radius}m 内に落ちている ${named} は無い（地面の落とし物のみ対象。射った矢は落とし物ではない）` };
    return { ok: true, text: '拾う対象がない（地面の落とし物のみ対象。射った矢は落とし物ではない）' };
  }
  const before = new Map<string, number>();
  for (const item of bot.inventory?.items?.() ?? []) before.set(item.name, (before.get(item.name) ?? 0) + item.count);
  const navigator = bot.pathfinder;
  const previous = navigator?.movements;
  navigator?.setMovements(walkMovements(bot, true));
  const missed: string[] = [];
  const ledger: DigLedger = { dug: [], left: args.canDig && !args.canDig.length ? 0 : Math.max(0, Math.min(DIG_PER_HAND, Math.floor(args.maxDig ?? DIG_PER_HAND))) };
  const digTried = new Set<number>();
  const missFull = (name: string) => { const full = `${name}（持ち物が満杯）`; if (!missed.includes(full)) missed.push(full); };
  const notes: WayNotes = { opened: [], leaves: 0 };
  try {
    for (const entity of targets.slice(0, 16)) {
      if (!bot.entities?.[entity.id]) continue;
      const name = droppedName(bot, entity);
      // A full pack still takes what stacks onto a stack it holds (pearls 5/16, rods 3/64); a drop it has no room for is passed by, and the ones behind it are still looked at.
      if (!roomFor(bot, name)) { missFull(name); continue; }
      const where = () => ({ x: entity.position.x, y: entity.position.y, z: entity.position.z });
      // A drop just thrown out is still in the air (the last drop of a mine: it showed beside the body and bounced 1.3-2 m off while the hand
      // waited for it where it first showed, 1 run in 4 of the hands check): it is let come to rest before the hand decides to walk or wait.
      for (let still = 0, until = Date.now() + SETTLE_MS, last = where(); Date.now() < until && still < 2 && bot.entities?.[entity.id];) {
        await wait(ctx, 100);
        const now = where();
        still = Math.hypot(now.x - last.x, now.y - last.y, now.z - last.z) < 0.03 ? still + 1 : 0;
        last = now;
      }
      if (!bot.entities?.[entity.id]) continue; // taken while it fell
      let unreachable = false;
      // Walked to where it lies and waited for it; once more where it lies then, if it rolled on meanwhile.
      for (let attempt = 0; attempt < 2 && bot.entities?.[entity.id] && !unreachable && (attempt === 0 || roomFor(bot, name)); attempt++) {
        // Issue 3: a drop a hand's breadth outside the box is taken by a step inside the body's own cells before any walk is drawn (the walk will not enter a low cell).
        if (!withinTake(bot.entity.position, where()) && !(await nudgeToward(ctx, where))) {
          // Run 47 (hold 1): a drop whose coordinates lie inside a block (a wall's, the top of a fence: it clips into the shape) cannot be stood in; the body goes where its box takes it from.
          const itemCell = { x: Math.floor(entity.position.x), y: Math.floor(entity.position.y + 1e-3), z: Math.floor(entity.position.z) };
          let inBlock = false;
          try { inBlock = bot.blockAt?.(new Vec3(itemCell.x, itemCell.y, itemCell.z), false)?.boundingBox === 'block'; } catch { inBlock = false; }
          const onMagma = magmaAtFootprint(readFloor, { ...where(), y: itemCell.y });
          const goal = new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z,
            inBlock || onMagma ? Math.max(0.5, TAKE_ACROSS - 0.15) : 0.5);
          const gone = await goWith(ctx, goal, Math.min(10_000, Math.max(500, ctx.deadline - Date.now())), notes);
          if (gone.magma) { missed.push(`${name}（足幅が ${cellText(gone.magma)} の magma_block に掛かるため移動を止めた）`); unreachable = true; break; }
          if (!bot.entities?.[entity.id]) break; // taken on the way
          if (gone.timedOut || gone.stuck || gone.error || !gone.reached) {
            letGo(bot);
            const item = where(), cell = { x: Math.floor(item.x), y: Math.floor(item.y + 1e-3), z: Math.floor(item.z) };
            const here = feetCell(bot)!;
            const blocked = whyBlocked(bot, here, cell);
            const why = gone.timedOut ? '時間切れ' : gone.stuck ? '4秒進めず' : /no path/iu.test(String((gone.error as Error)?.message)) ? '掘らない道が無い' : 'そこまで着けない';
            if (!withinTake(bot.entity.position, item)) {
              // Issue 3 (run 5: three minutes lost to a raw_iron behind one stone): the body digs 1-3 blocks of rock itself, once for each drop, with the guards of go and dig.
              let digWhy = '';
              if (!digTried.has(entity.id) && !inBlock && !onMagma) {
                digTried.add(entity.id);
                digWhy = await digToDrop(ctx, args, item, ledger);
                try { navigator?.setMovements(walkMovements(bot, true)); } catch { /* the walk's movements come back with the next hand */ }
                if (!bot.entities?.[entity.id]) break; // taken on arrival
              }
              const now = where();
              if (withinTake(bot.entity.position, now)) continue; // the dig brought it into the box: it is waited for below
              missed.push(`${name}（${why}。${itemFacts(bot, now)}${blocked ? `。${blocked.text}` : ''}${digWhy ? `。掘って近づこうとして止まった ${digWhy}` : ''}）`); unreachable = true; break;
            }
          }
        }
        for (const until = Date.now() + ITEM_WAIT_MS; Date.now() < until && bot.entities?.[entity.id];) await wait(ctx, 100);
      }
      if (unreachable) continue;
      if (bot.entities?.[entity.id]) {
        const item = where();
        // The stack filled on the way and the rest of the drop lies there: that is the reason, not the place.
        if (!roomFor(bot, name)) missFull(name);
        else missed.push(`${name}（${withinTake(bot.entity.position, item) ? `拾える所にあるのに ${ITEM_WAIT_MS / 1000} 秒で入らなかった。` : ''}${itemFacts(bot, item)}）`);
      }
    }
  } finally { try { if (previous) navigator.setMovements(previous); } catch { /* kept */ } }
  const gained: string[] = [];
  let gotCount = 0;
  const after = new Map<string, number>();
  for (const item of bot.inventory?.items?.() ?? []) after.set(item.name, (after.get(item.name) ?? 0) + item.count);
  for (const [name, count] of after) { const diff = count - (before.get(name) ?? 0); if (diff > 0) { gained.push(`${name}+${diff}`); gotCount += diff; } }
  const dugWords = ledger.dug.length ? `${ledger.dug.slice(0, 4).map(one => `${cellText(one.at)} ${one.name}`).join('・')}${ledger.dug.length > 4 ? ` ほか${ledger.dug.length - 4}` : ''} を ${ledger.dug.length} マス掘った` : '';
  const way = [wayWords(notes), dugWords].filter(Boolean).join('、');
  const text = `拾った: ${gained.join(' ') || 'なし'}${missed.length ? `。拾えなかった: ${missed.join('、')}` : ''}${way ? `（途中で${way}）` : ''}`;
  const data = ledger.dug.length ? { dug: ledger.dug } : undefined;
  // Continue contracts (1): progress in items (the items the pack gained, counted from the pack; what was left lying is in the text).
  const progress = { unit: 'item' as const, done: gotCount, left: null };
  if (!gained.length && missed.length) return { ...stopped(bot, freeSlots(bot) === 0 ? 'inventory_full' : 'not_picked', `${text}（持ち物 ${packLine(bot).length > 200 ? `空き${freeSlots(bot)}枠` : packLine(bot)}）`, feetCell(bot)!), progress, ...(data ? { data } : {}) };
  return { ok: true, text, progress, ...(data ? { data } : {}) };
}
