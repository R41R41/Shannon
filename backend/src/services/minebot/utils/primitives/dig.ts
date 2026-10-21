import { Vec3 } from 'vec3';
import { digBlockVerified, ServerDigUnconfirmedError } from '../digBlockVerified.js';
import { equipToHandVerified } from '../equipVerified.js';
import { threatsExposedBy, ThreatExposedError, type ExposingThreat } from '../exposureGuard.js';
import { LavaReleaseError, lavaReleasedBy } from '../lavaSafety.js';
import { fallIsDangerous, stepOffDrop } from '../edgeGuard.js';
import { chooseTool, canHarvest, usesLeft } from '../toolChoice.js';
import { PROTECTED_UTILITY_BLOCKS } from '../../constants.js';
import { cellKey, feetCell, relativeWords, type Cell } from '../localMap.js';
import { blockAt, cellNow, cellText, DIG_REACH, eyeDistance, findItem, guard, isAirLike, letGo, placeText, stopped, StepStopped, wait,
  type StepContext, type StepOutcome } from './common.js';
import { pickup } from './pickup.js';

/**
 * dig: the cells in order (design mb-llm-centric 2.3). The tool is the one asked for, else the quickest carried that makes the block
 * drop; none is made, none is placed, no way round is dug. It stops, saying exactly why, at a cell it cannot reach, one nothing can
 * break, one that needs a tool not carried, a chest or bed or furnace (it may be a village's: `take` digs it), one that would let a
 * shut-out hostile at the body (`exposeOk` digs it), and (the safety rules that stay) one that would let lava onto the body or drop the
 * body a dangerous height. A cell already empty is said and passed.
 */
export interface DigArgs { at: Cell[]; tool?: string; collect?: boolean; take?: boolean; exposeOk?: boolean | string[] }

/** Whether the planner has let this kind in: every kind (true), or the kinds it named. */
export function exposeAllows(exposeOk: boolean | string[] | undefined, kind: string): boolean {
  if (exposeOk === true) return true;
  return Array.isArray(exposeOk) && exposeOk.some(name => String(name).toLowerCase().replace(/^minecraft:/u, '') === kind.toLowerCase());
}

const MAX_CELLS = 16;
const UNBREAKABLE = new Set(['bedrock', 'barrier', 'end_portal_frame', 'end_portal', 'end_gateway', 'command_block', 'structure_block', 'reinforced_deepslate']);

/** The fall the body takes if this cell, one it stands on, is gone (null: not under the body, or a fall it survives). */
function footingDrop(bot: any, cell: Cell): number | null {
  const position = bot.entity?.position;
  if (!position || Math.floor(position.y - 0.01) !== cell.y) return null;
  const corners = [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]];
  if (!corners.some(([dx, dz]) => Math.floor(position.x + dx) === cell.x && Math.floor(position.z + dz) === cell.z)) return null;
  const without = { blockAt: (at: Vec3) => (Math.floor(at.x) === cell.x && Math.floor(at.y) === cell.y && Math.floor(at.z) === cell.z
    ? { name: 'air', boundingBox: 'empty' } : bot.blockAt(at)) as any };
  let drop = 0;
  try { drop = stepOffDrop(without, position.x, position.y, position.z); } catch { return null; }
  return fallIsDangerous(drop, bot.health ?? 20) ? drop : null;
}

async function holdTool(ctx: StepContext, block: any, asked: string | undefined): Promise<{ held: string; fail?: StepOutcome }> {
  const bot = ctx.bot;
  if (asked === 'hand') {
    if (bot.heldItem) { try { await guard(ctx, Promise.resolve(bot.unequip('hand')), 3000); } catch (error) { if (error instanceof StepStopped) throw error; } }
    return { held: '素手' };
  }
  let item: any = null;
  if (asked) {
    item = findItem(bot, asked);
    if (!item) return { held: '', fail: stopped(bot, 'missing_item', `${asked} を持っていない（${block.name} を掘る道具に指定された）`) };
  } else {
    const tools = (bot.inventory?.items?.() ?? []) as any[];
    item = chooseTool(block, tools, { requireHarvest: true, effects: bot.entity?.effects });
    if (!item && block.harvestTools && !tools.some(tool => canHarvest(block, tool))) {
      return { held: '', fail: stopped(bot, 'no_harvest_tool', `${block.name} は持っている道具では何も落ちない（掘る道具が無い）。何も落ちなくても掘るなら tool:"hand"`) };
    }
  }
  if (!item) return { held: bot.heldItem?.name ?? '素手' };
  if (bot.heldItem?.type === item.type) return { held: item.name };
  const outcome = await guard(ctx, equipToHandVerified(bot, item), 5000);
  if (!outcome?.value.held) return { held: '', fail: stopped(bot, 'equip_failed', `${item.name} を手に持てなかった（${outcome?.value.detail ?? '時間切れ'}）`) };
  return { held: item.name };
}

