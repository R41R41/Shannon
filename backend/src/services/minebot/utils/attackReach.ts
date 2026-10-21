/**
 * Why a body cannot get a blow at a target, said in words (run 22: "chicken に攻撃できませんでした" after 62 s, and not a line in the journal).
 *
 * The chase of attack-continuously walks at a target with a short route search per round. A target that cannot be walked up to (a ledge
 * out of reach of the walk, a fence round it, water between, no line of sight) used to be chased until the call's whole minute ran out.
 * Here the cause is looked for in the world, so that the chase can be given up early and the result can say what stood in the way.
 */
import { Vec3 } from 'vec3';
import { holdsWater } from './waterBlocks.js';

export type UnreachableKind = 'height' | 'water' | 'fence' | 'sight' | 'path';

export interface Unreachable {
  kind: UnreachableKind;
  /** One clause for the result, with the figures. */
  reason: string;
}

interface ReachBot {
  entity: { position: Vec3 };
  blockAt(position: Vec3, extraInfos?: boolean): { name?: string; boundingBox?: string; isWaterlogged?: boolean; getProperties?: () => Record<string, unknown> } | null;
  world?: { raycast?(from: Vec3, direction: Vec3, range: number): { position?: Vec3 } | null };
}

/** A target above or below the feet by more than this many blocks is out of a walk's reach (a jump is one block, a blow reaches three). */
export const REACH_HEIGHT_M = 2.5;
const FENCE_LIKE = /(^|_)(fence|fence_gate|wall)$|^iron_bars$|glass_pane$/;

const horizontal = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

/** The cells along the straight line from the feet to the target, at the feet's and the head's level, nearest first. */
function lineCells(from: Vec3, to: Vec3): Vec3[] {
  const length = Math.max(1, Math.ceil(from.distanceTo(to)));
  const seen = new Set<string>();
  const cells: Vec3[] = [];
  for (let step = 1; step < length; step++) {
    const t = step / length;
    const x = Math.floor(from.x + (to.x - from.x) * t), z = Math.floor(from.z + (to.z - from.z) * t);
    const y = Math.floor(from.y + (to.y - from.y) * t);
    for (const dy of [0, 1]) {
      const key = `${x},${y + dy},${z}`;
      if (!seen.has(key)) { seen.add(key); cells.push(new Vec3(x, y + dy, z)); }
    }
  }
  return cells;
}

/**
 * The most likely reason a blow cannot land, in the order a person would look: the height, a fence, water, a block in the line of
 * sight; else only that the walk did not get closer. `closedM` is how far the chase got the body nearer in the time it was tried.
 */
export function explainUnreachable(bot: ReachBot, target: { name?: string; position: Vec3; height?: number }, closedM: number, triedSeconds: number): Unreachable {
  const here = bot.entity.position;
  const there = target.position;
  const dy = there.y - here.y;
  const flat = horizontal(here, there);
  const name = target.name ?? '相手';
  const figures = `（${name}まで水平${flat.toFixed(0)}m・高さ${dy >= 0 ? '+' : ''}${dy.toFixed(1)}m）`;

  const cell = (v: Vec3) => { try { return bot.blockAt(v.floored(), false) ?? null; } catch { return null; } };

  // A fence, a wall or a gate round the target or on the way: an animal in a pen cannot be walked up to or struck over the rail.
  const ring = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => cell(there.offset(dx, 0, dz)));
  const fenced = ring.filter(block => block?.name && FENCE_LIKE.test(block.name));
  const onTheWay = lineCells(here, there).map(cell).filter(block => block?.name && FENCE_LIKE.test(block.name));
  const fenceBlock = (onTheWay.length ? onTheWay : fenced.length >= 2 ? fenced : [])[0];
  if (fenceBlock?.name && Math.abs(dy) <= REACH_HEIGHT_M) {
    return { kind: 'fence', reason: `間に${fenceBlock.name}があり、柵ごしには近づけない・届かない${figures}` };
  }

  if (dy > REACH_HEIGHT_M) {
    return { kind: 'height', reason: `相手が${dy.toFixed(1)}m上にいて、歩いては近づけず手も届かない（崖・木の上・段差）${figures}` };
  }
  if (dy < -REACH_HEIGHT_M) {
    return { kind: 'height', reason: `相手が${(-dy).toFixed(1)}m下にいて、手が届かない（穴・谷の底）${figures}` };
  }

  const wet = holdsWater(cell(there)) || holdsWater(cell(there.offset(0, 0.5, 0)));
  if (wet) return { kind: 'water', reason: `相手が水の中にいて、泳ぎながらでは近づけない・届かない${figures}` };
  const wetOnTheWay = lineCells(here, there).filter(c => holdsWater(cell(c))).length;
  if (wetOnTheWay >= 2) return { kind: 'water', reason: `間に水があり、渡れない${figures}` };

  // Close enough for a blow but not seen: a block between the eyes and the body.
  if (flat <= 4) {
    const eyes = here.offset(0, 1.62, 0);
    const aim = there.offset(0, (target.height ?? 1) * 0.5, 0);
    const line = aim.minus(eyes);
    const distance = line.norm();
    try {
      const hit = distance > 0.05 ? bot.world?.raycast?.(eyes, line.scaled(1 / distance), distance) : null;
      const blocker = hit?.position ? cell(hit.position) : null;
      if (hit && blocker?.name) return { kind: 'sight', reason: `すぐ近くにいるが間に${blocker.name}があって見えない・当てられない${figures}` };
    } catch { /* the plain statement stands */ }
  }

  return { kind: 'path', reason: `${triedSeconds.toFixed(0)}秒歩いても${closedM < 1 ? '近づけなかった' : `${closedM.toFixed(0)}mしか近づけなかった`}（経路が見つからない、または遠回りが長すぎる）${figures}` };
}
