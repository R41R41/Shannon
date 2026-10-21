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

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);
/** The longest a place failure's text is let run (the act's line is 160 characters with the closed word and the cell's contents). */
const FAIL_TEXT_ROOM = 128;
const NEARBY_MAX = 3;

/**
 * Where the same block could go instead (run 27: six refusals on her own feet cell, on a rail, in the air, and nothing said what would
 * do): up to NEARBY_MAX air cells within the hand's reach of the eyes, not the body's own, with a solid neighbour to set against, nearest
 * to the asked cell first. "近くの置ける所: (1,64,0) 下の面に, (0,64,1) 西の面に" (the face is the neighbour's side it is set against).
 */
export function nearbyPlaceable(bot: any, asked: Cell, max = NEARBY_MAX): string[] {
  const at = bot.entity?.position;
  if (!at) return [];
  const own = bodyCells(at);
  const eyeY = at.y + 1.62;
  const found: Array<{ text: string; near: number; eye: number }> = [];
  const span = Math.ceil(USE_REACH);
  for (let x = Math.floor(at.x) - span; x <= Math.floor(at.x) + span; x++) {
    for (let y = Math.floor(eyeY) - span; y <= Math.floor(eyeY) + span; y++) {
      for (let z = Math.floor(at.z) - span; z <= Math.floor(at.z) + span; z++) {
        const eye = Math.hypot(at.x - (x + 0.5), eyeY - (y + 0.5), at.z - (z + 0.5));
        if (eye > USE_REACH || (x === asked.x && y === asked.y && z === asked.z) || own.some(cell => cell.x === x && cell.y === y && cell.z === z)) continue;
        const block = blockAt(bot, { x, y, z });
        if (!block || !AIR_NAMES.has(block.name)) continue;
        let face = '';
        for (const direction of ORDER) {
          const [dx, dy, dz] = DIRECTIONS[direction];
          const neighbour = blockAt(bot, { x: x + dx, y: y + dy, z: z + dz });
          if (neighbour && neighbour.boundingBox === 'block') { face = direction; break; }
        }
        if (!face || creatureIn(bot, { x, y, z })) continue;
        // Rounded, so that two cells equally near are told apart by where they are in the scan and not by the last bit of a float.
        found.push({ text: `${cellText({ x, y, z })} ${DIRECTION_JA[face]}の面に`, eye: Math.round(eye * 1000),
          near: Math.round(Math.hypot(x - asked.x, y - asked.y, z - asked.z) * 1000) });
      }
    }
  }
  return found.sort((a, b) => a.near - b.near || a.eye - b.eye).slice(0, max).map(entry => entry.text);
}

/** `text` with the nearby cells added while the whole fits `room` characters (none, when there is no room or no cell). */
function withNearby(bot: any, cell: Cell, text: string, room: number): string {
  let out = text;
  try {
    const listed: string[] = [];
    for (const entry of nearbyPlaceable(bot, cell)) {
      const next = `${text}。近くの置ける所: ${[...listed, entry].join(', ')}`;
      if (next.length > room) break;
      listed.push(entry); out = next;
    }
  } catch { /* the line stands without it */ }
  return out;
}

/** Which of the body's cells a cell is, in plain words (the feet's, the head's, or one between). */
function ownCellWord(bot: any, cell: Cell): string {
  const at = bot.entity.position;
  if (cell.y === Math.floor(at.y)) return '自分の足のマス';
  if (cell.y === Math.floor(at.y + 1.79)) return '自分の頭のマス';
  return '自分の体のマス';
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
    // What the line may run to: the act's line is clipped, and the cells done before this one are in front of it.
    const room = FAIL_TEXT_ROOM - (done.length ? done.join('、').length + 1 : 0);
    if (!REPLACEABLE.has(there.name)) {
      return result(stopped(bot, 'occupied', withNearby(bot, cell, `${placeText(bot, cell)} は埋まっている（そのマスは ${cellNow(bot, cell)}）`, room), cell));
    }
    if (bodyCells(bot.entity.position).some(own => own.x === cell.x && own.y === cell.y && own.z === cell.z)) {
      return result(stopped(bot, 'body_in_cell', withNearby(bot, cell, `${placeText(bot, cell)} は${ownCellWord(bot, cell)}（先に動く。真下に置いて上がるなら pillarUp）`, room), cell));
    }
    const creature = creatureIn(bot, cell);
    if (creature) return result(stopped(bot, 'creature_in_cell', withNearby(bot, cell, `${placeText(bot, cell)} に ${creature.name} がいて置けない`, room), cell));
    const order = args.against ? [args.against] : ORDER;
    let reference: any = null, side = '';
    for (const direction of order) {
      const [dx, dy, dz] = DIRECTIONS[direction];
      const neighbour = blockAt(bot, { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz });
      if (neighbour && neighbour.boundingBox === 'block') { reference = neighbour; side = direction; break; }
    }
    if (!reference) {
      let allAir = true;
      for (const [dx, dy, dz] of Object.values(DIRECTIONS)) if (!AIR_NAMES.has(String(blockAt(bot, { x: cell.x + dx, y: cell.y + dy, z: cell.z + dz })?.name))) allAir = false;
      const why = args.against ? `${placeText(bot, cell)} の${DIRECTION_JA[args.against]}側は固いブロックではない（今 ${cellNow(bot, { x: cell.x + DIRECTIONS[args.against][0], y: cell.y + DIRECTIONS[args.against][1], z: cell.z + DIRECTIONS[args.against][2] })}）`
        : `${placeText(bot, cell)} は支えになる面が無い（${allAir ? '6面とも空気' : '6面とも固いブロックではない'}）`;
      return result(stopped(bot, 'nothing_to_set_against', withNearby(bot, cell, why, room), cell));
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
