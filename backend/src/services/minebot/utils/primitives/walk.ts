import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { buildMovements } from '../setMovements.js';
import { nextLeg, FAR_LEG_M } from '../farLegs.js';
import { feetCell, symbolFor, type Cell } from '../localMap.js';
import { cellText, guard, letGo, placeText, stopped, StepStopped, wait, type StepContext, type StepOutcome } from './common.js';

const { goals } = pathfinder;

/**
 * walk: to a cell, or along cells in order. It neither digs nor lays a block (design mb-llm-centric 2.3): a step up of one block, a drop
 * of three at most, swimming, doors. The route search finds the way over the ground there is; a far walk is planned 64 m at a time. When
 * it cannot go on it stops and says where and why (the wall's block and cell, a drop, lava, water, nothing loaded), and the planner,
 * which sees the map, chooses the digging or the bridge.
 */
export interface WalkArgs { to?: Cell; path?: Cell[]; range?: number; sprint?: boolean }

/** No headway for this long (moved less than NO_PROGRESS_M): the walk is stuck. */
const STUCK_MS = 4000;
const NO_PROGRESS_M = 0.5;
const MAX_DROP = 3;
/** How far along the straight line a stopped walk is read for what stopped it. */
const SCAN_CELLS = 24;

type Cellish = { name: string; solid: boolean } | null;
function read(bot: any, x: number, y: number, z: number): Cellish {
  let block: any;
  try { block = bot.blockAt?.(new Vec3(x, y, z), false); } catch { block = null; }
  if (!block) return null;
  return { name: String(block.name), solid: block.boundingBox === 'block' };
}
const passable = (cell: Cellish) => !!cell && !cell.solid && cell.name !== 'lava' && !['f', 'x'].includes(symbolFor({ name: cell.name, solid: false }));

/**
 * Why the straight line from the feet toward `to` cannot be walked, read cell by cell as a body walks it (a step up of one with room
 * over the head, a drop of three at most): the first wall, overhang, drop, lava or unloaded cell, or null when the line is open.
 */
export function whyBlocked(bot: any, from: Cell, to: Cell): { reason: string; text: string; at: Cell } | null {
  let x = from.x, y = from.y, z = from.z;
  const dx = to.x - from.x, dz = to.z - from.z;
  const steps = Math.min(SCAN_CELLS, Math.max(Math.abs(dx), Math.abs(dz)));
  for (let i = 1; i <= steps; i++) {
    const nx = from.x + Math.round((dx * i) / Math.max(Math.abs(dx), Math.abs(dz))), nz = from.z + Math.round((dz * i) / Math.max(Math.abs(dx), Math.abs(dz)));
    if (nx === x && nz === z) continue;
    const feet = read(bot, nx, y, nz), head = read(bot, nx, y + 1, nz);
    if (!feet || !head) return { reason: 'unloaded', text: `(${nx},${y},${nz}) は未ロード`, at: { x: nx, y, z: nz } };
    if (feet.name === 'lava' || head.name === 'lava') return { reason: 'lava', text: `(${nx},${feet.name === 'lava' ? y : y + 1},${nz}) が溶岩`, at: { x: nx, y, z: nz } };
    if (feet.solid) {
      const over = read(bot, nx, y + 2, nz), above = read(bot, x, y + 2, z);
      if (passable(head) && passable(over) && passable(above)) { x = nx; z = nz; y = y + 1; continue; }
      const why = !passable(head) ? `(${nx},${y},${nz}) ${feet.name} と (${nx},${y + 1},${nz}) ${head?.name}` : !passable(over)
        ? `段の上 (${nx},${y + 2},${nz}) が ${over?.name} で頭がつかえる` : `跳ぶ所の頭上 (${x},${y + 2},${z}) が ${above?.name}`;
      return { reason: 'wall', text: `壁: ${why}（一歩ではない）`, at: { x: nx, y, z: nz } };
    }
    if (!passable(head)) return { reason: 'low_ceiling', text: `頭の高さ (${nx},${y + 1},${nz}) が ${head!.name} で通れない`, at: { x: nx, y: y + 1, z: nz } };
    if (feet.name === 'water' || head.name === 'water') { x = nx; z = nz; continue; }
    let drop = 0;
    for (; drop <= MAX_DROP + 1; drop++) {
      const below = read(bot, nx, y - 1 - drop, nz);
      if (!below) return { reason: 'unloaded', text: `(${nx},${y - 1 - drop},${nz}) は未ロード`, at: { x: nx, y: y - 1 - drop, z: nz } };
      if (below.name === 'lava') return { reason: 'lava', text: `下 (${nx},${y - 1 - drop},${nz}) が溶岩`, at: { x: nx, y: y - 1 - drop, z: nz } };
      if (below.solid || below.name === 'water') break;
    }
    if (drop > MAX_DROP) return { reason: 'drop', text: `(${nx},${y},${nz}) の先が${drop}段以上の落差（降りられない）`, at: { x: nx, y, z: nz } };
    x = nx; z = nz; y -= drop;
  }
  return null;
}

/**
 * What the ground says of a target the walk could not reach when its straight line showed nothing in the way (scene replay 2026-10-21,
 * run 25: "(201,48,277) is air" seven times, the shaft over her unseen): how far above her feet it is, and how many cells of air are
 * under it (no floor to stand on). Exact facts only; the way up is the planner's.
 */
