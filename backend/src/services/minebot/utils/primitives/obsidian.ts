import { Vec3 } from 'vec3';
import { feetCell, type BlockReader, type Cell } from '../localMap.js';
import { dropBurnsIn } from '../dropFate.js';
import { blockInSight } from '../probeTools.js';
import { cellText, freeSlots, inventoryCount, stopped, wait, waitUntil, type StepContext, type StepOutcome } from './common.js';
import { dig } from './dig.js';
import { place } from './place.js';
import { use } from './use.js';
import { withinTake } from './pickup.js';
import { dimensionOf } from './walk.js';
import { isWater } from '../walkRules.js';
import { BUCKET_REACH, DIG_REACH_PLAN, FACES, OPPOSITE, clickLands, dist, eyeAtCell, eyeTo, footingBlock, isLavaSource, isOpenCell, isSolid, isWaterSource, keyOf, limitedContext,
  moveTo, rayFirst, readerOf, sameCell, shift, standCells, standHazard, timeIsUp, type Face } from './handSupport.js';

/**
 * obsidian: lava sources the planner named, made into obsidian with the water bucket and mined (contract hands-contract.md 1, 2026-10-26; run 39:
 * 446 s and no obsidian, the water hand stopped 11 times as not_filled, target_unstandable and not_arrived).
 *
 * The planner decides WHICH lava sources (`at`, 1 to 8 cells), how many obsidian (`count`), the limit (`seconds`) and what may be laid for a footing
 * (`canPlace`, `maxPlace`). The body works out the small moves: where to stand, where to pour, the wait for the lava to set, the dig, the pick-up
 * of the drop and the water back into the bucket. It never looks for lava beyond the cells it was given.
 *
 * What makes lava obsidian is water at the cell above it or beside it (not below): a source gives obsidian, a flowing cell cobblestone. So the water is
 * poured into a cell that touches the source (`direct`) or one or two cells from such a cell on a floor, from where it runs in (`flow`), from a place
 * where a click on the face of a solid block next to that cell lands (the ray the server walks from the eye, checked here). The body stands where
 * no lava is within a cell of its feet, head or the cell over it (the rim of a pool, a cell down and aside, is fine), and the water stays over the
 * hole until the obsidian is out, so that the lava round it is set by the water and does not run in.
 */
export interface ObsidianArgs { at: Cell[]; count?: number; seconds?: number; canPlace?: string[]; maxPlace?: number }

export const OBSIDIAN_DEFAULTS = { count: 1, seconds: 90, maxPlace: 6 } as const;
/** How many places to stand and pour from are tried for one source before it is given up. */
const MAX_TRIES = 5;
const MAX_DIG_TRIES = 4;
/** The longest the lava is given to set once the water is in (the game does it in a few ticks; the flow in a second). */
const SET_WAIT_MS = 3500;
const PICKUP_WAIT_MS = 2500;
/** The longest the hole is given to fill with water (which sets the lava round it), and the water round it to run dry once its source is taken. */
const HOLE_WAIT_MS = 2500;
const DROP_WAIT_MS = 1200;
const SCOOP_GRACE_S = 8;
/** The water is left to set the lava round the block before it is judged whether the drop would burn. */
const SETTLE_BEFORE_DIG_MS = 600;
const DRY_WAIT_MS = 4000;
const PICKS = ['diamond_pickaxe', 'netherite_pickaxe'];

export interface PourSpot { pour: Cell; ref: Cell; side: Face; kind: 'direct' | 'flow' }
export interface Footing { floor: Cell; from: Cell; against: Face }
export interface Plan extends PourSpot { stand: Cell; footing?: Footing; score: number }

const HORIZONTAL: Face[] = ['north', 'south', 'west', 'east'];
const FEEDS: Face[] = ['up', 'north', 'south', 'west', 'east'];
const CONTACTS: Face[] = ['up', 'north', 'south', 'west', 'east'];

