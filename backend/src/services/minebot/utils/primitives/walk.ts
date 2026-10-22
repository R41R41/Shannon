import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { buildMovements } from '../setMovements.js';
import { nextLeg, FAR_LEG_M } from '../farLegs.js';
import { bodyReader, feetCell, relativeWords, type Cell, type MapBlock } from '../localMap.js';
import { probePath } from '../probeTools.js';
import { cellWay, climbRise, doorOpen, installWalkRules, isDoorlike, isLeaves, isTall, mapBlockOf, MAX_CLIMB, MAX_FALL, passable, standable, standableBeside, whyNotStand } from '../walkRules.js';
import { cellText, guard, letGo, placeText, stopped, StepStopped, wait, type StepContext, type StepOutcome } from './common.js';

const { goals } = pathfinder;

/**
 * walk: to a cell, or along cells in order. It neither digs nor lays a block (design mb-llm-centric 2.3): a step up of one block, a drop
 * of three at most, swimming. A wooden door, fence gate or trapdoor on the way is opened, and leaves in the way are broken (r5, Lai
 * 2026-10-22: "扉と葉は歩きの中で通る"); the line says which. The cells are read by the walk's one rule (utils/walkRules), the same as probe
 * path's. The route search finds the way over the ground there is; a far walk is planned 64 m at a time. It is over only when the feet are
 * at the target (r5: run 28's walks "着いた（0m）" that had not moved); when it cannot go on it stops and says where and why (the wall's
 * block and cell, a drop, lava, water, nothing loaded), and the planner, which sees the map, chooses the digging or the bridge.
 */
export interface WalkArgs { to?: Cell; path?: Cell[]; range?: number; sprint?: boolean }

/** No headway for this long (moved less than NO_PROGRESS_M): the walk is stuck. */
const STUCK_MS = 4000;
const NO_PROGRESS_M = 0.5;
const MAX_DROP = MAX_FALL;
/** How far along the straight line a stopped walk is read for what stopped it. */
const SCAN_CELLS = 24;
/** A door is opened when the eye is this near it (the hand reaches 4.5). */
const DOOR_REACH = 3.5;
/** How many cells of the route ahead are looked at for a shut door. */
const DOOR_LOOKAHEAD = 4;

function readCell(bot: any, x: number, y: number, z: number): MapBlock | null {
  let block: any;
  try { block = bot.blockAt?.(new Vec3(x, y, z), false); } catch { block = null; }
  return block ? mapBlockOf(block) : null;
}
const reader = (bot: any) => (x: number, y: number, z: number) => readCell(bot, x, y, z);

/** The words for a feet or head cell the walk does not pass, by the walk's rules (null: it passes). */
function cellStop(block: MapBlock | null, cell: Cell, head: boolean): { reason: string; text: string } | null {
  const way = cellWay(block);
  if (way === 'unloaded') return { reason: 'unloaded', text: `${cellText(cell)} は未ロード` };
  if (block?.name === 'lava') return { reason: 'lava', text: `${cellText(cell)} が溶岩` };
  if (way === 'iron_door') return { reason: 'iron_door', text: `${cellText(cell)} は ${block!.name}（閉じた鉄の扉は手では開かない）` };
  if (way === 'harm') return { reason: 'wall', text: `${cellText(cell)} は ${block!.name}（入らない）` };
  if (way === 'solid' && head) return { reason: 'low_ceiling', text: `頭の高さ ${cellText(cell)} が ${block!.name} で通れない` };
  return null;
}

/**
 * Why the straight line from the feet toward `to` cannot be walked, read cell by cell as a body walks it (the walk's rules: a step up of
 * one with room over the head, a drop of three at most, doors opened and leaves broken): the first wall ("段差 n"), low ceiling, iron
 * door, drop, lava or unloaded cell, or null when the line is open.
 */
