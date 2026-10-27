import { Vec3 } from 'vec3';
import { digBlockVerified, ServerDigUnconfirmedError } from '../digBlockVerified.js';
import { equipToHandVerified } from '../equipVerified.js';
import { threatsExposedBy, ThreatExposedError, type ExposingThreat } from '../exposureGuard.js';
import { LavaReleaseError, lavaReleasedBy } from '../lavaSafety.js';
import { fallIsDangerous, stepOffDrop } from '../edgeGuard.js';
import { fallsOntoBody } from '../fallingAbove.js';
import { chooseTool, canHarvest, usesLeft } from '../toolChoice.js';
import { PROTECTED_UTILITY_BLOCKS } from '../../constants.js';
import { ownedAt, ownerWords } from '../ownedBlocks.js';
import { bodyReader, cellKey, feetCell, relativeWords, type Cell } from '../localMap.js';
import { blockInSight, eyeOf } from '../probeTools.js';
import { blockAt, cellNow, cellText, DIG_REACH, eyeDistance, findItem, guard, isAirLike, letGo, placeText, stopped, StepStopped, wait, waitUntil,
  type StepContext, type StepOutcome } from './common.js';
import { pickup } from './pickup.js';

/**
 * dig: the cells in order (design mb-llm-centric 2.3). The tool is the one asked for, else the quickest carried that makes the block
 * drop; none is made, none is placed, no way round is dug. It stops, saying exactly why, at a cell it cannot reach, one nothing can
 * break, one that needs a tool not carried, a chest or bed or furnace (it may be a village's: `take` digs it), one that would let a
 * shut-out hostile at the body (`exposeOk` digs it), and (the safety rules that stay) one that would let lava onto the body or drop the
 * body a dangerous height. A cell already empty is said and passed.
 */
export interface DigArgs {
  at: Cell[]; tool?: string; collect?: boolean; take?: boolean; exposeOk?: boolean | string[];
  /**
   * Run 42 (+820, replayed): dig a thin block the walk passes through but that holds the body up (a carpet, a snow layer: open to the walk, a
   * collision box to the feet). Without it such a cell is "already open" and nothing is dug. Not a hand's field: go's climb sets it for its floor.
   */
  thin?: boolean;
}

/** Whether the planner has let this kind in: every kind (true), or the kinds it named. */
export function exposeAllows(exposeOk: boolean | string[] | undefined, kind: string): boolean {
  if (exposeOk === true) return true;
  return Array.isArray(exposeOk) && exposeOk.some(name => String(name).toLowerCase().replace(/^minecraft:/u, '') === kind.toLowerCase());
}

const MAX_CELLS = 16;
const UNBREAKABLE = new Set(['bedrock', 'barrier', 'end_portal_frame', 'end_portal', 'end_gateway', 'command_block', 'structure_block', 'reinforced_deepslate']);

/**
 * The fall the body takes if this cell is gone (null: not in the body's column under its feet, or a fall it survives). Run 27 (2026-10-22):
 * a dig straight down took the next cell while the body was still dropping into the one before, so "the cell under the feet" was not
 * that cell and nothing was checked; the body fell 19 hearts into a cave. Any cell of the column under the feet now counts, as the
 * fall to the first floor left without it (lava below: no landing).
 */
export function footingDrop(bot: any, cell: Cell): number | null {
  const position = bot.entity?.position;
  if (!position || cell.y > Math.floor(position.y - 0.01)) return null;
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
    if ((isAirLike(block) && !(args.thin && block.boundingBox === 'block')) || block.name === 'water' || block.name === 'lava') { done.push(`${cellText(cell)} は既に ${cellNow(bot, cell)}（掘らずに次へ）`); continue; }
    if (UNBREAKABLE.has(block.name) || block.diggable === false || block.hardness === null || block.hardness < 0) {
      return result(stopped(bot, 'unbreakable', `${placeText(bot, cell)} の ${block.name} は壊せない`, cell));
    }
    // r8 (run 32: the body's own bed, placed 200 s before, stopped its dig): a protected block the body put there itself (its ledger, utils/
    // ownedBlocks) or the bed it sleeps in is dug without a word from the planner; any other may be a village's or another player's, and the
    // stop says whose it is not known to be.
    let own: ReturnType<typeof ownedAt> = null;
    if (PROTECTED_UTILITY_BLOCKS.has(block.name) && !args.take) {
      own = ownedAt(bot, cell, block.name);
      if (!own) {
        return result(stopped(bot, 'protected', `${placeText(bot, cell)} は ${block.name}（誰の物か分からない: 自分で置いた記録もスポーン地点のベッドでもない。村や他人の物かもしれない。`
          + `壊すなら takeOk:true）`, cell));
      }
    }
    // The body still dropping into the cell dug before: wait until it stands (at most 1 s) so its column is read where it lands.
    if (bot.entity && bot.entity.onGround === false) await waitUntil(ctx, () => bot.entity?.onGround !== false, 1000);
    const falls = fallsOntoBody(bot, cell, at => blockAt(bot, at));
    if (falls) {
      return result(stopped(bot, 'falling_above', `${placeText(bot, cell)} の上 ${cellText(falls.at)} が ${falls.name}。掘ると落ちてきて足と頭を埋める（窒息する）。`
        + `横へ 1 マスずれてから掘るか、先に横から ${falls.name} を掘り落とす`, cell));
    }
    const fall = footingDrop(bot, cell);
    if (fall !== null) return result(stopped(bot, 'footing', `${placeText(bot, cell)} は足の下の柱。掘ると${Number.isFinite(fall) ? `${fall}段落ちる` : '下に着く所が無いか溶岩'}（先に横へ動くか、下を確かめる）`, cell));
    const distance = eyeDistance(bot, cell);
    if (distance > DIG_REACH) return result(stopped(bot, 'out_of_reach', `${placeText(bot, cell)} の ${block.name} に届かない（目から${distance.toFixed(1)}m、${DIG_REACH}m まで）`, cell));
    // The eye has to see a face of it (run 28: 31 digs "Digging aborted" at cells behind stone, the reason never said). Cells dug before in
    // this hand are air now, so a row dug from the near end opens its own way.
    const position = bot.entity?.position;
    const sight = position ? blockInSight(bodyReader(bot), eyeOf(position), cell) : { visible: true, between: [] };
    if (!sight.visible) {
      return result(stopped(bot, 'not_visible', `${placeText(bot, cell)} の ${block.name} が見えない：間に ${sight.between.map(b => `${cellText(b.at)} ${b.name}`).join('、') || '固いブロック'}（目から${distance.toFixed(1)}m）`, cell));
    }
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
    done.push(`${cellText(cell)} ${block.name} を掘った（${tool.held}、${((Date.now() - started) / 1000).toFixed(1)}秒${left !== null && left <= 10 ? `、${bot.heldItem?.name} 残り${left}回` : ''}${own ? `。${ownerWords(own)}` : ''}）${refilled}`);
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