/** The cells water may be poured in so that it reaches the lava `lava` (above it or beside it), and the solid face each is poured against. */
export function pourSpots(read: BlockReader, lava: Cell): PourSpot[] {
  const found: PourSpot[] = [];
  const seen = new Set<string>();
  const floored = (cell: Cell) => { const under = read(cell.x, cell.y - 1, cell.z); return !!under && !isOpenCell(under); };
  const add = (pour: Cell, kind: 'direct' | 'flow') => {
    for (const side of FACES) {
      const ref = shift(pour, side);
      if (sameCell(ref, lava) || !isSolid(read(ref.x, ref.y, ref.z))) continue;
      const key = `${keyOf(pour)}|${side}`;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ pour, ref, side, kind });
    }
  };
  for (const face of CONTACTS) {
    const contact = shift(lava, face);
    if (!isOpenCell(read(contact.x, contact.y, contact.z))) continue;
    add(contact, 'direct');
    // The water runs level over floored cells, one or two from the contact.
    let frontier = [contact];
    const visited = new Set<string>([keyOf(contact)]);
    for (let depth = 1; depth <= 2; depth++) {
      const next: Cell[] = [];
      for (const cell of frontier) for (const direction of HORIZONTAL) {
        const around = shift(cell, direction);
        if (visited.has(keyOf(around)) || sameCell(around, lava)) continue;
        visited.add(keyOf(around));
        if (!isOpenCell(read(around.x, around.y, around.z)) || !floored(around)) continue;
        next.push(around);
        add(around, 'flow');
      }
      frontier = next;
    }
  }
  return found;
}

/** Whether a dig of `target` can be begun from `stand`: within reach, and the eye sees a face of it. */
function diggableFrom(read: BlockReader, stand: Cell, target: Cell): boolean {
  if (eyeTo(stand, target) > DIG_REACH_PLAN) return false;
  return blockInSight(read, eyeAtCell(stand), target).visible;
}
/** Whether a bucket aimed at the middle of `cell` from `stand` finds that cell's source first (nothing solid in front of it). */
function scoopFrom(read: BlockReader, stand: Cell, cell: Cell): boolean {
  if (eyeTo(stand, cell) > BUCKET_REACH) return false;
  const hit = rayFirst(read, eyeAtCell(stand), [cell.x + 0.5, cell.y + 0.5, cell.z + 0.5], true);
  return !!hit && hit.fluid && sameCell(hit.cell, cell);
}

/** The nearest lava to a cell within `radius` (Chebyshev), or Infinity. */
function lavaWithin(read: BlockReader, cell: Cell, radius: number): number {
  let nearest = Infinity;
  for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) for (let dz = -radius; dz <= radius; dz++) {
    if (read(cell.x + dx, cell.y + dy, cell.z + dz)?.name === 'lava') nearest = Math.min(nearest, Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)));
  }
  return nearest;
}

export interface PlanOptions { from: Cell; excluded: Set<string>; footingOk: boolean; /** Stands with lava round them count too (to tell lava_danger from nowhere to stand). */ ignoreHazard?: boolean }

/** Every way to pour and to dig that the ground allows for one lava source, best first. */
export function planPours(read: BlockReader, lava: Cell, options: PlanOptions): Plan[] {
  const spots = pourSpots(read, lava);
  if (!spots.length) return [];
  const plans: Plan[] = [];
  const stands = standCells(read, lava, 6, lava.y - 1, lava.y + 4, false, options.ignoreHazard);
  const closeToLava = new Map<string, boolean>();
  const evaluate = (stand: Cell, extra: number, footing?: Footing) => {
    if (!diggableFrom(read, stand, lava)) return;
    const eye = eyeAtCell(stand);
    const standKey = keyOf(stand);
    let close = closeToLava.get(standKey);
    if (close === undefined) { close = lavaWithin(read, stand, 2) <= 2; closeToLava.set(standKey, close); }
    for (const spot of spots) {
      if (sameCell(spot.pour, stand) || sameCell(spot.pour, { ...stand, y: stand.y + 1 })) continue;
      if (!clickLands(read, eye, spot.ref, OPPOSITE[spot.side])) continue;
      const key = `${standKey}|${keyOf(spot.pour)}|${spot.side}`;
      if (options.excluded.has(key)) continue;
      const score = dist(stand, options.from) + (spot.kind === 'flow' ? 6 : 0) + (stand.y <= lava.y ? 8 : 0) + (close ? 3 : 0) + extra
        + (scoopFrom(read, stand, spot.pour) ? 0 : 3);
      plans.push({ ...spot, stand, ...(footing ? { footing } : {}), score });
    }
  };
  for (const stand of stands) evaluate(stand, 0);
  if (options.footingOk) {
    // One cell beyond a stand where the floor is missing: the block laid from the stand beside it (against the floor it stands on) makes it one.
    const standing = new Set(stands.map(keyOf));
    for (const from of stands) for (const direction of HORIZONTAL) {
      const stand = shift(from, direction);
      const floor = { x: stand.x, y: stand.y - 1, z: stand.z };
      if (standing.has(keyOf(stand)) || !isOpenCell(read(stand.x, stand.y, stand.z)) || !isOpenCell(read(stand.x, stand.y + 1, stand.z))
        || !isOpenCell(read(floor.x, floor.y, floor.z)) || standHazard(read, stand)) continue;
      evaluate(stand, 10 + dist(from, options.from) * 0.5, { floor, from, against: OPPOSITE[direction] });
    }
  }
  return plans.sort((a, b) => a.score - b.score);
}

