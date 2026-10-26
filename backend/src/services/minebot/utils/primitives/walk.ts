import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { buildMovements } from '../setMovements.js';
import { nextLeg, FAR_LEG_M } from '../farLegs.js';
import { bodyReader, feetCell, relativeWords, type Cell, type MapBlock } from '../localMap.js';
import { probePath } from '../probeTools.js';
import { cellWay, climbRise, doorOpen, installWalkRules, isDoorlike, isLeaves, isPortal, isTall, mapBlockOf, MAX_CLIMB, MAX_FALL, passable, PORTAL_WORDS, portalAim, standable, standableBeside, whyNotStand } from '../walkRules.js';
import { cellText, guard, letGo, placeText, stopped, StepStopped, wait, waitUntil, type StepContext, type StepOutcome } from './common.js';

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

/**
 * A cell's block in a few words with the state that decides whether a body goes through it (mb-llmc-cand, run 36: twelve walks stopped
 * "同じマスで 4 秒進めず" and the line did not say what held them): a fluid's source or its flow (level), a door, gate or trapdoor shut or
 * open, a slab's half, a stair, and, after a dash, the walk's own verdict on the cell (opened on the way, broken, a wall, ...).
 */
export function cellWords(bot: any, cell: Cell, verdict = true): string {
  let block: any;
  try { block = bot.blockAt?.(new Vec3(cell.x, cell.y, cell.z), false); } catch { block = null; }
  if (!block) return '未ロード';
  const name = String(block.name);
  let props: Record<string, unknown> = {};
  try { props = block.getProperties?.() ?? {}; } catch { props = {}; }
  const level = Number(props.level ?? 0);
  const state: string[] = [];
  if (name === 'water' || name === 'lava') {
    state.push(level === 0 ? '源' : level >= 8 ? '下へ落ちる流れ' : `流れ ${level}（0 が源、7 が先）`);
  } else if (isDoorlike(name)) {
    state.push(props.open === true || props.open === 'true' ? '開いている' : '閉じている');
    if (/_trapdoor$/u.test(name) && props.half) state.push(String(props.half) === 'top' ? '上半分' : '下半分');
  } else if (/_slab$/u.test(name) && props.type) {
    state.push(String(props.type) === 'top' ? '上の半ブロック' : String(props.type) === 'double' ? '2 段' : '下の半ブロック');
  } else if (/_stairs$/u.test(name)) {
    state.push('階段');
  }
  if (props.waterlogged === true || props.waterlogged === 'true') state.push('水つき');
  const way = cellWay(mapBlockOf(block));
  const said = !verdict ? '' : way === 'door' ? '歩きで開ける' : way === 'leaves' ? '歩きで壊す' : way === 'iron_door' ? '手では開かない' : way === 'harm' ? '入らない' : way === 'portal' ? 'ポータル。入ると次元が変わる' : way === 'solid' ? '壁' : '';
  return `${name}${state.length ? `（${state.join('・')}）` : ''}${said ? `［${said}］` : ''}`;
}

