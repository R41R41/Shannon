import { Vec3 } from 'vec3';
import { feetCell, type Cell } from '../localMap.js';
import { dropBurns, dropRisk, type DropRisk } from '../dropFate.js';
import { blockAt, cellText, eyeDistance, inventoryCount, isAirLike, USE_REACH, waitUntil, type StepContext } from './common.js';
import { DAM_BLOCKS } from './stanch.js';
import { place } from './place.js';
import { dimensionOf } from './walk.js';
import { waterReachesBody } from './wetWall.js';

/**
 * The drop of a block kept from lava, as a person keeps it (run 8, 11/13: six obsidian lost to lava, one beside the block and five under it; the owner: "接している溶岩が流れてきて
 * アイテム化した黒曜石が消えちゃう場所を掘っちゃってる"; the old instant skill digBlockAt's keepDropFromLava and crushLava, moved onto the primitives):
 *   - lava over the block or at its sides is put out first with a cheap block laid in its cell (the block is set against what the place hand finds first: the lava's floor, else the block itself);
 *   - a drop that would fall through air into lava is held by a block laid in the cell under the block;
 *   - lava right under the block cannot be reached from the body's side: water put on top of the block (a water bucket carried) falls into the hole when the block goes and sets that
 *     lava before the drop gets there; without water the block is not to be dug and that is said.
 * Only from where the body stands (a cell out of the hand's reach is left, the body is not moved: the dig's stand is the dig's). The blocks are the cheap ones (stanch.DAM_BLOCKS) or the
 * ones the planner let the hand lay (`blocks`), at most `maxPlace`. What was laid and poured is told; `left` says what still burns.
 */
export interface DropGuardOptions {
  /** The blocks that may be laid (default: the cheap ones, DAM_BLOCKS). An empty list lays none. */
  blocks?: readonly string[];
  /** At most this many blocks laid (default 4). */
  maxPlace?: number;
  /** Water may be put on top of the block when lava lies right under it (a water bucket carried). */
  water?: boolean;
  /** Only the lava over and beside the block (the lava a dig would let onto the body), not what lies under it. */
  aroundOnly?: boolean;
}
export interface DropGuardResult {
  placed: Cell[];
  /** The block laid (the first). */
  block: string | null;
  /** The water source put on top of the block (to be taken back after the dig), or null. */
  poured: Cell | null;
  /** Water stood on top of the block already (the planner's own or another hand's): the hole fills from it. */
  covered: boolean;
  /** What still burns the drop, or null. */
  left: { at: Cell; where: 'over' | 'side' | 'under' | 'fall'; why: string } | null;
  words: string;
}

const DEFAULT_MAX_PLACE = 4;
const LAVA_GONE_MS = 1000;
const WATER_ON_MS = 1500;
const vec = (cell: Cell) => new Vec3(cell.x, cell.y, cell.z);
const plain = (v: { x: number; y: number; z: number }): Cell => ({ x: v.x, y: v.y, z: v.z });
const isLavaAt = (bot: any, cell: Cell) => blockAt(bot, cell)?.name === 'lava';

/** The first of the allowed blocks the pack holds, cheap junk first. */
export function guardBlockHeld(bot: any, blocks: readonly string[] = DAM_BLOCKS): string | null {
  const order = [...DAM_BLOCKS.filter(name => blocks.includes(name)), ...blocks.filter(name => !DAM_BLOCKS.includes(name))];
  return order.find(name => inventoryCount(bot, name) > 0) ?? null;
}

/**
 * Whether laid blocks alone keep the drop (no water needed): nothing right under the block, a block held for every cell to fill, and that many places left.
 * The obsidian hand reads it to decide whether its own water stays over the hole.
 */
export function blocksKeepDrop(bot: any, risk: DropRisk, blocks: readonly string[] = DAM_BLOCKS, maxPlace = DEFAULT_MAX_PLACE): boolean {
  if (risk.under === 'direct') return false;
  const cells = risk.around.length + (risk.under === 'fall' ? 1 : 0);
  if (!cells) return true;
  let held = 0;
  for (const name of blocks) held += inventoryCount(bot, name);
  return !!guardBlockHeld(bot, blocks) && held >= cells && maxPlace >= cells;
}

