import { Vec3 } from 'vec3';
import { createLogger } from '../../../utils/logger.js';
import { executeAction, preemptLowerPriorityActions } from '../execution/ActionExecution.js';
import { ensureReflexLedger } from './reflexLedger.js';
import { chooseTool } from './toolChoice.js';

const log = createLogger('Minebot:WallReflex');

/**
 * The wall reflex: a body whose head is inside a whole block (gravel or sand come down on it, a block laid into it) digs itself out at once.
 *
 * Run 41 (+1,805 to +1,821, replayed on its own ground in the lab): three gravel came down a shaft onto the body's feet and head. It lost a point
 * of health every half second for ten seconds while the head decided (4.6 s) and its next hand, a go, stood still; every reflex took the hurt for
 * "slight damage, left to eating", and the body died with its diamond pickaxe and iron armour. Suffocation does not wait for a decision.
 *
 * On its physics tick, when the eye's cell has been a whole block for two ticks, it takes the body (a safety lease above an act) and digs the
 * head's cell, then the feet's, again as long as more falls in (at most eight digs), with the quickest tool it carries.
 */
export const WALL_ESCAPE_PRIORITY = 420;
const EYE = 1.62;
/**
 * Run 42 (+711): lying in a bed at y=-5 in a cave, the server put the body at y=-4.31; the eye taken 1.62 above that was in the tuff of the ceiling,
 * and the reflex dug it out of the bed and cut the sleep. A body lying in a bed has its eye 0.2 above its place (the game's sleeping pose), and it
 * does not choke there: while it sleeps, or stands at a bed's place, the reflex does not take it.
 */
const LYING_EYE = 0.2;
const BED = /_bed$/u;
/** The eye in a whole block this long with no hurt seen is taken as true too (a client that missed the health packet). */
const TICKS_BEFORE = 20;
/** A hurt this recent, with the eye in a whole block, is the wall's (the server's suffocation is a point every half second). */
const HURT_FRESH_MS = 1200;
const MAX_DIGS = 8;
const RETRY_MS = 1500;
/** Whole blocks that do not choke (the game lets a body breathe in them). */
const BREATHES_IN = /(?:glass|_pane|leaves|ice$|^ice$|slime_block|honey_block|scaffolding|_bars|_fence|_wall$|_door|_trapdoor|chest|_bed$|barrier|spawner|farmland|dirt_path|soul_sand|mud$)/u;

interface WallBody {
  entity?: { position: Vec3; onGround?: boolean };
  health?: number;
  heldItem?: { type?: number; name?: string } | null;
  inventory?: { items(): any[] };
  blockAt(position: Vec3, extraInfos?: boolean): any;
  dig?(block: any, forceLook?: boolean | 'ignore'): Promise<unknown>;
  equip?(item: unknown, destination: string): Promise<unknown>;
  on(event: 'physicsTick', listener: () => void): unknown;
  game?: { gameMode?: string };
  isSleeping?: boolean;
  wallReflex?: WallState;
}
export interface WallState { ticks: number; working: boolean; lastAt: number; escapes: number; health: number; hurtAt: number }

const cellOf = (x: number, y: number, z: number) => new Vec3(Math.floor(x), Math.floor(y), Math.floor(z));
/**
 * Lying in a bed: asleep, or at a sleeper's place (the server puts one 0.69 above the bed's cell, maybe before the client hears it sleeps; one standing
 * on the bed is 0.56 above it and is not lying).
 */
export function lying(bot: WallBody): boolean {
  if (bot.isSleeping) return true;
  const p = bot.entity?.position;
  if (!p || p.y - Math.floor(p.y) < 0.6) return false;
  try { return BED.test(String(bot.blockAt(cellOf(p.x, p.y, p.z), false)?.name ?? '')); } catch { return false; }
}
const eyeOf = (bot: WallBody): number => lying(bot) ? LYING_EYE : EYE;
/** A block a body chokes in: a whole cube that is not one of those it breathes in. */
export function chokes(block: any): boolean {
  if (!block || block.boundingBox !== 'block') return false;
  if (BREATHES_IN.test(String(block.name ?? ''))) return false;
  const shapes = Array.isArray(block.shapes) ? block.shapes as number[][] : [[0, 0, 0, 1, 1, 1]];
  return shapes.some(shape => shape[0] <= 0.01 && shape[1] <= 0.01 && shape[2] <= 0.01 && shape[3] >= 0.99 && shape[4] >= 0.99 && shape[5] >= 0.99);
}
/** The cells of the body that hold a block it chokes in: the eye's first, then the feet's. */
export function wallCells(bot: WallBody): Array<{ at: Vec3; block: any }> {
  const p = bot.entity?.position;
  if (!p) return [];
  const out: Array<{ at: Vec3; block: any }> = [];
  for (const at of [cellOf(p.x, p.y + eyeOf(bot), p.z), cellOf(p.x, p.y + 0.2, p.z)]) {
    if (out.some(entry => entry.at.equals(at))) continue;
    let block: any = null;
    try { block = bot.blockAt(at, false); } catch { block = null; }
    if (chokes(block)) out.push({ at, block });
  }
  return out;
}
export function inWall(bot: WallBody): boolean {
  const p = bot.entity?.position;
  if (!p) return false;
  let block: any = null;
  try { block = bot.blockAt(cellOf(p.x, p.y + eyeOf(bot), p.z), false); } catch { block = null; }
  return chokes(block);
}

