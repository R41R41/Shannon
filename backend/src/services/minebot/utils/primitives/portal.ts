import { blockInSight } from '../probeTools.js';
import { feetCell, type Cell } from '../localMap.js';
import { cellText, inventoryCount, stopped, waitUntil, type StepContext, type StepOutcome } from './common.js';
import { dig } from './dig.js';
import { pillarUp } from './pillarUp.js';
import { place } from './place.js';
import { use } from './use.js';
import { dimensionOf, walk } from './walk.js';
import { DIG_REACH_PLAN, FACES, OPPOSITE, PLACE_REACH, clickLands, dist, eyeAtCell, eyeTo, footingBlock, isOpenCell, isSolid, keyOf, limitedContext, moveTo, readerOf,
  sameCell, shift, standCells, timeIsUp, type Face } from './handSupport.js';

/**
 * portal: the frame of a nether portal, lit, and gone into (contract hands-contract.md 5, 2026-10-26). The planner decides WHERE (`at`: the left, lower
 * cell of the inside, the one with the lowest coordinate along the plane's axis; `axis`: x or z, the way the plane runs), the block (`block`, obsidian
 * or crying obsidian), whether to go in once it burns (`enter`), what may be laid for a scaffold (`canPlace`, `maxPlace`) and the limit (`seconds`). The
 * body builds the frame, a 4 wide, 5 tall ring without its corners (ten blocks), lights the inside's floor with the flint and steel, and walks into the
 * portal with walk's own way of going in (it stands in it until the dimension changes).
 *
 * The ten blocks touch each other only at their corners' diagonals, so the first block of each column and the top row has nothing to be set against.
 * A scaffold block (one of `canPlace`, never the frame's block) is laid in a corner cell, or in the cells between the frame and the ground when there are
 * more, and every scaffold is dug out again once the fire has taken (the frame is only ever the frame's block). When the cells to be reached are beyond the
 * eye from any floor, a pillar of the scaffold block is made under the feet (pillarUp) and left standing.
 */
export interface PortalArgs { at: Cell; axis: 'x' | 'z'; block?: string; enter?: boolean; canPlace?: string[]; maxPlace?: number; seconds?: number }

export const PORTAL_DEFAULTS = { block: 'obsidian', enter: true, seconds: 60, maxPlace: 8 } as const;
const FRAME_BLOCKS = new Set(['obsidian', 'crying_obsidian']);
const IGNITE_WAIT_MS = 2500;
const MAX_PLACE_TRIES = 3;

/** The cells of the frame (ten), the inside (six) and the four corners (not part of the frame) for an inside whose lowest-coordinate lower cell is `at`. */
export function portalCells(at: Cell, axis: 'x' | 'z'): { frame: Cell[]; interior: Cell[]; corners: Cell[] } {
  const along = (a: number, up: number): Cell => (axis === 'x' ? { x: at.x + a, y: at.y + up, z: at.z } : { x: at.x, y: at.y + up, z: at.z + a });
  const frame: Cell[] = [];
  for (const a of [0, 1]) { frame.push(along(a, -1)); frame.push(along(a, 3)); }
  for (const up of [0, 1, 2]) { frame.push(along(-1, up)); frame.push(along(2, up)); }
  const interior: Cell[] = [];
  for (const up of [0, 1, 2]) for (const a of [0, 1]) interior.push(along(a, up));
  return { frame, interior, corners: [along(-1, -1), along(2, -1), along(-1, 3), along(2, 3)] };
}

interface Counts { placed: number; scaffold: number; removed: number; pillar: number; notes: string[] }