export function whyBlocked(bot: any, from: Cell, to: Cell): { reason: string; text: string; at: Cell } | null {
  let x = from.x, y = from.y, z = from.z;
  const dx = to.x - from.x, dz = to.z - from.z;
  const steps = Math.min(SCAN_CELLS, Math.max(Math.abs(dx), Math.abs(dz)));
  for (let i = 1; i <= steps; i++) {
    const nx = from.x + Math.round((dx * i) / Math.max(Math.abs(dx), Math.abs(dz))), nz = from.z + Math.round((dz * i) / Math.max(Math.abs(dx), Math.abs(dz)));
    if (nx === x && nz === z) continue;
    const feet = readCell(bot, nx, y, nz), head = readCell(bot, nx, y + 1, nz);
    if (!feet || !head) return { reason: 'unloaded', text: `(${nx},${y},${nz}) は未ロード`, at: { x: nx, y, z: nz } };
    if (feet.name === 'lava' || head.name === 'lava') return { reason: 'lava', text: `(${nx},${feet.name === 'lava' ? y : y + 1},${nz}) が溶岩`, at: { x: nx, y, z: nz } };
    for (const [block, cell] of [[feet, { x: nx, y, z: nz }], [head, { x: nx, y: y + 1, z: nz }]] as const) {
      const way = cellWay(block);
      if (way === 'iron_door' || way === 'harm') return { ...cellStop(block, cell, false)!, at: cell };
    }
    if (!passable(feet)) {
      // The height of the step: the cells that stop the feet, up from the walking level.
      let rise = 1;
      while (rise < 4 && !passable(readCell(bot, nx, y + rise, nz))) rise++;
      const over = readCell(bot, nx, y + 2, nz), above = readCell(bot, x, y + 2, z);
      if (rise === 1 && passable(head) && passable(over) && passable(above)) {
        // r7: a fence or a wall is not climbed; nor a block a cell up from a low floor (a slab: 1.5) — the route search's own limits.
        if (isTall(feet)) return { reason: 'wall', text: `壁: (${nx},${y},${nz}) ${feet.name} は高さ 1.5（柵・塀は上れない）（一歩ではない）`, at: { x: nx, y, z: nz } };
        const climb = climbRise(reader(bot), x, y, z, nx, nz);
        if (climb > MAX_CLIMB + 1e-9) {
          return { reason: 'wall', text: `壁: 上り ${climb.toFixed(1)}（今の床 (${x},${y - 1},${z}) ${readCell(bot, x, y - 1, z)?.name ?? '?'} の上から (${nx},${y},${nz}) ${feet.name} の上まで。walk の上りは ${MAX_CLIMB} まで）（一歩ではない）`, at: { x: nx, y, z: nz } };
        }
        x = nx; z = nz; y = y + 1; continue;
      }
      const why = rise >= 2 ? `段差 ${rise >= 4 ? '4 以上' : rise}（(${nx},${y},${nz}) ${feet.name}${rise >= 2 ? ` と (${nx},${y + 1},${nz}) ${head.name}` : ''}。walk の上りは 1 まで）`
        : !passable(over) ? `段の上 (${nx},${y + 2},${nz}) が ${over?.name ?? '未ロード'} で頭がつかえる` : `跳ぶ所の頭上 (${x},${y + 2},${z}) が ${above?.name ?? '未ロード'}`;
      return { reason: 'wall', text: `壁: ${why}（一歩ではない）`, at: { x: nx, y, z: nz } };
    }
    if (!passable(head)) return { reason: 'low_ceiling', text: `頭の高さ (${nx},${y + 1},${nz}) が ${head.name} で通れない`, at: { x: nx, y: y + 1, z: nz } };
    if (feet.name === 'water' || head.name === 'water') { x = nx; z = nz; continue; }
    let drop = 0;
    for (; drop <= MAX_DROP + 1; drop++) {
      const below = readCell(bot, nx, y - 1 - drop, nz);
      if (!below) return { reason: 'unloaded', text: `(${nx},${y - 1 - drop},${nz}) は未ロード`, at: { x: nx, y: y - 1 - drop, z: nz } };
      if (below.name === 'lava') return { reason: 'lava', text: `下 (${nx},${y - 1 - drop},${nz}) が溶岩`, at: { x: nx, y: y - 1 - drop, z: nz } };
      if (cellWay(below) !== 'open' || below.name === 'water') break;
    }
    if (drop > MAX_DROP) return { reason: 'drop', text: `(${nx},${y},${nz}) の先が${drop}段以上の落差（降りられない）`, at: { x: nx, y, z: nz } };
    // r7: what the fall ends on must be a floor (a fence or a wall is not: the route search never stands on one).
    const landing = readCell(bot, nx, y - 1 - drop, nz);
    if (landing && isTall(landing)) return { reason: 'wall', text: `(${nx},${y - 1 - drop},${nz}) ${landing.name} の上には立てない（柵・塀は床にならない）`, at: { x: nx, y: y - 1 - drop, z: nz } };
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
    const below = readCell(bot, to.x, to.y - 1 - air, to.z);
    if (!below || cellWay(below) !== 'open' || below.name === 'water') break;
  }
  if (air > 0) facts.push(`着く所の下 ${air >= 5 ? '5以上' : air} マスが空気（立つ床が無い）`);
  return facts.join('。');
}

