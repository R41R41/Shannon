import { Vec3 } from 'vec3';
import { equipToHandVerified } from '../equipVerified.js';
import { type Cell } from '../localMap.js';
import { blockAt, cellNow, cellText, DIRECTION_JA, DIRECTIONS, eyeDistance, findItem, guard, inventoryCount, isAirLike, placeText, stopped,
  StepStopped, USE_REACH, wait, type StepContext, type StepOutcome } from './common.js';

/**
 * place: a block into each cell in order (design mb-llm-centric 2.3). The cell is the planner's: no place is chosen for it, the body
 * does not step aside, nothing is dug to make room. `against` names the neighbour it is set against (down, up, north, south, east,
 * west); without it the first solid neighbour, below first. It stops at a cell that is taken, one the body or a creature stands in, one
 * with nothing to set against, one out of reach, or when the server takes nothing; and says what the cell holds now.
 */
export interface PlaceArgs { block: string; at: Cell[]; against?: string }

const MAX_CELLS = 16;
const ORDER = ['down', 'north', 'south', 'west', 'east', 'up'];
/** What a block can be put into (as the game: air, water and lava, grass and the like). */
const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'bubble_column', 'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern',
  'dead_bush', 'seagrass', 'tall_seagrass', 'vine', 'glow_lichen', 'snow', 'fire', 'soul_fire', 'light', 'structure_void']);

/** The cells the body's box fills (0.6 wide, 1.8 tall), at its position now. */
export function bodyCells(position: { x: number; y: number; z: number }): Cell[] {
  const cells: Cell[] = [];
  for (const dx of [-0.3, 0.3]) for (const dz of [-0.3, 0.3]) for (const dy of [0, 0.9, 1.79]) {
    const cell = { x: Math.floor(position.x + dx), y: Math.floor(position.y + dy), z: Math.floor(position.z + dz) };
    if (!cells.some(other => other.x === cell.x && other.y === cell.y && other.z === cell.z)) cells.push(cell);
  }
  return cells;
}
function creatureIn(bot: any, cell: Cell): any {
  for (const entity of Object.values(bot.entities ?? {}) as any[]) {
    if (!entity?.position || entity === bot.entity || entity.name === 'item' || entity.name === 'experience_orb' || entity.type === 'projectile') continue;
    const half = (entity.width ?? 0.6) / 2, height = entity.height ?? 1.8;
    if (entity.position.x + half > cell.x && entity.position.x - half < cell.x + 1 && entity.position.z + half > cell.z && entity.position.z - half < cell.z + 1
      && entity.position.y + height > cell.y && entity.position.y < cell.y + 1) return entity;
  }
  return null;
}