const pickOf = (bot: any): string | null => PICKS.find(name => inventoryCount(bot, name) > 0) ?? null;

interface Counts { obsidian: number; pours: number; restands: number; placed: number; notes: string[] }
/** Why a source was not made into obsidian: a closed code and a few words. */
interface Why { code: string; text: string; at?: Cell }

export async function obsidian(parent: StepContext, args: ObsidianArgs): Promise<StepOutcome> {
  const bot = parent.bot;
  const sources = [...new Map((args.at ?? []).map(cell => [keyOf(cell), cell] as const)).values()];
  if (!sources.length || sources.length > 8) return stopped(bot, 'invalid_input', 'obsidian には at（溶岩の源のマス 1〜8 個）が要る');
  const want = Math.max(1, Math.min(64, Math.floor(args.count ?? OBSIDIAN_DEFAULTS.count)));
  const seconds = Math.max(5, Math.min(120, args.seconds ?? OBSIDIAN_DEFAULTS.seconds));
  const maxPlace = Math.max(0, Math.min(100, Math.floor(args.maxPlace ?? OBSIDIAN_DEFAULTS.maxPlace)));
  const ctx = limitedContext(parent, seconds);
  const counts: Counts = { obsidian: 0, pours: 0, restands: 0, placed: 0, notes: [] };
  const read = readerOf(bot);
  const stop = (code: string, text: string, at?: Cell): StepOutcome =>
    stopped(bot, code, `obsidian 止まった ${code}: ${text}（黒曜石 ${counts.obsidian} 個・水の注ぎ ${counts.pours} 回・立ち直し ${counts.restands} 回）`, at);

  // What each cell the planner named holds now: a lava source (to be set), obsidian already (only mined), anything else (not used, and said).
  const live: Cell[] = [], mineOnly: Cell[] = [], skipped: string[] = [];
  for (const cell of sources) {
    const block = read(cell.x, cell.y, cell.z);
    if (!block) skipped.push(`${cellText(cell)} は未ロード`);
    else if (isLavaSource(block)) live.push(cell);
    else if (block.name === 'obsidian') mineOnly.push(cell);
    else skipped.push(`${cellText(cell)} は ${block.name}${block.name === 'lava' ? `（流れ ${block.level}。源ではない）` : ''}`);
  }
  if (!live.length && !mineOnly.length) return stop('no_lava', `溶岩の源のマスが無い: ${skipped.join('、')}`, sources[0]);
  if (live.length && !inventoryCount(bot, 'water_bucket')) {
    return stop('no_bucket', inventoryCount(bot, 'bucket') ? '水の入ったバケツが無い（空の bucket だけ。先に水源で汲む）' : '水の入ったバケツ（water_bucket）を持っていない', live[0]);
  }
  // Water does not stay in the Nether: it steams away where it is poured.
  if (live.length && dimensionOf(bot).includes('nether')) return stop('stuck', 'ネザーでは水を注いでも蒸発して溶岩が固まらない（オーバーワールドの溶岩で）', live[0]);
  const pick = pickOf(bot);
  if (!pick) return stop('no_tool', 'ダイヤのツルハシ（diamond_pickaxe か netherite_pickaxe）を持っていない', live[0] ?? mineOnly[0]);
  // Run 46 (hold 6): the pack was full (36 of 36); two obsidian were made and dug, and neither could be picked up (no free slot, no obsidian stack to join): 117 s, 0 obsidian.
  // A pack that cannot take the obsidian is said before anything is poured or dug.
  const obsidianRoom = (): boolean => {
    if (freeSlots(bot) > 0) return true;
    return ((bot.inventory?.slots ?? []) as Array<{ name?: string; count?: number } | null | undefined>).some((item, slot) => slot >= 9 && slot <= 44 && item?.name === 'obsidian' && (item.count ?? 0) < 64);
  };
  const fullWords = () => `持ち物が満杯（${36 - freeSlots(bot)}/36）で黒曜石を拾えない。drop で空ける`;
  if (!obsidianRoom()) return stop('inventory_full', fullWords(), live[0] ?? mineOnly[0]);
  const bucketsAtStart = inventoryCount(bot, 'water_bucket');
  const obsidianAtStart = inventoryCount(bot, 'obsidian');
  const foot = footingBlock(bot, args.canPlace);
  const footingLeft = () => (foot ? Math.max(0, Math.min(maxPlace - counts.placed, inventoryCount(bot, foot))) : 0);
  const gained = () => Math.max(0, inventoryCount(bot, 'obsidian') - obsidianAtStart);

  const failures: Why[] = [];
  let waterLeft: Cell | null = null;

  /** Moves off a cell that has lava round it now. */
  const clearOfLava = async (): Promise<Why | null> => {
    const here = feetCell(bot)!;
    const said = standHazard(read, here);
    if (!said) return null;
    const away = standCells(read, here, 5, here.y - 2, here.y + 2).sort((a, b) => dist(a, here) - dist(b, here))[0];
    if (!away) return { code: 'lava_danger', text: `立つ所の周りに溶岩（${said}）。離れられる所が無い`, at: here };
    const moved = await moveTo(ctx, away);
    return moved ? { code: 'lava_danger', text: `溶岩が近い（${said}）のに離れられなかった: ${moved.text.slice(0, 60)}`, at: here } : null;
  };

  /** The water sources within 6 cells of `centre`. */
  const watersAround = (centre: Cell): Cell[] => {
    const out: Cell[] = [];
    for (let dx = -6; dx <= 6; dx++) for (let dy = -6; dy <= 6; dy++) for (let dz = -6; dz <= 6; dz++) {
      const cell = { x: centre.x + dx, y: centre.y + dy, z: centre.z + dz };
      if (isWaterSource(read(cell.x, cell.y, cell.z))) out.push(cell);
    }
    return out;
  };

  /** Whether lava lies where it would run into the hole at `cell`: over it or level with it (lava below does not rise). */
  const lavaFeeds = (cell: Cell): boolean => FEEDS.some(face => { const next = shift(cell, face); return read(next.x, next.y, next.z)?.name === 'lava'; });

  /** Whether any water stands within three cells of `cell` (a flood that has not run dry). */
  const waterNear = (cell: Cell): boolean => {
    for (let dx = -3; dx <= 3; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -3; dz <= 3; dz++) if (read(cell.x + dx, cell.y + dy, cell.z + dz)?.name === 'water') return true;
    return false;
  };

  /** The water poured: the source it made (where the click landed), or the stop. */
  const pourWater = async (plan: Plan): Promise<{ cell: Cell } | { stop: StepOutcome }> => {
    const before = new Set(watersAround(plan.stand).map(keyOf));
    const poured = await use(ctx, { item: 'water_bucket', at: plan.pour, against: plan.side });
    if (!poured.ok) return { stop: poured };
    counts.pours++;
    if (isWaterSource(read(plan.pour.x, plan.pour.y, plan.pour.z))) return { cell: plan.pour };
    // The click landed on another face than the one aimed at: the source is wherever the water stands now.
    const fresh = watersAround(plan.stand).filter(cell => !before.has(keyOf(cell)))[0];
    return fresh ? { cell: fresh } : { stop: stopped(bot, 'not_poured', `${cellText(plan.pour)} に水を注いだはずが、水の源が見えない`, plan.pour) };
  };

  /** The water in the bucket again: from where the body stands, else from a place that reaches it. */
  const scoopBack = async (cell: Cell): Promise<boolean> => {
    // The water is taken back even when the hand's own time is up (a few seconds' grace): a bucket left empty in the world is the worse stop.
    const c = timeIsUp(ctx) ? limitedContext(parent, SCOOP_GRACE_S) : ctx;
    for (let attempt = 0; attempt < 3 && !timeIsUp(c); attempt++) {
      if (!isWaterSource(read(cell.x, cell.y, cell.z))) return inventoryCount(bot, 'water_bucket') >= bucketsAtStart;
      const here = feetCell(bot)!;
      if (!scoopFrom(read, here, cell)) {
        const from = standCells(read, cell, 4, cell.y - 3, cell.y + 3, true).filter(stand => scoopFrom(read, stand, cell)).sort((a, b) => dist(a, here) - dist(b, here))[0];
        if (!from) return false;
        if (await moveTo(c, from)) { counts.restands++; continue; }
      }
      const taken = await use(c, { item: 'bucket', at: cell });
      if (taken.ok && inventoryCount(bot, 'water_bucket') >= bucketsAtStart) return true;
    }
    return inventoryCount(bot, 'water_bucket') >= bucketsAtStart;
  };

  /** The obsidian at `lava` dug, from a place that reaches it and is clear of lava; null when it is, else why not. */
  const mineAt = async (lava: Cell): Promise<Why | null> => {
    const refused = new Set<string>();
    let last: Why = { code: 'unreachable', text: `${cellText(lava)} を掘れる所に立てない（届く 4.8m 内に、見えて、溶岩の無い立てる所が無い）`, at: lava };
    for (let attempt = 0; attempt < MAX_DIG_TRIES; attempt++) {
      if (timeIsUp(ctx)) return { code: 'limit_time', text: '時間切れ（掘る前）', at: lava };
      const here = feetCell(bot)!;
      const rank = (stand: Cell) => (sameCell(stand, here) ? -100 : 0) + (stand.y > lava.y ? 0 : 8) + (isWater(read(stand.x, stand.y, stand.z)) ? 20 : 0) + Math.hypot(stand.x - here.x, stand.z - here.z);
      const stand = standCells(read, lava, 6, lava.y - 1, lava.y + 4, true).filter(cell => !refused.has(keyOf(cell)) && diggableFrom(read, cell, lava)).sort((a, b) => rank(a) - rank(b))[0];
      if (!stand) return last;
      const moved = await moveTo(ctx, stand);
      if (moved) { refused.add(keyOf(stand)); counts.restands++; last = { code: 'unreachable', text: `${cellText(stand)} に着けない: ${moved.text.slice(0, 70)}`, at: stand }; continue; }
      const dug = await dig(ctx, { at: [lava], tool: pick, collect: false });
      if (dug.ok) return null;
      if (dug.reason === 'lava_behind' || dug.reason === 'footing') {
        refused.add(keyOf(stand)); counts.restands++;
        last = { code: 'lava_danger', text: `${cellText(lava)} を掘ると隣の溶岩が流れ込む（${dug.text.slice(0, 70)}）`, at: lava };
        continue;
      }
      if (dug.reason === 'out_of_reach' || dug.reason === 'not_visible') { refused.add(keyOf(stand)); counts.restands++; last = { code: 'unreachable', text: dug.text.slice(0, 90), at: lava }; continue; }
      if (dug.reason === 'timeout' || dug.reason === 'dig_failed' || dug.reason === 'dig_unconfirmed') { last = { code: 'stuck', text: dug.text.slice(0, 90), at: lava }; continue; }
      return { code: 'stuck', text: dug.text.slice(0, 90), at: lava };
    }
    return last;
  };

  /** The drop of the obsidian dug: walked to where the body's box takes it (a cell clear of lava), and waited for. */
  const collect = async (lava: Cell, knownIds: Set<number>): Promise<void> => {
    const items = () => (Object.values(bot.entities ?? {}) as any[]).filter(entity => entity?.position && (entity.name === 'item' || entity.displayName === 'Item')
      && !knownIds.has(Number(entity.id)) && Math.hypot(entity.position.x - lava.x - 0.5, entity.position.y - lava.y - 0.5, entity.position.z - lava.z - 0.5) <= 4);
    // The drop of a block already dug is taken even when the hand's own time has run out (a few seconds' grace).
    const c = timeIsUp(ctx) ? limitedContext(parent, SCOOP_GRACE_S) : ctx;
    // The drop appears a tick or two after the block goes.
    await waitUntil(c, () => items().length > 0 || gained() > 0, DROP_WAIT_MS, 100);
    for (let round = 0; round < 3 && !timeIsUp(c); round++) {
      const item = items()[0];
      if (!item) return;
      if (!withinTake(bot.entity.position, item.position)) {
        const here = feetCell(bot)!;
        const at = item.position;
        const cellOfItem = { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) };
        const spot = standCells(read, cellOfItem, 2, cellOfItem.y - 2, cellOfItem.y + 1, true)
          .filter(stand => withinTake({ x: stand.x + 0.5, y: stand.y, z: stand.z + 0.5 }, at)).sort((a, b) => dist(a, here) - dist(b, here))[0];
        if (!spot) { counts.notes.push(`落とし物 ${cellText(cellOfItem)} は${obsidianRoom() ? '溶岩を避けた立ち位置から拾えない' : '持ち物が満杯で拾えない'}`); return; }
        if (await moveTo(c, spot)) { counts.restands++; continue; }
      }
      await waitUntil(c, () => !bot.entities?.[item.id], PICKUP_WAIT_MS, 100);
    }
  };

  /** One lava source made into obsidian and taken; null when it is, else why not. */
  const oneSource = async (lava: Cell): Promise<Why | null> => {
    let waterCell: Cell | null = null;
    let setHard = read(lava.x, lava.y, lava.z)?.name === 'obsidian';
    // Obsidian that lava can run into the hole of is covered with water first (the same pour), so that the lava does not take the drop.
    const burnsAt = () => dropBurnsIn(bot as never, new Vec3(lava.x, lava.y, lava.z));
    let needsCover = setHard && !!burnsAt() && inventoryCount(bot, 'water_bucket') > 0;
    const excluded = new Set<string>();
    let last: Why = { code: 'unreachable', text: `${cellText(lava)} に水を注げる所へ行けない`, at: lava };
    for (let attempt = 0; attempt < MAX_TRIES && (!setHard || needsCover); attempt++) {
      if (timeIsUp(ctx)) return { code: 'limit_time', text: '時間切れ', at: lava };
      const now = read(lava.x, lava.y, lava.z);
      if (now?.name === 'obsidian') setHard = true;
      else if (!isLavaSource(now)) return { code: 'no_lava', text: `${cellText(lava)} は今 ${now?.name ?? '未ロード'}（溶岩の源ではない）`, at: lava };
      const here = feetCell(bot)!;
      const plan = planPours(read, lava, { from: here, excluded, footingOk: footingLeft() > 0 })[0];
      if (!plan) {
        if (attempt > 0) return last;
        const dangerous = planPours(read, lava, { from: here, excluded, footingOk: false, ignoreHazard: true })[0];
        return dangerous
          ? { code: 'lava_danger', text: `${cellText(lava)} に届く立てる所（${cellText(dangerous.stand)} など）は溶岩の隣（${standHazard(read, dangerous.stand) ?? '溶岩'}）だけ`, at: dangerous.stand }
          : { code: 'unreachable', text: `${cellText(lava)} に水を注ぎ、掘れる立ち位置が見つからない（届く範囲に、見えて当てる面のある立てる所が無い${foot ? '' : '。足場を置くなら canPlace'}）`, at: lava };
      }
      const planKey = `${keyOf(plan.stand)}|${keyOf(plan.pour)}|${plan.side}`;
      const refuse = (why: Why) => { excluded.add(planKey); counts.restands++; last = why; };
      if (plan.footing) {
        const aside = await moveTo(ctx, plan.footing.from);
        if (aside) { refuse({ code: 'unreachable', text: `${cellText(plan.footing.from)} に着けない: ${aside.text.slice(0, 70)}`, at: plan.footing.from }); continue; }
        const laid = await place(ctx, { block: foot!, at: [plan.footing.floor], against: plan.footing.against });
        if (!laid.ok) { refuse({ code: 'unreachable', text: `足場を置けなかった: ${laid.text.slice(0, 70)}`, at: plan.footing.floor }); continue; }
        counts.placed++;
      }
      const moved = await moveTo(ctx, plan.stand);
      if (moved) { refuse({ code: 'unreachable', text: `${cellText(plan.stand)} に着けない: ${moved.text.slice(0, 70)}`, at: plan.stand }); continue; }
      const hazard = await clearOfLava();
      if (hazard) return hazard;
      const poured = await pourWater(plan);
      if ('stop' in poured) { refuse({ code: 'stuck', text: `水を注げなかった: ${poured.stop.text.slice(0, 80)}`, at: plan.pour }); continue; }
      waterCell = poured.cell;
      waterLeft = poured.cell;
      if (setHard) { needsCover = false; break; }
      if (await waitUntil(ctx, () => read(lava.x, lava.y, lava.z)?.name === 'obsidian', SET_WAIT_MS, 100)) { setHard = true; break; }
      // The lava did not set: the water is taken back and the next place is tried.
      const after = read(lava.x, lava.y, lava.z);
      if (await scoopBack(poured.cell)) waterLeft = null;
      refuse({ code: 'stuck', text: `水を注いだが ${cellText(lava)} は ${after?.name ?? '未ロード'} のまま固まらなかった（注いだ ${cellText(poured.cell)}）`, at: lava });
      if (after && after.name !== 'lava') return { code: 'no_lava', text: `${cellText(lava)} は ${after.name} になった（溶岩の源ではなくなった）`, at: lava };
    }
    if (!setHard) return last;
    // The lava is obsidian. Where the drop would not burn (no lava over it, beside it or under it), the water is taken back at once, as a person does
    // (a flooded pit slows the dig about fivefold and pushes the body out of reach) and the block is dug dry. Where lava could run into the hole or lies
    // under it, the water stays over the hole while it is dug: the hole fills, which sets the lava round it, and only then the water is taken.
    const knownIds = new Set((Object.values(bot.entities ?? {}) as any[]).map(entity => Number(entity?.id)));
    const water = waterCell ?? waterLeft;
    if (water) await wait(ctx, SETTLE_BEFORE_DIG_MS);
    const covered = !!burnsAt() && !!water;
    if (!covered && water) {
      if (await scoopBack(water)) waterLeft = null;
      await waitUntil(ctx, () => !waterNear(lava), DRY_WAIT_MS, 100);
    }
    if (!covered && !water && burnsAt()) counts.notes.push(`${cellText(lava)} は溶岩が流れ込む所を水なしで掘った（落とし物が焼けるかもしれない）`);
    if (!obsidianRoom()) { if (waterLeft && await scoopBack(waterLeft)) waterLeft = null; return { code: 'inventory_full', text: fullWords(), at: lava }; }
    const failure = await mineAt(lava);
    if (failure) {
      if (waterLeft && await scoopBack(waterLeft)) waterLeft = null;
      return failure;
    }
    if (covered) {
      const held = await waitUntil(ctx, () => !lavaFeeds(lava), HOLE_WAIT_MS, 100);
      if (held) {
        if (await scoopBack(water!)) waterLeft = null;
        await waitUntil(ctx, () => !waterNear(lava), DRY_WAIT_MS, 100);
      }
    }
    await collect(lava, knownIds);
    if (water && waterLeft && await scoopBack(water)) waterLeft = null;
    return null;
  };

  const order = [...mineOnly, ...live].sort((a, b) => {
    const here = bot.entity.position;
    return Math.hypot(a.x + 0.5 - here.x, a.z + 0.5 - here.z) - Math.hypot(b.x + 0.5 - here.x, b.z + 0.5 - here.z);
  });
  for (const lava of order) {
    if (gained() >= want) break;
    if (timeIsUp(ctx)) { if (waterLeft) await scoopBack(waterLeft); counts.obsidian = gained(); return stop('limit_time', `${seconds} 秒の上限に達した`, lava); }
    if (!obsidianRoom()) return stop('inventory_full', fullWords(), lava);
    ctx.progress?.(`${cellText(lava)} (${gained()}/${want})`);
    const failure = await oneSource(lava);
    counts.obsidian = gained();
    if (failure?.code === 'limit_time') { if (waterLeft) await scoopBack(waterLeft); return stop('limit_time', `${seconds} 秒の上限に達した`, lava); }
    if (failure?.code === 'inventory_full') { if (waterLeft) await scoopBack(waterLeft); return stop('inventory_full', failure.text, lava); }
    if (failure) failures.push(failure);
  }
  counts.obsidian = gained();
  // Run 46 (hold 7): a source of water left over the pool sank the next stand (two deep, the swim reflex stopping every dig): whatever ended the hand, the water is taken back once more.
  if (waterLeft && await scoopBack(waterLeft)) waterLeft = null;

  const waterBack = inventoryCount(bot, 'water_bucket') >= bucketsAtStart;
  if (!waterBack && waterLeft) counts.notes.push(`水が ${cellText(waterLeft)} に残った`);
  const extras = [counts.placed ? `足場 ${counts.placed} 個` : '', ...skipped.map(text => `飛ばした ${text}`), ...counts.notes].filter(Boolean).join('・');
  if (counts.obsidian >= want) {
    if (!waterBack) return stop('stuck', `黒曜石は取れたが水をバケツに戻せなかった${extras ? `（${extras}）` : ''}`, waterLeft ?? order[0]);
    return { ok: true, text: `obsidian 済 黒曜石 ${counts.obsidian} 個・水の注ぎ ${counts.pours} 回・立ち直し ${counts.restands} 回・水回収済${extras ? `・${extras}` : ''}`, at: order[order.length - 1] };
  }
  if (timeIsUp(ctx) && !failures.length) return stop('limit_time', `${seconds} 秒の上限に達した${extras ? `（${extras}）` : ''}`, order[0]);
  const why = failures[0] ?? { code: 'no_lava', text: `挙げた溶岩の源 ${order.length} 個を使い切った`, at: order[0] };
  return stop(why.code, `${why.text}${failures.length > 1 ? `（ほか ${failures.length - 1} 個も）` : ''}${extras ? `。${extras}` : ''}${waterBack ? '' : '。水は戻せていない'}。${want} 個のうち ${counts.obsidian} 個`, why.at);
}