/** The walk's movements: no tower, sprint as asked, the safe parkour, no block laid, a drop of three, water at its usual price; the walk's rules over them. */
export function walkMovements(bot: any, sprint = true): any {
  // towers off, sprint as asked, parkour (the safe one), doors (by the walk's rules below), no digging (but leaves, below), the
  // falling-block rule, dig cost, no free motion, swim, a drop of three, water at its usual price, and no block laid.
  const movements = buildMovements(bot, false, sprint, true, false, false, true, 1, false, true, MAX_DROP, 10, false);
  // r9 (run 33, +1093 and +1111: "(-37,46,190) に着いていない … probe path の決まりでは歩いて行ける"): the route search counts a drop from the
  // feet cell down to the FLOOR block that is landed on (movements.js getLandingBlock: `node.y - floor.y <= maxDropDown`), so a fall of
  // three cells is 4 and `maxDropDown = 3` allows two. The walk's rules (and probe path) allow a fall of three (no damage), as the text of
  // this file says; the search is given the same. The safe-parkour bound (a gap's drop) stays at MAX_DROP: it was set above, in its closure.
  movements.maxDropDown = MAX_DROP + 1;
  installWalkRules(movements);
  return movements;
}

/** What a stretch of walking did on the way: the doors it opened, the leaves it broke. */
export interface WayNotes { opened: Cell[]; leaves: number }
export function wayWords(notes: WayNotes): string {
  const words: string[] = [];
  if (notes.opened.length) words.push(`扉を開けた ${notes.opened.slice(0, 3).map(cellText).join('・')}${notes.opened.length > 3 ? ` ほか${notes.opened.length - 3}` : ''}`);
  if (notes.leaves) words.push(`葉を壊した ×${notes.leaves}`);
  return words.join('、');
}

export interface GoOutcome { reached: boolean; timedOut: boolean; stuck: boolean; error: unknown }

/**
 * One goal walked with the route search: the goal reached (its own test on the feet, never the search's word: mineflayer-pathfinder's goto
 * resolves when a search finds no step at all), out of time, stuck (no headway for STUCK_MS), or the search's error. A shut wooden door,
 * gate or trapdoor in the next cells of the route is opened when the eye is near; the leaves the route breaks are counted.
 */