async function digOut(bot: WallBody): Promise<{ success: boolean; result: string }> {
  let dug = 0;
  const names: string[] = [];
  for (let round = 0; round < MAX_DIGS; round++) {
    const cells = wallCells(bot);
    if (!cells.length) return { success: true, result: `壁の中から掘り出た（${dug} 個掘った: ${[...new Set(names)].join('・') || '無し'}）` };
    const { block } = cells[0];
    const tool = chooseTool(block, (bot.inventory?.items?.() ?? []) as any[], {});
    if (tool && bot.heldItem?.type !== tool.type && bot.equip) { try { await bot.equip(tool, 'hand'); } catch { /* the hand digs */ } }
    try { await bot.dig?.(block, 'ignore'); dug++; names.push(String(block.name)); }
    catch (error) { return { success: false, result: `壁の中の ${block.name} を掘れなかった: ${String((error as Error)?.message ?? error).slice(0, 80)}` }; }
  }
  return { success: !wallCells(bot).length, result: `${MAX_DIGS} 個掘っても上から落ち続ける（${[...new Set(names)].join('・')}）` };
}

export function installWallReflex(bot: WallBody): void {
  if (bot.wallReflex) return;
  const state: WallState = bot.wallReflex = { ticks: 0, working: false, lastAt: 0, escapes: 0, health: bot.health ?? 20, hurtAt: 0 };
  bot.on('physicsTick', () => {
    const health = bot.health ?? 20;
    if (health < state.health) state.hurtAt = Date.now();
    state.health = health;
    // Only a body that can choke: not a spectator or one in creative (a lab's own moves put those inside blocks).
    const mode = String(bot.game?.gameMode ?? 'survival');
    let walled = false;
    try { walled = health > 0 && (mode === 'survival' || mode === 'adventure') && !bot.isSleeping && inWall(bot); } catch { walled = false; }
    state.ticks = walled ? state.ticks + 1 : 0;
    // The hurt says the server has the head in the block too (a client a tick off the server's place is not dug out of a wall it is not in).
    const confirmed = state.ticks >= 2 && Date.now() - state.hurtAt < HURT_FRESH_MS;
    if (!walled || state.working || !(confirmed || state.ticks >= TICKS_BEFORE) || Date.now() - state.lastAt < RETRY_MS) return;
    state.working = true; state.lastAt = Date.now(); state.escapes++;
    const p = bot.entity!.position;
    const first = wallCells(bot)[0];
    const what = first ? `${first.block.name} (${first.at.x},${first.at.y},${first.at.z})` : '壁';
    log.warn(`🧱 頭が ${what} の中（窒息する）: 掘り出る`);
    let handle: ReturnType<ReturnType<typeof ensureReflexLedger>['begin']> | null = null;
    try { handle = ensureReflexLedger(bot as any).begin('wall', `壁の中（${what}、足 (${Math.floor(p.x)},${Math.floor(p.y + 0.001)},${Math.floor(p.z)})）を掘り出る`); } catch { handle = null; }
    try { preemptLowerPriorityActions(bot, WALL_ESCAPE_PRIORITY, 'wall_escape'); } catch { /* the dig goes on */ }
    void executeAction(bot as any, 'wall-escape', 10_000, () => digOut(bot), { priority: WALL_ESCAPE_PRIORITY, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true })
      .then(result => {
        log.info(`🧱 ${result.result}`);
        try { if (handle) ensureReflexLedger(bot as any).end(handle, result.success ? 'done' : 'failed'); } catch { /* the ledger is a note */ }
      }, () => { try { if (handle) ensureReflexLedger(bot as any).end(handle, 'failed'); } catch { /* the ledger is a note */ } })
      .finally(() => { state.working = false; });
  });
}

export function wallReflexPlugin(bot: unknown): void { installWallReflex(bot as WallBody); }