export async function portal(parent: StepContext, args: PortalArgs): Promise<StepOutcome> {
  const bot = parent.bot;
  const axis = args.axis;
  const block = args.block ?? PORTAL_DEFAULTS.block;
  if (axis !== 'x' && axis !== 'z') return stopped(bot, 'invalid_input', 'portal には axis（x か z）が要る');
  if (!args.at) return stopped(bot, 'invalid_input', 'portal には at（枠の内側の左下のマス 1 つ）が要る');
  if (!FRAME_BLOCKS.has(block)) return stopped(bot, 'invalid_input', `portal の枠は obsidian か crying_obsidian（${block} ではポータルにならない）`);
  const seconds = Math.max(5, Math.min(120, args.seconds ?? PORTAL_DEFAULTS.seconds));
  const maxPlace = Math.max(0, Math.min(100, Math.floor(args.maxPlace ?? PORTAL_DEFAULTS.maxPlace)));
  const enter = args.enter ?? PORTAL_DEFAULTS.enter;
  const ctx = limitedContext(parent, seconds);
  const read = readerOf(bot);
  const { frame, interior, corners } = portalCells(args.at, axis);
  const counts: Counts = { placed: 0, scaffold: 0, removed: 0, pillar: 0, notes: [] };
  const framed = (cell: Cell) => { const found = read(cell.x, cell.y, cell.z); return !!found && FRAME_BLOCKS.has(found.name); };
  const lit = () => interior.some(cell => read(cell.x, cell.y, cell.z)?.name === 'nether_portal');
  const progress = () => `枠 ${frame.filter(framed).length}/10`;
  const laid = () => frame.filter(framed).length - existingAtStart;
  const stop = (code: string, text: string, at?: Cell): StepOutcome => stopped(bot, code, `portal 止まった ${code}: ${text}（${progress()}${counts.scaffold ? `・足場 ${counts.scaffold} 個` : ''}）`, at);

  // What the place holds: the frame's cells must be the frame's block or open; the inside open (or fire, or the portal already).
  const alreadyLit = lit();
  const existing = frame.filter(framed).length;
  const existingAtStart = existing;
  if (!alreadyLit) {
    for (const cell of interior) {
      const found = read(cell.x, cell.y, cell.z);
      if (!found) return stop('blocked', `内側の ${cellText(cell)} は未ロード`, cell);
      if (!isOpenCell(found) && found.name !== 'fire' && found.name !== 'nether_portal') return stop('blocked', `内側の ${cellText(cell)} が ${found.name}（空いていないとポータルにならない。壊すのは任せない）`, cell);
    }
    for (const cell of frame) {
      const found = read(cell.x, cell.y, cell.z);
      if (!found) return stop('blocked', `枠の ${cellText(cell)} は未ロード`, cell);
      if (!FRAME_BLOCKS.has(found.name) && !isOpenCell(found)) return stop('blocked', `枠の ${cellText(cell)} が ${found.name}（空いていない。壊すのは任せない）`, cell);
    }
    const missing = frame.length - existing;
    const have = inventoryCount(bot, block);
    if (have < missing) return stop('no_obsidian', `${block} を ${have} 個しか持っていない（枠に足りないのは ${missing} 個。枠は全部で 10 個、元からある ${existing} 個）`, args.at);
    if (!inventoryCount(bot, 'flint_and_steel')) return stop('no_flint', '火打ち金（flint_and_steel）を持っていない', args.at);
  }
  const scaffoldBlock = footingBlock(bot, args.canPlace, [...FRAME_BLOCKS]);
  const budget = () => (scaffoldBlock ? Math.max(0, Math.min(maxPlace - counts.scaffold - counts.pillar, inventoryCount(bot, scaffoldBlock))) : 0);
  const scaffolds: Cell[] = [];

  // ---- building -------------------------------------------------------------------------------------------------------------------------

  const missingFrame = () => frame.filter(cell => !framed(cell));
  const solidAt = (cell: Cell) => isSolid(read(cell.x, cell.y, cell.z));
  const supported = (cell: Cell) => FACES.some(face => solidAt(shift(cell, face)));
  const interiorKeys = new Set(interior.map(keyOf));
  const frameKeys = new Set(frame.map(keyOf));
  const clash = (stand: Cell, zone: Cell[]) => zone.some(cell => Math.abs(cell.x - stand.x) <= 1 && Math.abs(cell.z - stand.z) <= 1 && (cell.y === stand.y || cell.y === stand.y + 1));
  const inside = (stand: Cell) => [stand, { ...stand, y: stand.y + 1 }].some(cell => frameKeys.has(keyOf(cell)) || interiorKeys.has(keyOf(cell)));

  /** Places to stand within reach of `target`: apart from the cells still to be filled when there are any, else only out of the frame. */
  const standsFor = (target: Cell, reach: number, zone: Cell[], extra: Cell[] = []): Cell[] => {
    const all = standCells(read, target, 6, target.y - 6, target.y + 2).filter(stand => !inside(stand) && !extra.some(cell => sameCell(cell, stand)) && eyeTo(stand, target) <= reach);
    const apart = all.filter(stand => !clash(stand, zone));
    return apart.length ? apart : all;
  };
  const nearest = (cells: Cell[]): Cell | undefined => {
    const here = feetCell(bot)!;
    return cells.find(cell => sameCell(cell, here)) ?? [...cells].sort((a, b) => dist(a, here) - dist(b, here))[0];
  };

  /** One block into one cell from a place that reaches it; null when it is there, else the stop. */
  const lay = async (target: Cell, name: string, zone: Cell[]): Promise<StepOutcome | null> => {
    const refused: Cell[] = [];
    let lastStop: StepOutcome | null = null;
    for (let attempt = 0; attempt < MAX_PLACE_TRIES; attempt++) {
      if (timeIsUp(ctx)) return stop('limit_time', `${seconds} 秒の上限に達した`, target);
      let stand = nearest(standsFor(target, PLACE_REACH, zone, refused));
      if (!stand) {
        // Beyond the eye from any floor: a pillar under the feet (the scaffold block, left standing).
        const raised = await raise(target, zone);
        if (raised) return raised;
        stand = feetCell(bot)!;
        if (eyeTo(stand, target) > PLACE_REACH || inside(stand)) return stop('stuck', `${cellText(target)} に届く立ち位置が無い（床から 4.6m 内の立てる所が無い）`, target);
      }
      const moved = await moveTo(ctx, stand);
      if (moved) { refused.push(stand); lastStop = moved; continue; }
      const placed = await place(ctx, { block: name, at: [target] });
      if (placed.ok) return null;
      refused.push(stand);
      lastStop = placed;
      if (placed.reason === 'nothing_to_set_against' || placed.reason === 'occupied') break;
    }
    if (lastStop?.reason === 'nothing_to_set_against') return stop('blocked', `${cellText(target)} に当てる面が無い（${lastStop.text.slice(0, 80)}）`, target);
    return stop('stuck', `${cellText(target)} に ${name} を置けなかった: ${lastStop?.text.slice(0, 90) ?? '立つ所に着けない'}`, target);
  };

  /** A pillar under the feet to reach `target`: null when the feet are higher by what is needed, else the stop. */
  const raise = async (target: Cell, zone: Cell[]): Promise<StepOutcome | null> => {
    if (!scaffoldBlock) return stop('blocked', `${cellText(target)} は床から届かない（足場に置く物を canPlace に挙げれば柱を作って届く）`, target);
    const near = standCells(read, target, 5, target.y - 8, target.y).filter(stand => !inside(stand) && !clash(stand, zone));
    for (const rise of [1, 2, 3]) {
      if (budget() < rise) break;
      const headroom = (stand: Cell) => { for (let up = 2; up <= rise + 1; up++) if (!isOpenCell(read(stand.x, stand.y + up, stand.z))) return false; return true; };
      const from = nearest(near.filter(stand => eyeTo({ ...stand, y: stand.y + rise }, target) <= PLACE_REACH && headroom(stand)));
      if (!from) continue;
      const moved = await moveTo(ctx, from);
      if (moved) return stop('stuck', `柱の立ち位置 ${cellText(from)} に着けない: ${moved.text.slice(0, 70)}`, from);
      const climbed = await pillarUp(ctx, { n: rise, block: scaffoldBlock });
      if (!climbed.ok) return stop('stuck', `柱を作れなかった: ${climbed.text.slice(0, 90)}`, from);
      counts.pillar += rise;
      return null;
    }
    return stop('blocked', `${cellText(target)} は床からも柱（3 段まで）からも届かない`, target);
  };

  /** The scaffold cells to lay so that a frame cell with nothing beside it has a face to be set against: the shortest chain from a supported cell. */
  const chainTo = (todo: Cell[]): Cell[] | null => {
    const parent = new Map<string, Cell | null>();
    let frontier: Cell[] = [];
    for (const cell of todo) { parent.set(keyOf(cell), null); frontier.push(cell); }
    const box = { x0: Math.min(...frame.map(c => c.x)) - 3, x1: Math.max(...frame.map(c => c.x)) + 3, z0: Math.min(...frame.map(c => c.z)) - 3, z1: Math.max(...frame.map(c => c.z)) + 3,
      y0: Math.min(...frame.map(c => c.y)) - 5, y1: Math.max(...frame.map(c => c.y)) + 2 };
    const order: Face[] = ['down', 'north', 'south', 'west', 'east', 'up'];
    for (let depth = 0; depth < 8 && frontier.length; depth++) {
      const next: Cell[] = [];
      for (const cell of frontier) for (const face of order) {
        const around = shift(cell, face);
        const key = keyOf(around);
        if (parent.has(key) || frameKeys.has(key) || interiorKeys.has(key)) continue;
        if (around.x < box.x0 || around.x > box.x1 || around.z < box.z0 || around.z > box.z1 || around.y < box.y0 || around.y > box.y1) continue;
        if (!isOpenCell(read(around.x, around.y, around.z))) continue;
        parent.set(key, cell);
        if (supported(around)) {
          const chain: Cell[] = [];
          for (let at: Cell | null = around; at && !frameKeys.has(keyOf(at)); at = parent.get(keyOf(at)) ?? null) chain.push(at);
          return chain;
        }
        next.push(around);
      }
      frontier = next;
    }
    return null;
  };

  const build = async (): Promise<StepOutcome | null> => {
    for (let guard = 0; guard < 60; guard++) {
      if (timeIsUp(ctx)) return stop('limit_time', `${seconds} 秒の上限に達した`, args.at);
      const todo = missingFrame();
      if (!todo.length) return null;
      const ready = todo.filter(supported);
      ctx.progress?.(progress());
      if (ready.length) {
        // The lowest first, the nearest of those; then every other that the same place reaches.
        const here = feetCell(bot)!;
        const first = [...ready].sort((a, b) => a.y - b.y || dist(a, here) - dist(b, here))[0];
        const failure = await lay(first, block, [...todo, ...scaffolds]);
        if (failure) return failure;
        for (const other of [...ready].sort((a, b) => a.y - b.y)) {
          if (framed(other) || sameCell(other, first) || timeIsUp(ctx)) continue;
          const stand = feetCell(bot)!;
          if (eyeTo(stand, other) > PLACE_REACH || !supported(other)) continue;
          await place(ctx, { block, at: [other] });
        }
        continue;
      }
      // Nothing to set the next block against: a scaffold chain from the ground or from the frame laid so far.
      const lowest = [...todo].sort((a, b) => a.y - b.y)[0];
      const chain = chainTo(todo);
      if (!chain) return stop('blocked', `枠の ${cellText(lowest)} に当てる面が無く、足場も 8 個以内では届かない`, lowest);
      if (!scaffoldBlock) return stop('blocked', `枠の ${cellText(lowest)} に当てる面が無い（足場を置いてよい物が無い。canPlace に cobblestone などを挙げる。角 ${cellText(corners[0])} などに仮置きして組む）`, lowest);
      if (budget() < chain.length) return stop('blocked', `枠の ${cellText(lowest)} に届く足場に ${chain.length} 個要るが置けるのは ${budget()} 個まで（maxPlace か持ち物）`, lowest);
      for (const cell of chain) {
        const failure = await lay(cell, scaffoldBlock, [...todo, ...scaffolds, ...chain]);
        if (failure) return failure;
        scaffolds.push(cell);
        counts.scaffold++;
      }
    }
    return stop('stuck', '枠を組む手が進まない', args.at);
  };

  /** The scaffolds dug out again, the last laid first. */
  const clearScaffolds = async (): Promise<void> => {
    for (const cell of [...scaffolds].reverse()) {
      if (timeIsUp(ctx)) break;
      if (read(cell.x, cell.y, cell.z)?.name !== scaffoldBlock) { counts.removed++; continue; }
      const here = feetCell(bot)!;
      const stands = standCells(read, cell, 5, cell.y - 5, cell.y + 3).filter(stand => !inside(stand) && eyeTo(stand, cell) <= DIG_REACH_PLAN && blockInSight(read, eyeAtCell(stand), cell).visible);
      const stand = stands.find(s => sameCell(s, here)) ?? stands.sort((a, b) => dist(a, here) - dist(b, here))[0];
      if (!stand || await moveTo(ctx, stand)) { counts.notes.push(`足場 ${cellText(cell)} は残った`); continue; }
      // With a pickaxe the block drops and is taken; by hand nothing drops (cobblestone needs one), which is what is wanted of a scaffold gone.
      const dug = await dig(ctx, { at: [cell], collect: true, ...(bot.inventory?.items?.().some((item: { name: string }) => item.name.endsWith('_pickaxe')) ? {} : { tool: 'hand' }) });
      if (dug.ok) counts.removed++; else counts.notes.push(`足場 ${cellText(cell)} は残った`);
    }
  };

  // ---- lighting --------------------------------------------------------------------------------------------------------------------------

  const light = async (): Promise<StepOutcome | null> => {
    // Flint and steel lights the cell beside the face it is used on: the inside's lower cells, from the top of the bottom row or from the side of the column.
    const lower = [interior[0], interior[1]];
    const first = axis === 'x' ? { toward: 'west' as Face, away: 'east' as Face } : { toward: 'north' as Face, away: 'south' as Face };
    const ways: Array<{ cell: Cell; against: Face }> = [
      { cell: lower[0], against: 'down' }, { cell: lower[1], against: 'down' },
      { cell: lower[0], against: first.toward }, { cell: lower[1], against: first.away },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      if (timeIsUp(ctx)) return stop('limit_time', `${seconds} 秒の上限に達した`, args.at);
      const here = feetCell(bot)!;
      const choices = ways.flatMap(way => {
        const ref = shift(way.cell, way.against);
        const face = OPPOSITE[way.against];
        return standCells(read, args.at, 5, args.at.y - 6, args.at.y + 4).filter(stand => !inside(stand) && clickLands(read, eyeAtCell(stand), ref, face, 4.4))
          .map(stand => ({ ...way, stand, cost: dist(stand, here) }));
      }).sort((a, b) => a.cost - b.cost);
      const choice = choices[0];
      if (!choice) return stop('stuck', `${cellText(args.at)} に火打ち金を当てられる立ち位置が無い（床・柱の面を 4.4m 内で見る所）`, args.at);
      const moved = await moveTo(ctx, choice.stand);
      if (moved) return stop('stuck', `火を点ける立ち位置 ${cellText(choice.stand)} に着けない: ${moved.text.slice(0, 70)}`, choice.stand);
      const flint = await use(ctx, { item: 'flint_and_steel', at: choice.cell, against: choice.against });
      if (!flint.ok && flint.reason !== 'not_lit' && flint.reason !== 'occupied') return stop('ignite_failed', `火を点けられなかった: ${flint.text.slice(0, 90)}`, args.at);
      if (await waitUntil(ctx, lit, IGNITE_WAIT_MS, 100)) return null;
    }
    const missing = missingFrame();
    const what = interior.map(cell => `${read(cell.x, cell.y, cell.z)?.name ?? '未ロード'}`).filter((name, index, all) => all.indexOf(name) === index).join('・');
    return stop('ignite_failed', `火を点けたがポータルにならない（枠 ${10 - missing.length}/10${missing.length ? `、足りない ${cellText(missing[0])}` : ''}、内側は ${what}）`, args.at);
  };

  // ---- going in --------------------------------------------------------------------------------------------------------------------------

  const fired = alreadyLit ? 'もう点いていた' : '点火';
  const goIn = async (): Promise<StepOutcome> => {
    const start = dimensionOf(bot);
    const walked = await walk(ctx, { to: args.at, range: 0, sprint: false });
    const dimension = dimensionOf(bot);
    const base = `枠 10 個${laid() ? `（置いた ${laid()}）` : ''}${counts.scaffold ? `・足場 ${counts.scaffold} 個（外した ${counts.removed}）` : ''}${counts.pillar ? `・柱 ${counts.pillar} 段（残した）` : ''}`;
    if (walked.ok && walked.data?.crossedDimension) return { ...walked, text: `portal 済 ${base}・${fired}・入った（次元 ${dimension}）${counts.notes.length ? `・${counts.notes.join('・')}` : ''}`, data: { ...walked.data, crossedDimension: true } };
    if (walked.ok && dimension !== start) return { ...walked, text: `portal 済 ${base}・${fired}・入った（次元 ${dimension}）`, data: { crossedDimension: true } };
    if (walked.ok) return { ...walked, text: `portal 済 ${base}・${fired}・ポータルの中で待ったがまだ次元は変わらない（${walked.text.slice(0, 80)}）` };
    return stop('stuck', `点いたポータル ${cellText(args.at)} に入れなかった: ${walked.text.slice(0, 90)}`, args.at);
  };

  /** A stop in the middle of the building: the scaffolds are taken out as far as the time allows (a frame is left as it is). */
  const tidy = async (): Promise<void> => {
    try { if (!timeIsUp(ctx)) await clearScaffolds(); } catch { /* the stop stands as it is */ }
  };

  if (!alreadyLit) {
    const built = await build();
    if (built) { await tidy(); return built; }
    // Lit while the body may still stand where it laid the top (a pillar it cannot climb again), then the scaffolds out, then in.
    const lighted = await light();
    if (lighted) { await tidy(); return lighted; }
  }
  await clearScaffolds();
  if (enter) return goIn();
  const done = `枠 10 個${laid() ? `（置いた ${laid()}）` : ''}${counts.scaffold ? `・足場 ${counts.scaffold} 個（外した ${counts.removed}）` : ''}${counts.pillar ? `・柱 ${counts.pillar} 段（残した）` : ''}`;
  return { ok: true, text: `portal 済 ${done}・${fired}・入らなかった（enter なし）${counts.notes.length ? `・${counts.notes.join('・')}` : ''}`, at: args.at };

}