/** The words for a feet or head cell the walk does not pass, by the walk's rules (null: it passes). */
function cellStop(block: MapBlock | null, cell: Cell, head: boolean): { reason: string; text: string } | null {
  const way = cellWay(block);
  if (way === 'unloaded') return { reason: 'unloaded', text: `${cellText(cell)} は未ロード` };
  if (block?.name === 'lava') return { reason: 'lava', text: `${cellText(cell)} が溶岩` };
  if (way === 'iron_door') return { reason: 'iron_door', text: `${cellText(cell)} は ${block!.name}（閉じた鉄の扉は手では開かない）` };
  if (way === 'harm') return { reason: 'wall', text: `${cellText(cell)} は ${block!.name}（入らない）` };
  if (way === 'portal') return { reason: 'wall', text: `${cellText(cell)} は ${block!.name}（${PORTAL_WORDS}）` };
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
    // The target is a portal cell (walked into on purpose): the line ends there.
    if (nx === to.x && nz === to.z && isPortal(feet)) { x = nx; z = nz; continue; }
    for (const [block, cell] of [[feet, { x: nx, y, z: nz }], [head, { x: nx, y: y + 1, z: nz }]] as const) {
      const way = cellWay(block);
      if (way === 'iron_door' || way === 'harm' || way === 'portal') return { ...cellStop(block, cell, false)!, at: cell };
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
export interface WayNotes { opened: Cell[]; leaves: number; /** Where the walk began: the dimension and the feet cell (a dimension change on the way is said against it). */ from?: { dimension: string; cell: Cell }; /** The portal cell the walk was pointed at, when it entered the bottom cell of its column instead. */ pointedAt?: Cell }
export function wayWords(notes: WayNotes): string {
  const words: string[] = [];
  if (notes.opened.length) words.push(`扉を開けた ${notes.opened.slice(0, 3).map(cellText).join('・')}${notes.opened.length > 3 ? ` ほか${notes.opened.length - 3}` : ''}`);
  if (notes.leaves) words.push(`葉を壊した ×${notes.leaves}`);
  return words.join('、');
}

/** What the route search last said of this walk (mineflayer-pathfinder's `path_update`): its status and the nodes of the way it found. */
export interface SearchSaid { status: string; nodes: number }
/**
 * The bodies whose walk ends in a portal entry (its last point is a cell portalAim accepts): only there is a change of dimension the arrival.
 * Any other change of dimension during a walk (a death and a respawn elsewhere) is not: the act's watch stops with `dimension_changed`.
 */
export const portalWalks = new WeakSet<object>();
export interface GoOutcome { reached: boolean; timedOut: boolean; stuck: boolean; error: unknown; search: SearchSaid | null; opens: string[]; /** The body came into another dimension while it walked (a portal: arrival, not a failure). */ crossed?: boolean }

/** go's way of using goWith: its own stuck time, a test of work that holds the body still on purpose (a dig, a block laid), and a look at each route found. */
export interface GoWithOptions {
  stuckMs?: number; busy?: () => boolean; onRoute?: (route: any[], status: string) => void;
  /** Headway is a move along the ground (or a rise or fall that ends on the ground), not the jumping up and down of a body held by a wall. */
  onGround?: boolean;
}

/**
 * One goal walked with the route search: the goal reached (its own test on the feet, never the search's word: mineflayer-pathfinder's goto
 * resolves when a search finds no step at all), out of time, stuck (no headway for STUCK_MS), or the search's error. A shut wooden door,
 * gate or trapdoor in the next cells of the route is opened when the eye is near; the leaves the route breaks are counted.
 */
export async function goWith(ctx: StepContext, goal: any, timeoutMs: number, notes: WayNotes, options: GoWithOptions = {}): Promise<GoOutcome> {
  const bot = ctx.bot;
  let route: any[] = [];
  let search: SearchSaid | null = null;
  const onRoute = (results: any) => {
    route = Array.isArray(results?.path) ? results.path : [];
    search = { status: String(results?.status ?? '?'), nodes: route.length };
    try { options.onRoute?.(route, search.status); } catch { /* a look at the route never stops the walk */ }
  };
  const onDug = (block: any) => { if (block?.name && isLeaves(String(block.name))) notes.leaves++; };
  const opening = new Map<string, number>();
  /** The doors, gates and trapdoors the walk tried to open on the way, each with how it went (said by a stop: a shut one that stayed shut). */
  const opens: string[] = [];
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
        if (opens.length < 4) opens.push(`${cellText(door)} ${block.name} を開けようとした`);
      }, (caught: unknown) => {
        if (opens.length < 4) opens.push(`${cellText(door)} ${block.name} を開けようとして失敗: ${String((caught as Error)?.message ?? caught).slice(0, 60)}`);
      }).finally(() => { busy = false; });
      return;
    }
  };
  bot.on?.('path_update', onRoute);
  bot.on?.('diggingCompleted', onDug);
  let last = bot.entity.position.clone(), lastMoveAt = Date.now(), stuck = false, crossed = false;
  const dimension0 = dimensionOf(bot);
  const watch = setInterval(() => {
    // A portal entered on the way carries the body off: the walk is over there (mb-llmc-cand 4), not stuck nor failed.
    if (!crossed && portalWalks.has(bot) && dimensionOf(bot) !== dimension0) { crossed = true; try { bot.pathfinder.stop(); bot.pathfinder.setGoal(null); } catch { /* over */ } return; }
    if (crossed) return;
    try { openAhead(); } catch { /* the walk goes on; a shut door stops it below */ }
    const now = bot.entity?.position;
    if (!now) return;
    const headway = options.onGround
      ? Math.hypot(now.x - last.x, now.z - last.z) >= NO_PROGRESS_M || (bot.entity?.onGround !== false && Math.abs(now.y - last.y) >= NO_PROGRESS_M)
      : now.distanceTo(last) >= NO_PROGRESS_M;
    if (headway || options.busy?.()) { last = now.clone(); lastMoveAt = Date.now(); return; }
    if (Date.now() - lastMoveAt >= (options.stuckMs ?? STUCK_MS)) { stuck = true; try { bot.pathfinder.stop(); bot.pathfinder.setGoal(null); } catch { /* stopped below */ } }
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
  if (!crossed && portalWalks.has(bot) && dimensionOf(bot) !== dimension0) crossed = true;
  return { reached: !crossed && atGoal(bot, goal), timedOut: timedOut && !crossed, stuck: stuck && !crossed, error: crossed ? null : error, search, opens, crossed };
}

/** The dimension the body is in, as the server names it (`overworld`, `the_nether`, `the_end`, with or without `minecraft:`); '' when not known. */
export function dimensionOf(bot: any): string {
  try { return String(bot.game?.dimension ?? '').replace(/^minecraft:/u, ''); } catch { return ''; }
}
export function dimensionWords(dimension: string): string {
  return dimension.includes('nether') ? 'ネザー' : dimension.includes('end') ? 'エンド' : dimension.includes('overworld') ? 'オーバーワールド' : dimension || '不明な次元';
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


/** What the route search said, as a fact: found no way, found one (and how long), gave up. */
function searchWords(search: SearchSaid): string {
  if (search.status === 'noPath') return '経路探索は道が見つからないと答えた（walk の決まりでは歩ける道。決まりと探索の食い違い）';
  if (search.status === 'timeout') return '経路探索は時間切れ（道は決まらなかった）';
  if (search.status === 'success' || search.status === 'partial') return `経路探索は道を見つけた（${search.nodes} マス${search.status === 'partial' ? '、途中まで' : ''}）が体は進まなかった`;
  return `経路探索の答え: ${search.status}`;
}

/** How the body stands: in water or on the ground, in the air, against a wall (what the engine says; nothing guessed). */
function bodyState(bot: any): string {
  try {
    const entity = bot.entity;
    const parts: string[] = [];
    if (entity?.isInWater || bot.isInWater) parts.push('水の中');
    if (entity?.onGround === false && !entity?.isInWater) parts.push('地面に立っていない');
    if (entity?.isCollidedHorizontally) parts.push('横の壁に当たっている');
    return parts.length ? `体: ${parts.join('・')}` : '';
  } catch { return ''; }
}

/**
 * r9 (run 33: "(198,60,60) に着いていない … probe path の決まりでは歩いて行ける（1 マス）が、体はそこまで進まなかった" five times): the words for a
 * walk that probe path says can be walked and the body did not walk: the feet cell and what is under it, the next cell the route turns to
 * (what its feet, head and floor hold, and which way from the feet), and any creature standing in it. Facts only.
 */
/** The next cell: one step toward the first point of the route, at the level a body stands there (the point's own when it is one step away). */
function nextCellToward(bot: any, here: Cell, toward: Cell | undefined): Cell | null {
  if (!toward || (toward.x === here.x && toward.z === here.z && toward.y === here.y)) return null;
  const nx = here.x + Math.sign(toward.x - here.x), nz = here.z + Math.sign(toward.z - here.z);
  const read = reader(bot);
  const level = Math.max(Math.abs(toward.x - here.x), Math.abs(toward.z - here.z)) <= 1 ? toward.y : [here.y, here.y + 1, here.y - 1, here.y - 2, here.y - 3].find(y => standable(read, nx, y, nz)) ?? here.y;
  return { x: nx, y: level, z: nz };
}

/**
 * The root of a walk that did not move, in a few words, for the front of the line (mb-llmc-cand 3, run 37: the facts at the back of the text
 * were cut in 4 of 6 lines): what the route search said, how the body stands, and the first cell of the feet's and the next cell's (feet and
 * head) that holds it — a flow of water, a shut door, a gate or a trapdoor, a solid block — and a door that did not open.
 */
function stuckCause(bot: any, here: Cell, toward: Cell | undefined, search: SearchSaid | null | undefined, opens: string[]): string {
  const parts: string[] = [];
  if (search) parts.push(search.status === 'noPath' ? '経路探索は道が見つからないと答えた' : search.status === 'timeout' ? '経路探索は時間切れ'
    : search.status === 'success' || search.status === 'partial' ? '経路探索は道を見つけたが体は進まなかった' : `経路探索の答え ${search.status}`);
  const body = bodyState(bot).replace(/^体: /u, '');
  if (body) parts.push(body);
  const next = nextCellToward(bot, here, toward);
  const trouble = (cell: Cell, label: string): string => {
    let block: any;
    try { block = bot.blockAt?.(new Vec3(cell.x, cell.y, cell.z), false); } catch { block = null; }
    if (!block?.name) return '';
    const name = String(block.name);
    let props: Record<string, unknown> = {};
    try { props = block.getProperties?.() ?? {}; } catch { props = {}; }
    if (name === 'water' || name === 'lava') {
      const level = Number(props.level ?? 0);
      return level === 0 ? '' : `${label}が${name === 'water' ? '水' : '溶岩'}の${level >= 8 ? '下へ落ちる流れ' : `流れ ${level}`}`;
    }
    const way = cellWay(mapBlockOf(block));
    if (way === 'door') return `${label}が閉じた ${name}`;
    if (way === 'iron_door') return `${label}が ${name}（手では開かない）`;
    if (way === 'harm') return `${label}が ${name}`;
    if (way === 'portal') return `${label}が ${name}（ポータル）`;
    if (way === 'solid') return `${label}が ${name}`;
    return '';
  };
  const cells: Array<[Cell, string]> = [[here, '今のマス'], [{ ...here, y: here.y + 1 }, '今の頭'], ...(next ? [[next, '次のマス'], [{ ...next, y: next.y + 1 }, '次の頭']] as Array<[Cell, string]> : [])];
  for (const [cell, label] of cells) { const said = trouble(cell, label); if (said) { parts.push(said); break; } }
  const failed = opens.find(line => line.includes('失敗'));
  if (failed) parts.push('扉を開けようとして失敗');
  return parts.join('・');
}

function notArrivedFacts(bot: any, here: Cell, points: Cell[] | undefined, search?: SearchSaid | null): string {
  try {
    const facts: string[] = [];
    const next = nextCellToward(bot, here, points?.[0]);
    if (next) facts.push(`次のマス ${cellText(next)}（${relativeWords(here, next) || '同じマス'}）は 足 ${cellWords(bot, next)}・頭 ${cellWords(bot, { ...next, y: next.y + 1 })}・下 ${cellWords(bot, { ...next, y: next.y - 1 }, false)}`);
    facts.push(`足のマス ${cellText(here)} は 足 ${cellWords(bot, here)}・頭 ${cellWords(bot, { ...here, y: here.y + 1 })}・下 ${cellWords(bot, { ...here, y: here.y - 1 }, false)}`);
    const body = bodyState(bot);
    if (body) facts.push(body);
    if (search) facts.push(searchWords(search));
    if (next) {
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
async function shortFacts(bot: any, here: Cell, target: Cell, search?: SearchSaid | null): Promise<{ reason: string; text: string; at: Cell } | null> {
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
    if (answer.reachable) return { reason: 'not_arrived', text: `probe path の決まりでは歩いて行ける（${answer.steps} マス）が、体はそこまで進まなかった。${notArrivedFacts(bot, here, answer.points, search)}`, at: here };
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
    if (gone.crossed) return crossedOutcome(ctx, notes);
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
    const blocked = await shortFacts(bot, here, target, gone.search);
    const reach = reachFacts(bot, here, target);
    const left = Math.hypot(target.x - here.x, target.y - here.y, target.z - here.z);
    const remains = `的まで ${left.toFixed(1)}m${range > 0 ? `（range ${range}）` : ''}`;
    if (gone.stuck) {
      // The facts of the cells the body is in and goes to, whatever stopped it (notArrivedFacts has them already when probe path walked it).
      const own = (blocked?.reason === 'not_arrived' ? '' : `。${notArrivedFacts(bot, here, [target], gone.search)}`) + (gone.opens.length ? `。扉の試し: ${gone.opens.join('、')}` : '');
      const cause = stuckCause(bot, here, target, gone.search, gone.opens);
      return stopped(bot, blocked?.reason ?? 'stuck', `${STUCK_MS / 1000}秒進めず止まった（今 ${placeText(bot, here)}、${remains}）。${blocked ? blocked.text : reach || '前に見える障害は無い（体が何かに引っかかっている）'}${own}`, blocked?.at ?? here, here, cause);
    }
    if (/no path|took to long|too long/iu.test(message)) {
      return stopped(bot, blocked?.reason ?? 'no_path', `${cellText(target)} への掘らない道が無い（今 ${placeText(bot, here)}、${remains}）。${blocked ? blocked.text : reach || 'まっすぐの線は開いているが、遠回りの道も見つからない（未ロードか、囲まれている）'}`, blocked?.at ?? target, here);
    }
    if (!gone.error) {
      // The route search gave up without a word (no step it could take): the feet are not at the target, and that is the stop.
      return stopped(bot, 'not_arrived', `${cellText(target)} に着いていない（今 ${placeText(bot, here)}、${remains}）。${blocked ? blocked.text : reach || '通れない所は見えない'}`, blocked?.at ?? here, here,
        stuckCause(bot, here, target, gone.search, gone.opens));
    }
    return stopped(bot, 'walk_failed', `${cellText(target)} へ歩けなかった: ${message.slice(0, 80)}（今 ${placeText(bot, here)}、${remains}）`, here, here);
  }
}

/** How long a body stands in a portal for the dimension to change (a nether portal takes 4 s; a busy server more) before the walk says it did not. */
const PORTAL_WAIT_MS = 10_000;

/**
 * The walk ended in another dimension (a portal entered, as the target or on the way): that is the arrival (mb-llmc-cand 4, run 37: walking
 * into a lit portal is the way over). The cell is the one the body stands in there, after the position packet of the new dimension.
 */
async function crossedOutcome(ctx: StepContext, notes: WayNotes): Promise<StepOutcome> {
  const bot = ctx.bot;
  try { await wait(ctx, 600); } catch (caught) { if (caught instanceof StepStopped) throw caught; }
  const end = (() => { try { return feetCell(bot); } catch { return null; } })();
  const there = dimensionWords(dimensionOf(bot));
  const from = notes.from ? `（${dimensionWords(notes.from.dimension)}の ${cellText(notes.from.cell)} から歩いて入った${notes.pointedAt ? `。指された ${cellText(notes.pointedAt)} は柱の途中なので一番下のポータルのマスから` : ''}）` : '';
  return { ok: true, text: `${there}へ移った${end ? ` ${cellText(end)}` : ''}${from}`, ...(end ? { at: end } : {}), data: { crossedDimension: true } };
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
  try { return await walkInner(ctx, args); } finally { portalWalks.delete(ctx.bot); }
}

async function walkInner(ctx: StepContext, args: WalkArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const targets = args.path?.length ? args.path : args.to ? [args.to] : [];
  if (!targets.length) return stopped(bot, 'invalid_input', 'walk には to か path が要る');
  if (targets.length > 64) return stopped(bot, 'invalid_input', 'path は 64 マスまで');
  const start = feetCell(bot)!, startedAt = Date.now();
  const sprint = args.sprint !== false;
  const navigator = bot.pathfinder as { movements?: unknown; setMovements(movements: unknown): void } | undefined;
  if (!navigator) return stopped(bot, 'no_pathfinder', '経路探索が無い体');
  // A portal is entered only as the LAST point (mb-llmc-cand 4, review): a middle point that is one is refused before any step; the top row of a
  // frame (the head meets the obsidian) is refused with the cell to aim at; a middle cell of the column is entered at the bottom one.
  const read = reader(bot);
  const lastRange = Math.max(0, args.range ?? 0);
  for (let i = 0; i < targets.length - 1; i++) {
    const aimed = portalAim(read, targets[i]);
    if (aimed) return stopped(bot, 'target_unstandable', `道の${i + 1}/${targets.length}番目で: ${cellText(targets[i])} は ${aimed.name}（ポータルは walk の最後の点にだけ。途中の点にはしない）`, targets[i]);
  }
  const lastAim = lastRange < 1 ? portalAim(read, targets[targets.length - 1]) : null;
  if (lastAim?.kind === 'refuse') return stopped(bot, 'target_unstandable', lastAim.text, targets[targets.length - 1]);
  const previous = navigator.movements;
  navigator.setMovements(walkMovements(bot, sprint));
  const notes: WayNotes = { opened: [], leaves: 0, from: { dimension: dimensionOf(bot), cell: start } };
  // The last target is a portal: the walk goes into it, and its end is the dimension changed.
  const portal = lastAim?.kind === 'enter' ? lastAim.name : null;
  if (lastAim?.kind === 'enter') portalWalks.add(bot);
  if (lastAim?.kind === 'enter' && lastAim.redirected) notes.pointedAt = targets[targets.length - 1];
  const withNotes = (text: string) => { const words = wayWords(notes); return words ? `${text}（途中で${words}）` : text; };
  try {
    for (let i = 0; i < targets.length; i++) {
      const final = i === targets.length - 1;
      const target = final && lastAim?.kind === 'enter' ? lastAim.cell : targets[i];
      const range = final ? Math.max(0, args.range ?? 0) : 0;
      // r9: a range under one is the cell itself (the route search floors the goal; act's default is 0.5): a cell no body can stand in is refused
      // at the start with its fact. It was only `range === 0`, and act walks with 0.5, so five walks in run 33 went to the cell below it and
      // stopped, and the stop quoted probe path's answer for a neighbour.
      if (range < 1 && !(final && lastAim?.kind === 'enter')) {
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
  if (portal) {
    const left = Math.max(1000, Math.min(PORTAL_WAIT_MS, ctx.deadline - Date.now()));
    const changed = await waitUntil(ctx, () => dimensionOf(bot) !== notes.from!.dimension, left, 250);
    if (changed) return crossedOutcome(ctx, notes);
    const inside = feetCell(bot)!;
    return { ok: true, text: `${cellText(inside)} の ${portal}（ポータル）の中に着いた。${Math.round(left / 1000)}秒立っていたが、まだ次元は変わっていない（ネザーポータルは中に 4 秒ほど立つと移る。続けて立つか、読み込みを待つ）`, at: inside };
  }
  const end = feetCell(bot)!;
  const metres = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
  const words = wayWords(notes);
  return { ok: true, text: `${cellText(end)} に着いた（${metres.toFixed(0)}m、${((Date.now() - startedAt) / 1000).toFixed(1)}秒${words ? `、${words}` : ''}）`, at: end };
}