export async function guardDrop(ctx: StepContext, cell: Cell, options: DropGuardOptions = {}): Promise<DropGuardResult> {
  const bot = ctx.bot;
  const blocks = options.blocks ?? DAM_BLOCKS;
  const maxPlace = Math.max(0, options.maxPlace ?? DEFAULT_MAX_PLACE);
  const placed: Cell[] = [];
  let block: string | null = null;
  let left: DropGuardResult['left'] = null;
  const read = () => dropRisk(bot as never, vec(cell));
  /** One cell filled with a block: true when it is no longer lava or air. */
  const fill = async (at: Cell): Promise<string | null> => {
    if (placed.length >= maxPlace) return `置ける数（${maxPlace}）を使い切った`;
    const name = guardBlockHeld(bot, blocks);
    if (!name) return blocks.length ? `置ける石（${blocks.slice(0, 3).join('・')} など）を持っていない` : '置いてよい物が無い（canPlace）';
    const distance = eyeDistance(bot, at);
    if (distance > USE_REACH) return `目から ${distance.toFixed(1)}m で届かない`;
    const out = await place(ctx, { block: name, at: [at] });
    if (!out.ok) return out.text.slice(0, 60);
    await waitUntil(ctx, () => !isLavaAt(bot, at) && !isAirLike(blockAt(bot, at)), LAVA_GONE_MS);
    const now = blockAt(bot, at);
    if (!now || now.name === 'lava' || isAirLike(now)) return `置いた後も ${now?.name ?? '未ロード'}`;
    placed.push(at);
    block ??= name;
    return null;
  };
  // Over and beside: each lava cell put out, nearest to the eyes first (new lava may run in from behind it: read again, at most a few rounds).
  for (let round = 0; round < 3 && !left; round++) {
    const around = read().around.map(plain).sort((a, b) => eyeDistance(bot, a) - eyeDistance(bot, b));
    if (!around.length) break;
    for (const lava of around) {
      if (!isLavaAt(bot, lava)) continue;
      const why = await fill(lava);
      if (why) { left = { at: lava, where: lava.y > cell.y ? 'over' : 'side', why }; break; }
    }
  }
  let poured: Cell | null = null, covered = false;
  if (!left && !options.aroundOnly) {
    let risk = read();
    if (risk.under === 'fall') {
      // The drop falls through air into lava: the cell under the block is filled, and the drop rests on it.
      const under = { x: cell.x, y: cell.y - 1, z: cell.z };
      const why = isAirLike(blockAt(bot, under)) ? await fill(under) : 'すぐ下が空気ではない';
      risk = read();
      if (why && risk.under) left = { at: plain(risk.below!), where: 'fall', why };
    }
    if (!left && risk.under === 'direct') {
      const over = { x: cell.x, y: cell.y + 1, z: cell.z };
      const top = blockAt(bot, over);
      const feet = feetCell(bot as never);
      if (top?.name === 'water') covered = true;
      else {
        const below = plain(risk.below!);
        let why = '';
        if (!options.water) why = '水をかける手ではない';
        // Water boils away in the Nether (the bucket is emptied, the lava stays): the obsidian hand refuses the same way.
        else if (dimensionOf(bot).includes('nether')) why = 'ネザーでは水が蒸発する';
        else if (inventoryCount(bot, 'water_bucket') <= 0) why = '水入りバケツを持っていない';
        // A source over the block runs onto the body when it lies at the head's height or above (the lake face at the feet's height: the water
        // falls from the head's cell onto the feet, the dig goes five times slower, the body is pushed), and at the feet's height when the body is shut in
        // (wetWall.waterReachesBody: it fills the tunnel and pushes the body). So the feet stand a step over the block on open ground, two steps in a tunnel.
        else if (waterReachesBody(bot, over, feet, 0)) why = feet && feet.y === over.y
          ? '上に置く水が囲まれた足元に流れる（囲まれた所では 2 段上から掘れば水をかけられる）'
          : '上に水をかけると頭に流れる（1 段上・囲まれた所なら 2 段上から掘れば水をかけられる）';
        else if (!isAirLike(top)) why = `上 ${cellText(over)} が ${top?.name ?? '未ロード'} で水を置けない`;
        else if (eyeDistance(bot, over) > USE_REACH) why = `上 ${cellText(over)} に届かない`;
        else {
          const { use } = await import('./use.js');
          const out = await use(ctx, { item: 'water_bucket', at: over, against: 'down' });
          if (out.ok && await waitUntil(ctx, () => blockAt(bot, over)?.name === 'water', WATER_ON_MS)) poured = over;
          else why = `上に水を置けなかった（${out.text.slice(0, 40)}）`;
        }
        if (!poured) left = { at: below, where: 'under', why };
      }
    }
  }
  const sides = placed.filter(at => at.y === cell.y).length, overs = placed.filter(at => at.y > cell.y).length, unders = placed.filter(at => at.y < cell.y).length;
  const parts = [sides ? `横 ${sides}` : '', overs ? `上 ${overs}` : '', unders ? `下の空き ${unders}` : ''].filter(Boolean).join('・');
  const words = [
    placed.length ? `溶岩で焼けないよう ${placed.length} マス（${parts}）を ${block} で埋めた` : '',
    poured ? `下 ${cellText({ x: cell.x, y: cell.y - 1, z: cell.z })} が溶岩なので上に水をかけてから掘る` : '',
    left ? `${left.where === 'under' ? '下' : left.where === 'fall' ? '落ちる先' : left.where === 'over' ? '上' : '横'} ${cellText(left.at)} が溶岩で落とし物が焼ける（${left.why}）` : '',
  ].filter(Boolean).join('、');
  return { placed, block, poured, covered, left, words };
}

/** Whether the drop of `cell` would burn now (any lava round it or under its fall). */
export const dropWouldBurn = (bot: any, cell: Cell): boolean => dropBurns(dropRisk(bot as never, vec(cell)));