export function reachFacts(bot: any, from: Cell, to: Cell): string {
  const facts: string[] = [];
  const dy = to.y - from.y;
  if (dy >= 2) facts.push(`着く所は足より${dy}上（walk の段差は1まで）`);
  let air = 0;
  for (; air < 5; air++) {
    const below = read(bot, to.x, to.y - 1 - air, to.z);
    if (!below || below.solid || below.name === 'water' || below.name === 'lava') break;
  }
  if (air > 0) facts.push(`着く所の下 ${air >= 5 ? '5以上' : air} マスが空気（立つ床が無い）`);
  return facts.join('。');
}

function walkMovements(bot: any, sprint: boolean): any {
  // towers off, sprint as asked, parkour (the safe one), doors, no digging, the falling-block rule, dig cost, no free motion, swim,
  // a drop of three, water at its usual price, and no block laid.
  return buildMovements(bot, false, sprint, true, true, false, true, 1, false, true, MAX_DROP, 10, false);
}

async function walkTo(ctx: StepContext, target: Cell, range: number, sprint: boolean): Promise<StepOutcome | null> {
  const bot = ctx.bot;
  const goal = range > 0 ? new goals.GoalNear(target.x + 0.5, target.y, target.z + 0.5, range) : new goals.GoalBlock(target.x, target.y, target.z);
  let attempt = 0;
  for (;;) {
    const leg = nextLeg(bot, goal as never, attempt, FAR_LEG_M);
    const started = feetCell(bot)!;
    let last = bot.entity.position.clone(), lastMoveAt = Date.now(), stuck = false;
    const watch = setInterval(() => {
      const now = bot.entity?.position;
      if (!now) return;
      if (now.distanceTo(last) >= NO_PROGRESS_M) { last = now.clone(); lastMoveAt = Date.now(); return; }
      if (Date.now() - lastMoveAt >= STUCK_MS) { stuck = true; try { bot.pathfinder.stop(); bot.pathfinder.setGoal(null); } catch { /* stopped below */ } }
    }, 250);
    let error: unknown = null;
    try {
      const done = await guard(ctx, Promise.resolve(bot.pathfinder.goto(leg.goal)), Math.max(1000, ctx.deadline - Date.now()));
      if (!done) { letGo(bot); return stopped(bot, 'timeout', `${cellText(target)} へ歩く途中で時間切れ（今 ${placeText(bot, feetCell(bot)!)}）`, feetCell(bot)!, started); }
    } catch (caught) {
      if (caught instanceof StepStopped || /Action interrupted/u.test(String((caught as Error)?.message))) { letGo(bot); throw caught; }
      error = caught;
    } finally { clearInterval(watch); }
    const here = feetCell(bot)!;
    if (!error && !stuck) {
      if (leg.final) return null;
      attempt = 0;
      continue;
    }
    letGo(bot);
    const message = String((error as Error)?.message ?? (stuck ? 'stuck' : 'unknown'));
    const blocked = whyBlocked(bot, here, target);
    if (!leg.final && /no path/iu.test(message) && attempt < 2) { attempt++; continue; }
    const reach = reachFacts(bot, here, target);
    if (stuck) return stopped(bot, blocked?.reason ?? 'stuck', `${STUCK_MS / 1000}秒進めず止まった（今 ${placeText(bot, here)}）。${blocked ? blocked.text : reach || '前に見える障害は無い（体が何かに引っかかっている）'}`, blocked?.at ?? here, here);
    if (/no path|took to long|too long/iu.test(message)) {
      return stopped(bot, blocked?.reason ?? 'no_path', `${cellText(target)} への掘らない道が無い（今 ${placeText(bot, here)}）。${blocked ? blocked.text : reach || 'まっすぐの線は開いているが、遠回りの道も見つからない（未ロードか、囲まれている）'}`, blocked?.at ?? target, here);
    }
    return stopped(bot, 'walk_failed', `${cellText(target)} へ歩けなかった: ${message.slice(0, 80)}（今 ${placeText(bot, here)}）`, here, here);
  }
}

export async function walk(ctx: StepContext, args: WalkArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const targets = args.path?.length ? args.path : args.to ? [args.to] : [];
  if (!targets.length) return stopped(bot, 'invalid_input', 'walk には to か path が要る');
  if (targets.length > 64) return stopped(bot, 'invalid_input', 'path は 64 マスまで');
  const start = feetCell(bot)!, startedAt = Date.now();
  const sprint = args.sprint !== false;
  const navigator = bot.pathfinder as { movements?: unknown; setMovements(movements: unknown): void } | undefined;
  if (!navigator) return stopped(bot, 'no_pathfinder', '経路探索が無い体');
  const previous = navigator.movements;
  navigator.setMovements(walkMovements(bot, sprint));
  try {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i], final = i === targets.length - 1;
      const feetBlock = read(bot, target.x, target.y, target.z);
      if (feetBlock?.solid && (final ? (args.range ?? 0) === 0 : true)) {
        return stopped(bot, 'target_solid', `${placeText(bot, target)} は ${feetBlock.name} で埋まっていて立てない（先に掘るか、上のマスを指す）`, target);
      }
      const outcome = await walkTo(ctx, target, final ? Math.max(0, args.range ?? 0) : 0, sprint);
      if (outcome) return { ...outcome, text: targets.length > 1 ? `道の${i + 1}/${targets.length}番目で: ${outcome.text}` : outcome.text };
      ctx.progress?.(`${i + 1}/${targets.length}`);
      await wait(ctx, 0);
    }
  } finally {
    try { if (previous) navigator.setMovements(previous); } catch { /* the walk's profile stays */ }
  }
  const end = feetCell(bot)!;
  const metres = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
  return { ok: true, text: `${cellText(end)} に着いた（${metres.toFixed(0)}m、${((Date.now() - startedAt) / 1000).toFixed(1)}秒）`, at: end };
}