const COMMON_FIELDS = ['do', 'rel', 'note', 'onFail'];
const BLOCK_NAME = /^[a-z][a-z0-9_]{0,39}$/u;
/**
 * What is wrong with a portal hand beyond the schema, in the head's own ranges (minecraftActHandRules.ts: needs `at` and `axis`; may `block`, `enter`,
 * `canPlace`, `maxPlace`, `seconds`; `at` exactly one cell, `seconds` 5 to 120). Null when it is well formed.
 */
export function portalProblem(hand: Record<string, unknown>, cellOk: (spec: unknown) => boolean): string | null {
  const allowed = new Set([...COMMON_FIELDS, 'at', 'axis', 'block', 'enter', 'canPlace', 'maxPlace', 'seconds']);
  const extra = Object.keys(hand).filter(key => hand[key] !== undefined && !allowed.has(key));
  if (extra.length) return `${extra.join('・')} は使えない（portal の欄: at・axis・block・enter・canPlace・maxPlace・seconds）`;
  const at = hand.at;
  if (!Array.isArray(at) || at.length !== 1) return 'at は枠の内側の左下のマス 1 つ';
  if (!at.every(cellOk)) return 'at のマスが読めない';
  if (hand.axis !== 'x' && hand.axis !== 'z') return 'axis（x か z）が要る';
  const seconds = hand.seconds as number | undefined;
  if (seconds !== undefined && (seconds < 5 || seconds > 120)) return 'seconds は 5〜120';
  if (Array.isArray(hand.canPlace) && (hand.canPlace as string[]).some(name => !BLOCK_NAME.test(name))) return 'canPlace はブロックの id（小文字の英字と _）';
  return null;
}