export async function goWith(ctx: StepContext, goal: any, timeoutMs: number, notes: WayNotes): Promise<GoOutcome> {
  const bot = ctx.bot;
  let route: any[] = [];
  const onRoute = (results: any) => { route = Array.isArray(results?.path) ? results.path : []; };
  const onDug = (block: any) => { if (block?.name && isLeaves(String(block.name))) notes.leaves++; };
  const opening = new Map<string, number>();
  let busy = false;
  const openAhead = () => {
    if (busy) return;
    const position = bot.entity?.position;
    if (!position) return;
    const feet = feetCell(bot)!;
    const cells: Cell[] = [];
    const nodes = [feet, ...route.slice(0, DOOR_LOOKAHEAD).map((node: any) => ({ x: Math.floor(node.x), y: Math.floor(node.y), z: Math.floor(node.z) }))];
    nodes.forEach((node, i) => {
      cells.push(node, { ...node, y: node.y + 1 });
      // A jump up to the next node needs the cell over the head clear.
      if (nodes[i + 1] && nodes[i + 1].y > node.y) cells.push({ ...node, y: node.y + 2 });
    });
    for (const cell of cells) {
      let block: any;
      try { block = bot.blockAt?.(new Vec3(cell.x, cell.y, cell.z), false); } catch { block = null; }
      if (!block?.name || !isDoorlike(String(block.name)) || /^iron_/u.test(String(block.name)) || doorOpen(block)) continue;
      // A door's two halves open together: kept by its lower half.
      let door = cell;
      try { if (/_door$/u.test(String(block.name)) && block.getProperties?.()?.half === 'upper') door = { ...cell, y: cell.y - 1 }; } catch { /* as is */ }
      const k = `${door.x},${door.y},${door.z}`;
      if (Date.now() - (opening.get(k) ?? 0) < 1500) continue;
      const eye = position.offset ? position.offset(0, 1.62, 0) : { x: position.x, y: position.y + 1.62, z: position.z };
      if (Math.hypot(eye.x - (cell.x + 0.5), eye.y - (cell.y + 0.5), eye.z - (cell.z + 0.5)) > DOOR_REACH) continue;
      opening.set(k, Date.now());
      busy = true;
      Promise.resolve(bot.activateBlock?.(block)).then(() => {
        if (!notes.opened.some(c => c.x === door.x && c.y === door.y && c.z === door.z)) notes.opened.push(door);
      }, () => { /* said by the stop that follows, if it does not open */ }).finally(() => { busy = false; });
      return;
    }
  };
  bot.on?.('path_update', onRoute);
  bot.on?.('diggingCompleted', onDug);
  let last = bot.entity.position.clone(), lastMoveAt = Date.now(), stuck = false;
  const watch = setInterval(() => {
    try { openAhead(); } catch { /* the walk goes on; a shut door stops it below */ }
    const now = bot.entity?.position;
    if (!now) return;
    if (now.distanceTo(last) >= NO_PROGRESS_M) { last = now.clone(); lastMoveAt = Date.now(); return; }
    if (Date.now() - lastMoveAt >= STUCK_MS) { stuck = true; try { bot.pathfinder.stop(); bot.pathfinder.setGoal(null); } catch { /* stopped below */ } }
  }, 150);
  let error: unknown = null, timedOut = false;
  try {
    const done = await guard(ctx, Promise.resolve(bot.pathfinder.goto(goal)), Math.max(500, timeoutMs));
    if (!done) timedOut = true;
  } catch (caught) {
    if (caught instanceof StepStopped || /Action interrupted/u.test(String((caught as Error)?.message))) { clearInterval(watch); detach(); letGo(bot); throw caught; }
    error = caught;
  } finally { clearInterval(watch); detach(); }
  function detach() { bot.removeListener?.('path_update', onRoute); bot.removeListener?.('diggingCompleted', onDug); }
  return { reached: atGoal(bot, goal), timedOut, stuck, error };
}

/**
 * Whether the feet are where a goal wants them: the feet cell (r7: on a block lower than a full one, a slab or a stair's step too, the cell
 * above it, as the route search reads a goal reached; utils/localMap feetCell). Before, a body on a slab (half up its cell, not "more than
 * half") was "not arrived" where it stood.
 */
export function atGoal(bot: any, goal: any): boolean {
  const position = bot.entity?.position;
  if (!position || typeof goal?.isEnd !== 'function') return false;
  const here = feetCell(bot)!;
  try { return !!goal.isEnd(new Vec3(here.x, here.y, here.z)); } catch { return false; }
}

/** A cell as a short word for the stop's line: the block it holds ("air", "basalt", "未ロード"). */
const holds = (block: MapBlock | null) => block ? block.name : '未ロード';

/**
 * r9 (run 33: "(198,60,60) に着いていない … probe path の決まりでは歩いて行ける（1 マス）が、体はそこまで進まなかった" five times): the words for a
 * walk that probe path says can be walked and the body did not walk: the feet cell and what is under it, the next cell the route turns to
 * (what its feet, head and floor hold, and which way from the feet), and any creature standing in it. Facts only.
 */