export async function dig(ctx: StepContext, args: DigArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const cells = args.at ?? [];
  if (!cells.length) return stopped(bot, 'invalid_input', 'dig には at（掘るマスの列）が要る');
  if (cells.length > MAX_CELLS) return stopped(bot, 'invalid_input', `dig は 1 手で ${MAX_CELLS} マスまで`);
  const done: string[] = [];
  const before = new Set(Object.keys(bot.entities ?? {}).map(Number));
  const dugCells: Cell[] = [];
  const result = (outcome: StepOutcome) => ({ ...outcome, text: `${done.length ? `${done.join('、')}。` : ''}${outcome.text}` });
  for (const cell of cells) {
    const block = blockAt(bot, cell);
    if (!block) return result(stopped(bot, 'unloaded', `${placeText(bot, cell)} は未ロード`, cell));
    if (isAirLike(block) || block.name === 'water' || block.name === 'lava') { done.push(`${cellText(cell)} は既に ${cellNow(bot, cell)}（掘らずに次へ）`); continue; }
    if (UNBREAKABLE.has(block.name) || block.diggable === false || block.hardness === null || block.hardness < 0) {
      return result(stopped(bot, 'unbreakable', `${placeText(bot, cell)} の ${block.name} は壊せない`, cell));
    }
    if (PROTECTED_UTILITY_BLOCKS.has(block.name) && !args.take) {
      return result(stopped(bot, 'protected', `${placeText(bot, cell)} は ${block.name}（村や自分の設備かもしれない。中身・ベッドを持っていくなら take:true で掘る）`, cell));
    }
    const fall = footingDrop(bot, cell);
    if (fall !== null) return result(stopped(bot, 'footing', `${placeText(bot, cell)} は足元の支え。掘ると${fall}段落ちる（先に横へ動くか、下を確かめる）`, cell));
    const distance = eyeDistance(bot, cell);
    if (distance > DIG_REACH) return result(stopped(bot, 'out_of_reach', `${placeText(bot, cell)} の ${block.name} に届かない（目から${distance.toFixed(1)}m、${DIG_REACH}m まで）`, cell));
    const lava = lavaReleasedBy(bot, vecOf(cell));
    if (lava) return result(stopped(bot, 'lava_behind', `${placeText(bot, cell)} を掘ると、隣の溶岩 ${cellText({ x: lava.x, y: lava.y, z: lava.z })} が体の所へ流れ込む`, cell));
    let threats: ExposingThreat[] = [];
    try { threats = threatsExposedBy(bot, vecOf(cell)); } catch { threats = []; }
    const letIn = threats.filter(threat => !exposeAllows(args.exposeOk, threat.name));
    if (letIn.length) {
      const feet = feetCell(bot);
      const who = letIn.map(threat => `${threat.name}（id ${threat.id ?? '?'}、${cellText(threat.position)}${feet ? ` 自分から${relativeWords(feet, threat.position)}` : ''}、${threat.distance.toFixed(1)}m）`).join('、');
      return result(stopped(bot, 'threat_exposed', `${placeText(bot, cell)} を開けると、今は届かない ${who} から見える・届くようになる。開けるなら exposeOk:true か exposeOk:["${letIn[0].name}"]（受け入れる種類）`, cell));
    }
    const exposing = threats.length > 0;
    const tool = await holdTool(ctx, block, args.tool);
    if (tool.fail) return result({ ...tool.fail, at: cell });
    const guardState = bot.exposureDigGuard as { allowAt?: string } | undefined;
    if (exposing && guardState) guardState.allowAt = cellKey(cell);
    const started = Date.now();
    try {
      const expected = typeof bot.digTime === 'function' ? Number(bot.digTime(block)) || 0 : 0;
      const dug = await guard(ctx, digBlockVerified(bot, block), expected * 2 + 12_000);
      if (!dug) { letGo(bot); return result(stopped(bot, 'timeout', `${placeText(bot, cell)} の ${block.name} が時間内に掘れなかった（今 ${cellNow(bot, cell)}）`, cell)); }
    } catch (error) {
      if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) { letGo(bot); throw error; }
      if (error instanceof ThreatExposedError) return result(stopped(bot, 'threat_exposed', `${(error as Error).message}（開けるなら exposeOk:true）`, cell));
      if (error instanceof LavaReleaseError) return result(stopped(bot, 'lava_behind', (error as Error).message, cell));
      if (error instanceof ServerDigUnconfirmedError) return result(stopped(bot, 'dig_unconfirmed', `${placeText(bot, cell)} の ${block.name} をサーバーが壊したと言わない（今 ${cellNow(bot, cell)}）`, cell));
      return result(stopped(bot, 'dig_failed', `${placeText(bot, cell)} の ${block.name} を掘れなかった: ${String((error as Error)?.message ?? error).slice(0, 100)}（今 ${cellNow(bot, cell)}）`, cell));
    } finally { if (guardState && guardState.allowAt === cellKey(cell)) guardState.allowAt = undefined; }
    dugCells.push(cell);
    await wait(ctx, 150);
    const now = blockAt(bot, cell);
    const refilled = now && !isAirLike(now) && now.name !== 'water' && now.name !== 'lava' ? `（掘った後、今は ${now.name}: 上から落ちてきた）` : now && (now.name === 'water' || now.name === 'lava') ? `（掘った後、${now.name} が流れ込んだ）` : '';
    const left = usesLeft(bot.heldItem);
    done.push(`${cellText(cell)} ${block.name} を掘った（${tool.held}、${((Date.now() - started) / 1000).toFixed(1)}秒${left !== null && left <= 10 ? `、${bot.heldItem?.name} 残り${left}回` : ''}）${refilled}`);
    ctx.progress?.(`${done.length}/${cells.length}`);
  }
  if (args.collect !== false && dugCells.length) {
    await wait(ctx, 250);
    const near = Object.values(bot.entities ?? {}).filter((entity: any) => entity?.name === 'item' && !before.has(entity.id)
      && dugCells.some(cell => entity.position && Math.hypot(entity.position.x - cell.x - 0.5, entity.position.y - cell.y, entity.position.z - cell.z - 0.5) <= 2.5)) as any[];
    if (near.length) {
      const picked = await pickup(ctx, { ids: near.map(entity => entity.id) });
      done.push(picked.text);
    }
  }
  return { ok: true, text: done.join('、'), at: cells[cells.length - 1] };
}

const vecOf = (cell: Cell) => new Vec3(cell.x, cell.y, cell.z);
