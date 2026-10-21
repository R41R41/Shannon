import { Vec3 } from 'vec3';
import pathfinder from 'mineflayer-pathfinder';
import type { CustomBot } from '../types.js';
import { createLogger } from '../../../utils/logger.js';
import { actionDelay } from '../execution/observedWait.js';
import { activateItemFacing } from './activateItemFacing.js';
import { gotoSafe } from './gotoSafe.js';
import { chooseRockTravel } from './rockTravel.js';
import { LIQUID_REACH, liquidAimPoints } from './liquidAim.js';
import { getWaterLevel } from './waterLevel.js';

const { goals } = pathfinder;
const log = createLogger('Minebot:scoopWater');

/**
 * Water into an empty bucket, found and reached by the body (run 20: the bucket was made at +381 s and no water was taken on the surface;
 * the body went down to y-58 and then spent 325 s and three decisions looking for water there, and had no obsidian for the Nether).
 *
 * The planner may name a cell (any cell: the source, a flowing cell, the cell above or below the surface) or name none. Either way the
 * body picks the sources it can reach, nearest and in the open first, walks to a cell from which the server's own ray from the eyes meets
 * the source (the bucket is resolved by the server, not by a click on a block), scoops, and says where and how long it took.
 *
 * `water_bucket` and `bucket` are never thrown away or used here; the pack keeps the water for the trip down.
 */

/** Blocks the body does not stand in or beside. */
const HAZARD = new Set(['lava', 'fire', 'soul_fire', 'cactus', 'magma_block', 'sweet_berry_bush', 'wither_rose', 'powder_snow', 'cobweb',
  'campfire', 'soul_campfire', 'bubble_column']);
const RING_STEPS = [16, 32, 48, 64, 96];
const MAX_ATTEMPTS = 5;
/** How long the server is given to turn the bucket into water_bucket (ms): the first use, then each other point. Mutable for tests. */
export const SCOOP_WAIT = { first: 1500, next: 1000 };

export interface ScoopOptions {
  /** A cell the caller named (the water, or next to it); the body takes this water first, else the nearest source. */
  near?: Vec3;
  /** How far to look for a source (default 48). */
  maxDistance?: number;
  /** Time for the whole look, walk and scoop (default 60 s). */
  budgetMs?: number;
  shouldStop?: () => boolean;
}

export interface ScoopOutcome { success: boolean; result: string; failureType?: string; recoverable?: boolean }

type Block = { name: string; boundingBox?: string; position?: Vec3 } | null | undefined;

const keyOf = (at: Vec3) => `${at.x},${at.y},${at.z}`;
const itemsOf = (bot: CustomBot) => bot.inventory.items();
const countOf = (bot: CustomBot, name: string) => itemsOf(bot).filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
const isLiquid = (block: Block) => !!block && (block.name === 'water' || block.name === 'lava' || block.name === 'bubble_column');
const isOpen = (block: Block) => !!block && block.boundingBox === 'empty' && !isLiquid(block);
const isSource = (block: Block) => !!block && block.name === 'water' && getWaterLevel(block) === 0;

/** Blocks the bucket's ray passes: nothing is there, or only liquid. Every other block (grass, flowers, snow, rails... which a body walks through) stops the server's ray: it is cast against outlines, not collision. */
const RAY_PASSES = new Set(['air', 'cave_air', 'void_air', 'water', 'bubble_column']);
/** The world as the server's ray sees it. */
function rayView(bot: CustomBot): { entity: { position: Vec3 }; blockAt(at: Vec3): any } {
  return { get entity() { return bot.entity; }, blockAt: (at: Vec3) => {
    const block = bot.blockAt(at) as any;
    return block && block.boundingBox === 'empty' && !RAY_PASSES.has(block.name) ? { ...block, boundingBox: 'block' } : block;
  } };
}
/** Whether no solid block (leaves aside) roofs the cell for 24 blocks: water in the open, not in a cave. */
export function underSky(bot: CustomBot, at: Vec3): boolean {
  for (let dy = 1; dy <= 24; dy++) {
    const block = bot.blockAt(at.offset(0, dy, 0)) as Block;
    if (!block) return true;
    if (block.boundingBox === 'block' && !block.name.endsWith('_leaves')) return false;
  }
  return true;
}