function notArrivedFacts(bot: any, here: Cell, points: Cell[] | undefined): string {
  try {
    const facts: string[] = [`足のマス ${cellText(here)} の下は ${holds(readCell(bot, here.x, here.y - 1, here.z))}`];
    const toward = points?.[0];
    if (toward && (toward.x !== here.x || toward.z !== here.z || toward.y !== here.y)) {
      // The next cell: one step toward the first point of the route, at the level a body stands there (the point's own when it is one step away).
      const nx = here.x + Math.sign(toward.x - here.x), nz = here.z + Math.sign(toward.z - here.z);
      const read = reader(bot);
      const level = Math.max(Math.abs(toward.x - here.x), Math.abs(toward.z - here.z)) <= 1 ? toward.y : [here.y, here.y + 1, here.y - 1, here.y - 2, here.y - 3].find(y => standable(read, nx, y, nz)) ?? here.y;
      const next: Cell = { x: nx, y: level, z: nz };
      const way = relativeWords(here, next);
      facts.push(`次のマス ${cellText(next)}（${way || '同じマス'}）は 足 ${holds(readCell(bot, next.x, next.y, next.z))}・頭 ${holds(readCell(bot, next.x, next.y + 1, next.z))}・下 ${holds(readCell(bot, next.x, next.y - 1, next.z))}`);
      const inTheWay = Object.values(bot.entities ?? {}).filter((entity: any) => entity && entity !== bot.entity && entity.position && entity.name !== 'item'
        && Math.abs(entity.position.x - (next.x + 0.5)) < 0.9 && Math.abs(entity.position.z - (next.z + 0.5)) < 0.9 && entity.position.y > next.y - 1 && entity.position.y < next.y + 2)
        .slice(0, 2).map((entity: any) => `${entity.name ?? entity.type} #${entity.id}`);
      if (inTheWay.length) facts.push(`そのマスに ${inTheWay.join('・')} がいる`);
    }
    return facts.join('。');
  } catch { return ''; }
}

/**
 * The facts of what stands between the feet and a target not reached: the straight line's first stop, else probe path's break. r9: when probe
 * path's answer is a cell BESIDE the target (the target itself cannot be stood in: it said "reachable" for the neighbour, and the walk quoted
 * that as the target's), the target's own fact is told; and a "reachable" that the body did not walk comes with the cells (`notArrivedFacts`).
 */
async function shortFacts(bot: any, here: Cell, target: Cell): Promise<{ reason: string; text: string; at: Cell } | null> {
  const blocked = whyBlocked(bot, here, target);
  if (blocked) return blocked;
  try {
    const answer = await probePath(bodyReader(bot), here, target, { limits: { ms: 300, cells: 20_000 } });
    if (!answer.reachable && answer.breaks?.length) return { reason: answer.breaks[0].reason === 'low' ? 'low_ceiling' : answer.breaks[0].reason, text: answer.breaks.slice(0, 2).map(b => b.text).join('／'), at: answer.breaks[0].at };
    if (answer.reachable && answer.onTarget === false) {
      const read = reader(bot);
      const why = whyNotStand(read, target);
      const beside = standableBeside(read, target, 3);
      return { reason: why?.solidFeet ? 'target_solid' : 'target_unstandable',
        text: `${cellText(target)} そのものには立てない（${why?.text ?? '立つ床が無い'}）。${beside.length ? `立てる隣: ${beside.map(cellText).join('・')}` : '隣にも立てる所は無い'}`, at: target };
    }
    if (answer.reachable) return { reason: 'not_arrived', text: `probe path の決まりでは歩いて行ける（${answer.steps} マス）が、体はそこまで進まなかった。${notArrivedFacts(bot, here, answer.points)}`, at: here };
  } catch { /* the plain facts below */ }
  return null;
}