const COMMON_FIELDS = ['do', 'rel', 'note', 'onFail'];
const BLOCK_NAME = /^[a-z][a-z0-9_]{0,39}$/u;
/**
 * What is wrong with an obsidian hand beyond the schema, in the head's own ranges (minecraftActHandRules.ts: needs `at`; may `count`, `seconds`,
 * `canPlace`, `maxPlace`; `at` 1 to 8, `seconds` 5 to 120, `count` 1 to 64): a field the kind does not take, a missing `at`, a range. Null when it is well formed.
 */
export function obsidianProblem(hand: Record<string, unknown>, cellOk: (spec: unknown) => boolean): string | null {
  const allowed = new Set([...COMMON_FIELDS, 'at', 'count', 'seconds', 'canPlace', 'maxPlace']);
  const extra = Object.keys(hand).filter(key => hand[key] !== undefined && !allowed.has(key));
  if (extra.length) return `${extra.join('・')} は使えない（obsidian の欄: at・count・seconds・canPlace・maxPlace）`;
  const at = hand.at;
  if (!Array.isArray(at) || !at.length) return 'at（溶岩の源のマス）が要る';
  if (at.length > 8) return 'at は溶岩の源のマス 8 つまで';
  if (!at.every(cellOk)) return 'at のマスが読めない';
  const seconds = hand.seconds as number | undefined, count = hand.count as number | undefined;
  if (seconds !== undefined && (seconds < 5 || seconds > 120)) return 'seconds は 5〜120';
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 64)) return 'count は 1〜64 の整数';
  if (Array.isArray(hand.canPlace) && (hand.canPlace as string[]).some(name => !BLOCK_NAME.test(name))) return 'canPlace はブロックの id（小文字の英字と _）';
  return null;
}