/**
 * Water sources (level 0) within `radius` of the body, in the open first (a source with air over it, the way a bucket reaches it),
 * nearest first; with none, the ones under ice (the ice is broken first).
 */
async function sourcesWithin(bot: CustomBot, radius: number, skip: Set<string>): Promise<{ sources: Vec3[]; iced: Set<string> }> {
  const waterId = (bot as any).registry?.blocksByName?.water?.id;
  const iced = new Set<string>();
  if (typeof (bot as any).findBlocks !== 'function' || waterId === undefined) return { sources: [], iced };
  const here = bot.entity.position;
  const search = async (accept: (block: any) => boolean): Promise<Vec3[]> => {
    await new Promise<void>(resolve => setImmediate(resolve));
    const found: Vec3[] = (bot as any).findBlocks({ matching: waterId, maxDistance: radius, count: 400,
      useExtraInfo: (block: any) => getWaterLevel(block) === 0 && accept(block) }) ?? [];
    return found.filter(at => !skip.has(keyOf(at)));
  };
  const rank = (list: Vec3[]) => list
    .map(at => ({ at, cost: at.distanceTo(here) + (underSky(bot, at) ? 0 : 20) }))
    .sort((a, b) => a.cost - b.cost).slice(0, 24).map(entry => entry.at);
  const open = (block: any) => isOpen(bot.blockAt(block.position.offset(0, 1, 0)) as Block);
  const surface = rank(await search(open));
  if (surface.length) return { sources: surface, iced };
  // Under ice: the ice cell is what the body walks to and breaks (it turns to water). Water under rock or anything else is not reachable.
  const under = await search(block => (bot.blockAt(block.position.offset(0, 1, 0)) as Block)?.name === 'ice');
  const cells = rank(under).map(at => at.offset(0, 1, 0));
  for (const cell of cells) iced.add(keyOf(cell));
  return { sources: cells, iced };
}

/** Cells a body can stand in with the eyes on `source`: open floor (or shallow water) within three blocks of it, nearest to the body first. */
function standsFor(bot: CustomBot, source: Vec3): Array<{ feet: Vec3; cost: number }> {
  const here = bot.entity.position;
  const out: Array<{ feet: Vec3; cost: number }> = [];
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -2; dy <= 2; dy++) {
    const feet = source.offset(dx, dy, dz);
    const body = bot.blockAt(feet) as Block, head = bot.blockAt(feet.offset(0, 1, 0)) as Block, floor = bot.blockAt(feet.offset(0, -1, 0)) as Block;
    if (!body || !head || !floor || HAZARD.has(body.name) || HAZARD.has(head.name) || HAZARD.has(floor.name)) continue;
    const dry = isOpen(body) && isOpen(head) && floor.boundingBox === 'block';
    // In shallow water the body wades; only when no dry cell serves (a lake's own middle).
    const wet = !dry && body.name === 'water' && head.boundingBox === 'empty' && head.name !== 'lava';
    if (!dry && !wet) continue;
    if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => (bot.blockAt(feet.offset(x, 0, z)) as Block)?.name === 'lava')) continue;
    const middle = feet.offset(0.5, 0, 0.5);
    if (liquidAimPoints({ entity: { position: middle }, blockAt: rayView(bot).blockAt }, source).points.length === 0) continue;
    out.push({ feet, cost: here.distanceTo(middle) + (wet ? 6 : 0) + source.distanceTo(middle) * 0.2 });
  }
  return out.sort((a, b) => a.cost - b.cost);
}