export async function place(ctx: StepContext, args: PlaceArgs): Promise<StepOutcome> {
  const bot = ctx.bot;
  const cells = args.at ?? [];
  if (!args.block) return stopped(bot, 'invalid_input', 'place には block（置くブロックの名前）が要る');
  if (!cells.length) return stopped(bot, 'invalid_input', 'place には at（置くマスの列）が要る');
  if (cells.length > MAX_CELLS) return stopped(bot, 'invalid_input', `place は 1 手で ${MAX_CELLS} マスまで`);
  if (!bot.registry?.blocksByName?.[args.block]) return stopped(bot, 'invalid_block', `${args.block} は置けるブロックの名前ではない（種や物は use で）`);
  if (args.against && !DIRECTIONS[args.against]) return stopped(bot, 'invalid_input', `against は ${Object.keys(DIRECTIONS).join('・')} のどれか`);
  const done: string[] = [];
  const result = (outcome: StepOutcome) => ({ ...outcome, text: `${done.length ? `${done.join('、')}。` : ''}${outcome.text}` });
  for (const cell of cells) {
    if (!findItem(bot, args.block)) return result(stopped(bot, 'missing_item', `${args.block} を持っていない（残り0）`, cell));
    const there = blockAt(bot, cell);
    if (!there) return result(stopped(bot, 'unloaded', `${placeText(bot, cell)} は未ロード`, cell));
    if (!REPLACEABLE.has(there.name)) return result(stopped(bot, 'occupied', `${placeText(bot, cell)} は既に ${cellNow(bot, cell)} で置けない`, cell));
    if (bodyCells(bot.entity.position).some(own => own.x === cell.x && own.y === cell.y && own.z === cell.z)) {
      return result(stopped(bot, 'body_in_cell', `${placeText(bot, cell)} は自分の体が入っている（先に動く。真下に置いて上がるなら pillarUp）`, cell));
    }
    const creature = creatureIn(bot, cell);
    if (creature) return result(stopped(bot, 'creature_in_cell', `${placeText(bot, cell)} に ${creature.name} がいて置けない`, cell));
    const order = args.against ? [args.against] : ORDER;
    let reference: any = null, side = '';
    for (const direction of order) {
      const [dx, dy, dz] = DIRECTIONS[direction];
      const neighbour = blockAt(bot, { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz });
      if (neighbour && neighbour.boundingBox === 'block') { reference = neighbour; side = direction; break; }
    }
    if (!reference) {
      return result(stopped(bot, 'nothing_to_set_against', args.against ? `${placeText(bot, cell)} の${DIRECTION_JA[args.against]}側は固いブロックではない（今 ${cellNow(bot, { x: cell.x + DIRECTIONS[args.against][0], y: cell.y + DIRECTIONS[args.against][1], z: cell.z + DIRECTIONS[args.against][2] })}）`
        : `${placeText(bot, cell)} の周り6面に固いブロックが無い（空中には置けない。先に隣へ置く）`, cell));
    }
    const distance = eyeDistance(bot, cell);
    if (distance > USE_REACH + 0.5) return result(stopped(bot, 'out_of_reach', `${placeText(bot, cell)} に届かない（目から${distance.toFixed(1)}m、${USE_REACH}m まで）`, cell));
    if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow); } catch { /* closing */ } await wait(ctx, 100); }
    if (bot.heldItem?.name !== args.block) {
      const held = await guard(ctx, equipToHandVerified(bot, findItem(bot, args.block)), 5000);
      if (!held?.value.held) return result(stopped(bot, 'equip_failed', `${args.block} を手に持てなかった（${held?.value.detail ?? '時間切れ'}）`, cell));
    }
    const [dx, dy, dz] = DIRECTIONS[side];
    const face = new Vec3(-dx, -dy, -dz);
    const countBefore = inventoryCount(bot, args.block);
    try {
      const placed = await guard(ctx, Promise.resolve(bot.placeBlock(reference, face)), 4000);
      if (!placed) throw new Error('timeout');
    } catch (error) {
      if (error instanceof StepStopped || /Action interrupted/u.test(String((error as Error)?.message))) throw error;
      // The library waits for the server's block update; it may come late or the library may miss it: look at the cell itself.
      await wait(ctx, 300);
      if (blockAt(bot, cell)?.name !== args.block) {
        return result(stopped(bot, 'not_placed', `${placeText(bot, cell)} に ${args.block} を置けなかった（${DIRECTION_JA[side]}の ${reference.name} に当てた。今 ${cellNow(bot, cell)}。${String((error as Error)?.message ?? '').slice(0, 60)}）`, cell));
      }
    }
    if (blockAt(bot, cell)?.name !== args.block) {
      await wait(ctx, 300);
      if (blockAt(bot, cell)?.name !== args.block) return result(stopped(bot, 'not_placed', `${placeText(bot, cell)} は置いた後も ${cellNow(bot, cell)}（サーバーが受け付けない）`, cell));
    }
    done.push(`${cellText(cell)} に ${args.block} を置いた（${DIRECTION_JA[side]}の ${reference.name} に当てて。残り${Math.max(0, countBefore - 1)}）`);
    ctx.progress?.(`${done.length}/${cells.length}`);
  }
  return { ok: true, text: done.join('、'), at: cells[cells.length - 1] };
}

export { REPLACEABLE as PLACE_REPLACEABLE, isAirLike };