async function walkTo(ctx: StepContext, target: Cell, range: number, notes: WayNotes): Promise<StepOutcome | null> {
  const bot = ctx.bot;
  const goal = range > 0 ? new goals.GoalNear(target.x + 0.5, target.y, target.z + 0.5, range) : new goals.GoalBlock(target.x, target.y, target.z);
  let attempt = 0;
  for (;;) {
    const leg = nextLeg(bot, goal as never, attempt, FAR_LEG_M);
    const started = feetCell(bot)!;
    const startedAt = bot.entity.position.clone();
    const gone = await goWith(ctx, leg.goal, ctx.deadline - Date.now(), notes);
    const here = feetCell(bot)!;
    if (gone.timedOut) { letGo(bot); return stopped(bot, 'timeout', `${cellText(target)} へ歩く途中で時間切れ（今 ${placeText(bot, here)}）`, here, started); }
    if (gone.reached) {
      if (leg.final) return null;
      attempt = 0;
      continue;
    }
    letGo(bot);
    const message = String((gone.error as Error)?.message ?? (gone.stuck ? 'stuck' : 'not arrived'));
    // An intermediate leg not reached after some headway: the next leg from here.
    if (!leg.final && !gone.error && !gone.stuck && bot.entity.position.distanceTo(startedAt) >= 1) { attempt = 0; continue; }
    if (!leg.final && /no path/iu.test(message) && attempt < 2) { attempt++; continue; }
    const blocked = await shortFacts(bot, here, target);
    const reach = reachFacts(bot, here, target);
    const left = Math.hypot(target.x - here.x, target.y - here.y, target.z - here.z);
    const remains = `的まで ${left.toFixed(1)}m${range > 0 ? `（range ${range}）` : ''}`;
    if (gone.stuck) return stopped(bot, blocked?.reason ?? 'stuck', `${STUCK_MS / 1000}秒進めず止まった（今 ${placeText(bot, here)}、${remains}）。${blocked ? blocked.text : reach || '前に見える障害は無い（体が何かに引っかかっている）'}`, blocked?.at ?? here, here);
    if (/no path|took to long|too long/iu.test(message)) {
      return stopped(bot, blocked?.reason ?? 'no_path', `${cellText(target)} への掘らない道が無い（今 ${placeText(bot, here)}、${remains}）。${blocked ? blocked.text : reach || 'まっすぐの線は開いているが、遠回りの道も見つからない（未ロードか、囲まれている）'}`, blocked?.at ?? target, here);
    }
    if (!gone.error) {
      // The route search gave up without a word (no step it could take): the feet are not at the target, and that is the stop.
      return stopped(bot, 'not_arrived', `${cellText(target)} に着いていない（今 ${placeText(bot, here)}、${remains}）。${blocked ? blocked.text : reach || '通れない所は見えない'}`, blocked?.at ?? here, here);
    }
    return stopped(bot, 'walk_failed', `${cellText(target)} へ歩けなかった: ${message.slice(0, 80)}（今 ${placeText(bot, here)}、${remains}）`, here, here);
  }
}

/** Why the walk stops before it starts at a target no body can stand in: the fact, and the cells beside it a body can (none is chosen). */
function unstandable(bot: any, target: Cell): StepOutcome | null {
  const read = reader(bot);
  const why = whyNotStand(read, target);
  if (!why) return null;
  const beside = standableBeside(read, target, 3);
  return stopped(bot, why.solidFeet ? 'target_solid' : 'target_unstandable',
    `${placeText(bot, target)}そのものには立てない（${why.text}）。${beside.length ? `立てる隣: ${beside.map(cellText).join('・')}` : '隣にも立てる所は無い'}`, target);
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
  const notes: WayNotes = { opened: [], leaves: 0 };
  const withNotes = (text: string) => { const words = wayWords(notes); return words ? `${text}（途中で${words}）` : text; };
  try {
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i], final = i === targets.length - 1;
      const range = final ? Math.max(0, args.range ?? 0) : 0;
      // r9: a range under one is the cell itself (the route search floors the goal; act's default is 0.5): a cell no body can stand in is refused
      // at the start with its fact. It was only `range === 0`, and act walks with 0.5, so five walks in run 33 went to the cell below it and
      // stopped, and the stop quoted probe path's answer for a neighbour.
      if (range < 1) {
        const cannot = unstandable(bot, target);
        if (cannot) return { ...cannot, text: withNotes(targets.length > 1 ? `道の${i + 1}/${targets.length}番目で: ${cannot.text}` : cannot.text) };
      }
      const outcome = await walkTo(ctx, target, range, notes);
      if (outcome) return { ...outcome, text: withNotes(targets.length > 1 ? `道の${i + 1}/${targets.length}番目で: ${outcome.text}` : outcome.text) };
      ctx.progress?.(`${i + 1}/${targets.length}`);
      await wait(ctx, 0);
    }
  } finally {
    try { if (previous) navigator.setMovements(previous); } catch { /* the walk's profile stays */ }
  }
  const end = feetCell(bot)!;
  const metres = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
  const words = wayWords(notes);
  return { ok: true, text: `${cellText(end)} に着いた（${metres.toFixed(0)}m、${((Date.now() - startedAt) / 1000).toFixed(1)}秒${words ? `、${words}` : ''}）`, at: end };
}