/** The nearest stands (by the straight line) that are priced by the way to them. */
const STAND_PRICED = 4;
/** What a stand no way fits is priced at (metres' worth), against a walk or a tunnel priced at three metres a second. */
const NO_WAY_COST = 120;
/** The way to a stand priced in metres' worth: a walk or a tunnel cut by its seconds, the route search's own (open ground) at nothing, no way that fits at NO_WAY_COST. */
export function standTravelCost(bot: CustomBot, feet: Vec3): number {
  try {
    const choice = chooseRockTravel(bot, new goals.GoalBlock(feet.x, feet.y, feet.z) as never);
    if (choice.mode === 'walk' || choice.mode === 'cells') return choice.seconds * 3;
    return choice.why.startsWith('nothing_fits') ? NO_WAY_COST : 0;
  } catch { return 0; }
}
/** A walk of the scoop's own goes through rock as a tunnel of straight runs, like move-to (utils/rockTravel). */
function walkOptions(bot: CustomBot): { rockTravel: boolean; tunnelPillar: (height: number) => Promise<unknown> } {
  const pickaxe = itemsOf(bot).some(item => item.name.includes('pickaxe'));
  return { rockTravel: pickaxe, tunnelPillar: async (height: number) => (bot as any).instantSkills?.getSkill?.('tower-up')?.run?.(height) };
}

/** The source whose points the eyes can reach from where the body stands now. */
function aimFromHere(bot: CustomBot, sources: Vec3[]): { source: Vec3; points: Vec3[] } | null {
  const eyes = bot.entity.position.offset(0, 1.62, 0);
  const near = sources.filter(at => eyes.distanceTo(at.offset(0.5, 0.5, 0.5)) <= LIQUID_REACH + 1.5).sort((a, b) => eyes.distanceTo(a) - eyes.distanceTo(b)).slice(0, 30);
  for (const source of near) {
    const { points } = liquidAimPoints(rayView(bot), source);
    if (points.length) return { source, points };
  }
  return null;
}

/** The server's word, up to a moment after the use: the held bucket has turned into water. */
async function waterInHand(bot: CustomBot, waitMs = 1500): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline && bot.heldItem?.name !== 'water_bucket') await actionDelay(bot, 100);
  return bot.heldItem?.name === 'water_bucket';
}

async function useBucketAt(bot: CustomBot, points: Vec3[]): Promise<boolean> {
  for (const [index, point] of points.slice(0, 4).entries()) {
    // Water already in the hand (the server's word came late): another use would pour it back.
    if (bot.heldItem?.name === 'water_bucket') return true;
    if (bot.heldItem?.name !== 'bucket') {
      const bucket = itemsOf(bot).find(item => item.name === 'bucket');
      if (bucket) await bot.equip(bucket, 'hand');
    }
    try {
      await activateItemFacing(bot, point);
      log.info(`💧 バケツを使用 目=(${bot.entity.position.x.toFixed(2)},${(bot.entity.position.y + 1.62).toFixed(2)},${bot.entity.position.z.toFixed(2)}) 狙い=(${point.x.toFixed(2)},${point.y.toFixed(2)},${point.z.toFixed(2)}) yaw=${bot.entity.yaw.toFixed(2)} pitch=${bot.entity.pitch.toFixed(2)}`);
      if (await waterInHand(bot, index === 0 ? SCOOP_WAIT.first : SCOOP_WAIT.next)) return true;
    } catch { /* the next point */ }
  }
  return bot.heldItem?.name === 'water_bucket';
}
/** The sources a planner's cell stands for: the cell itself when it is a source, else the cell above or below it, else the nearest source within eight blocks. */
export function resolveNamedWater(bot: CustomBot, near: Vec3): { sources: Vec3[]; note: string } {
  const at = (cell: Vec3) => bot.blockAt(cell) as Block;
  if (isSource(at(near))) return { sources: [near], note: '' };
  for (const [dy, why] of [[-1, '指定の座標は水の1つ上'], [1, '指定の座標は水の1つ下'], [-2, '指定の座標は水の2つ上']] as const) {
    const cell = near.offset(0, dy, 0);
    if (isSource(at(cell))) return { sources: [cell], note: `${why}だったので(${cell.x},${cell.y},${cell.z})の水源を汲む。` };
  }
  const found: Array<{ at: Vec3; d: number }> = [];
  for (let dx = -8; dx <= 8; dx++) for (let dy = -4; dy <= 4; dy++) for (let dz = -8; dz <= 8; dz++) {
    const cell = near.offset(dx, dy, dz);
    if (isSource(at(cell))) found.push({ at: cell, d: Math.hypot(dx, dy * 1.5, dz) });
  }
  found.sort((a, b) => a.d - b.d);
  if (!found.length) return { sources: [], note: '' };
  const flowing = at(near)?.name === 'water';
  return { sources: found.slice(0, 6).map(entry => entry.at),
    note: `${flowing ? '指定の座標は水流（源ではない）' : '指定の座標に水源は無い'}ため、近くの水源(${found[0].at.x},${found[0].at.y},${found[0].at.z})を汲む。` };
}

export async function scoopWater(bot: CustomBot, options: ScoopOptions = {}): Promise<ScoopOutcome> {
  const stop = options.shouldStop ?? (() => false);
  const radiusMax = Math.max(8, Math.min(128, Math.floor(options.maxDistance ?? 48)));
  const budget = options.budgetMs ?? 60_000;
  const startedAt = Date.now();
  const left = () => budget - (Date.now() - startedAt);
  const start = bot.entity.position.clone();

  if (countOf(bot, 'water_bucket') > 0) {
    if (bot.heldItem?.name !== 'water_bucket') {
      const filled = itemsOf(bot).find(item => item.name === 'water_bucket');
      if (filled) { try { await bot.equip(filled, 'hand'); } catch { /* it is in the pack all the same */ } }
    }
    return { success: true, result: 'すでに水入りのバケツ(water_bucket)を持っています。地下では水を探さず、この水を持って下りてください' };
  }
  if (countOf(bot, 'bucket') === 0) {
    const iron = countOf(bot, 'iron_ingot');
    return { success: false, failureType: 'material_missing', recoverable: true,
      result: `バケツを持っていません（鉄 3 個で craft-one bucket。いま鉄は${iron}個${iron >= 3 ? '：作れます' : '：足りません'}）` };
  }

  const failedSources = new Set<string>();
  const failedStands = new Set<string>();
  /** Scoops that failed from where the body stood, by cell: from the same cell a third source is not tried, another stand is. */
  const failedAt = new Map<string, number>();
  const reasons: string[] = [];
  let walked = 0, memoryTrips = 0, ring = 0, attempts = 0;
  let nearestSeen: Vec3 | null = null;
  const visitedMemory = new Set<string>();
  let named = options.near ? resolveNamedWater(bot, options.near) : { sources: [] as Vec3[], note: '' };
  if (options.near && !named.sources.length) reasons.push(`指定の座標(${options.near.x},${options.near.y},${options.near.z})の近く(8m)に水源がありません`);
  let note = named.note;

  const done = (source: Vec3, how: string): ScoopOutcome => {
    const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
    const distance = Math.round(bot.entity.position.distanceTo(start));
    log.info(`💧 水を汲んだ (${source.x},${source.y},${source.z}) ${seconds}秒 ${distance}m ${how}`);
    return { success: true,
      result: `water_bucketを入手しました（水を(${source.x},${source.y},${source.z})から回収。${note}${distance > 1 ? `${distance}m歩いて、` : ''}約${seconds}秒）。`
        + '水入りのバケツを持っています（手に持っています）。地下では水を探さず、この水を持って下りてください（捨てない・使わない。ネザーでは水は置けません）' };
  };

  while (attempts < MAX_ATTEMPTS && left() > 3_000 && !stop()) {
    attempts++;
    let sources: Vec3[] = [], iced = new Set<string>();
    const preferred = named.sources.filter(at => !failedSources.has(keyOf(at)) && (isSource(bot.blockAt(at) as Block)));
    if (preferred.length) sources = preferred;
    else {
      while (ring < RING_STEPS.length) {
        const radius = Math.min(RING_STEPS[ring], radiusMax);
        const found = await sourcesWithin(bot, radius, failedSources);
        if (found.sources.length) { sources = found.sources; iced = found.iced; break; }
        if (radius >= radiusMax) { ring = RING_STEPS.length; break; }
        ring++;
      }
    }
    if (!sources.length) {
      // None in what is loaded: the places remembered (nearest first; two trips at most, one underground, where the way is rock and slow to
      // dig: run 20 took 110 s for 32 m), then the search again from there.
      const deep = !underSky(bot, bot.entity.position.floored());
      if (memoryTrips < (deep ? 1 : 2) && left() > 10_000) {
        let remembered: Array<{ position: { x: number; y: number; z: number }; distance: number }> = [];
        try { remembered = (bot as any).placeMemory?.recall?.('water', 6) ?? []; } catch { remembered = []; }
        const place = remembered.filter(entry => entry.distance > 6 && entry.distance <= 160 && !visitedMemory.has(keyOf(new Vec3(entry.position.x, entry.position.y, entry.position.z))))[0];
        if (place) {
          memoryTrips++;
          visitedMemory.add(keyOf(new Vec3(place.position.x, place.position.y, place.position.z)));
          reasons.push(`記憶の水(${place.position.x},${place.position.y},${place.position.z})${Math.round(place.distance)}mへ向かった`);
          const before = bot.entity.position.clone();
          try { await gotoSafe(bot, new goals.GoalNear(place.position.x, place.position.y, place.position.z, 4), { timeoutMs: Math.min(deep ? 20_000 : 25_000, left() - 4_000), ...walkOptions(bot) }); } catch { /* judged by the search */ }
          walked += before.distanceTo(bot.entity.position);
          ring = 0; attempts--;
          continue;
        }
      }
      break;
    }
    nearestSeen ??= sources[0];
    const hereKey = keyOf(bot.entity.position.floored());
    let hit = (failedAt.get(hereKey) ?? 0) >= 2 ? null : aimFromHere(bot, sources);
    if (!hit) {
      if ((failedAt.get(hereKey) ?? 0) >= 2) failedStands.add(hereKey);
      const plans: Array<{ source: Vec3; feet: Vec3; cost: number }> = [];
      // Water in the open is worth a longer walk than water in a cave (twenty blocks' worth).
      // The stands already tried come off the list before the best three are taken: the fourth was never reached while the first three, which
      // the body could not stand in, stayed on it (run 23: いまは地下・屋根の下, stands (32,49,-238) and (32,49,-239) tried and 水際の立ち位置なし).
      for (const source of sources.slice(0, 12)) {
        const cave = underSky(bot, source) ? 0 : 20;
        for (const stand of standsFor(bot, source).filter(entry => !failedStands.has(keyOf(entry.feet))).slice(0, 3)) plans.push({ source, feet: stand.feet, cost: stand.cost + cave });
      }
      // The nearest few are priced by the way to them (a walk, a tunnel cut, or none that fits), not by the straight line alone: a stand across
      // a wall or a pond is dearer than one a few blocks further on the same side.
      const nearest = plans.sort((a, b) => a.cost - b.cost).slice(0, STAND_PRICED);
      // One stand at a time with the thread given back between: each is a search of up to 0.4 s (run 25: stops of 1.8 s).
      for (const entry of nearest) { entry.cost += standTravelCost(bot, entry.feet); await new Promise<void>(resolve => setImmediate(resolve)); }
      const plan = nearest.sort((a, b) => a.cost - b.cost)[0];
      const goal = plan ? new goals.GoalBlock(plan.feet.x, plan.feet.y, plan.feet.z) : new goals.GoalNear(sources[0].x, sources[0].y, sources[0].z, 2);
      if (plan) failedStands.add(keyOf(plan.feet));
      const before = bot.entity.position.clone();
      const distance = before.distanceTo((plan?.feet ?? sources[0]).offset(0.5, 0, 0.5));
      let walkNote = '';
      try {
        const walk = await gotoSafe(bot, goal, { timeoutMs: Math.max(5_000, Math.min(left() - 3_000, 12_000 + distance * 700, 45_000)), ...walkOptions(bot) });
        // What stopped the walk, as the walk said it (the block, where it is, where it lies from the body), is passed on.
        if (!walk.success) walkNote = `（${walk.error ?? '失敗'}${walk.activity ? `: ${walk.activity}` : ''}${walk.stuckBlock ? `。止まった所の${walk.stuckBlock.name}(${walk.stuckBlock.x},${walk.stuckBlock.y},${walk.stuckBlock.z})` : ''}）`;
      }
      catch { /* judged by the aim below */ }
      walked += before.distanceTo(bot.entity.position);
      hit = aimFromHere(bot, sources);
      if (!hit) { reasons.push(plan ? `(${plan.feet.x},${plan.feet.y},${plan.feet.z})の立ち位置まで行けなかった${walkNote}` : `水際の立ち位置が見つからなかった${walkNote}`); continue; }
    }
    // Ice over the water is broken first: the cell turns to water.
    if (iced.has(keyOf(hit.source))) {
      const ice = bot.blockAt(hit.source) as any;
      if (ice?.name === 'ice') { try { await bot.dig(ice); } catch { /* the cell is read below */ } await actionDelay(bot, 300); }
      if (!isSource(bot.blockAt(hit.source) as Block)) { failedSources.add(keyOf(hit.source)); reasons.push(`氷(${hit.source.x},${hit.source.y},${hit.source.z})を割っても水にならなかった`); continue; }
      note += '氷を割って水を出した。';
      const again = liquidAimPoints(rayView(bot), hit.source);
      if (!again.points.length) { failedSources.add(keyOf(hit.source)); continue; }
      hit = { source: hit.source, points: again.points };
    }
    if (await useBucketAt(bot, hit.points)) return done(hit.source, 'ok');
    failedSources.add(keyOf(hit.source));
    const usedAt = keyOf(bot.entity.position.floored());
    failedAt.set(usedAt, (failedAt.get(usedAt) ?? 0) + 1);
    reasons.push(`水源(${hit.source.x},${hit.source.y},${hit.source.z})にバケツを使ったが汲めなかった（手持ち: ${bot.heldItem?.name ?? 'なし'}）`);
    if (named.sources.length) named = { sources: [], note: '' };
  }

  if (stop()) return { success: false, failureType: 'interrupted', recoverable: true, result: `水汲みを中断しました（${Math.round((Date.now() - startedAt) / 1000)}秒）` };
  const here = bot.entity.position;
  const where = `いまの位置は(${Math.floor(here.x)},${Math.floor(here.y)},${Math.floor(here.z)})${underSky(bot, here.floored()) ? '' : '（地下・屋根の下）'}`;
  const tried = reasons.length ? `試したこと: ${reasons.slice(-4).join('、')}。` : '';
  if (!nearestSeen) {
    return { success: false, failureType: 'target_not_found', recoverable: true,
      result: `半径${radiusMax}m（読み込み済みの範囲）に、バケツで汲める水源が見つかりませんでした。${tried}${where}。水がどの方角・何mにあるかは分かっていません。`
        + '地上の低い土地（海・川・湖）へ移動して、もう一度 use-item-on-block(itemName=bucket) を座標なしで呼ぶか、find-blocks(blockName=water, maxDistance=96) / recall-places で水の場所を探してください。'
        + '地下で探すより、地上へ戻る方が早いことが多いです' };
  }
  const gap = Math.round(nearestSeen.distanceTo(here));
  if (failedSources.size === 0) {
    return { success: false, failureType: 'movement_incomplete', recoverable: true,
      result: `水源は見えています（いちばん近い(${nearestSeen.x},${nearestSeen.y},${nearestSeen.z})まで約${gap}m）が、バケツが届く岸まで行けませんでした。${tried}${where}。`
        + 'その水の岸まで move-to で近づいてから（高低差や壁があれば先に道を作る）、もう一度呼んでください' };
  }
  return { success: false, failureType: 'line_of_sight_blocked', recoverable: true,
    result: `水源${failedSources.size}か所を試しましたが汲めませんでした。${tried}${where}。別の岸（水源の真横か真上）へ move-to で近づいてから、もう一度呼んでください` };
}
