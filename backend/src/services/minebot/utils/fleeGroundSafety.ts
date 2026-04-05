/**
 * 逃走方向の足元安全性（崖・急落）を判定し、危険なら別方向を選ぶ。
 * EventReactionSystem の斥力ベクトル逃走は pathfinder を使わないため、ここで落下を抑止する。
 */

import { Vec3 } from 'vec3';
import type { CustomBot } from '../types/CustomBot.js';

const HAZARD_STAND = new Set([
  'lava',
  'fire',
  'sweet_berry_bush',
  'cactus',
  'wither_rose',
  'powder_snow',
  'magma_block',
]);

/** この高さ差（ブロック相当）より先が急に低ければ「崖」とみなす */
const MAX_SAFE_DROP_BLOCKS = 1.05;

/** 前方サンプル距離（ブロック） */
const FORWARD_SAMPLE = 1.05;

const YAW_CANDIDATE_OFFSETS = [
  0,
  Math.PI / 4,
  -Math.PI / 4,
  Math.PI / 2,
  -Math.PI / 2,
  (3 * Math.PI) / 4,
  -(3 * Math.PI) / 4,
];

function xzDeltaFromYaw(yaw: number, dist: number): { dx: number; dz: number } {
  return { dx: -Math.sin(yaw) * dist, dz: Math.cos(yaw) * dist };
}

function normalizeYaw(y: number): number {
  const twoPi = Math.PI * 2;
  let n = y;
  while (n > Math.PI) n -= twoPi;
  while (n < -Math.PI) n += twoPi;
  return n;
}

/**
 * 指定列 (bx,bz) で、現在高度付近から下方向に「足を載せられる上面の Y」（足元のワールドY）を返す。
 */
function supportFeetY(bot: CustomBot, bx: number, bz: number, referenceY: number): number | null {
  const start = Math.min(Math.floor(referenceY) + 2, 320);
  const bottom = Math.floor(referenceY) - 40;

  for (let y = start; y >= bottom; y--) {
    const b = bot.blockAt(new Vec3(bx, y, bz));
    if (!b) continue;
    if (b.name === 'water' || b.name === 'lava' || b.name === 'bubble_column') {
      return null;
    }
    if (HAZARD_STAND.has(b.name)) {
      return null;
    }
    if (b.boundingBox === 'empty') continue;

    const feetY = y + 1;
    const above = bot.blockAt(new Vec3(bx, y + 1, bz));
    const above2 = bot.blockAt(new Vec3(bx, y + 2, bz));
    if (!above || !above2) {
      return feetY;
    }
    if (above.boundingBox === 'block' && above.name !== 'water' && above.name !== 'snow') {
      continue;
    }
    if (above.name === 'water' || above.name === 'lava') {
      return null;
    }
    if (above2.boundingBox === 'block' && above2.name !== 'water' && above2.name !== 'snow') {
      continue;
    }
    return feetY;
  }
  return null;
}

/**
 * 現在の yaw 方向に FORWARD_SAMPLE 進んだ位置の着地が、現在地より MAX_SAFE_DROP_BLOCKS 以上低ければ false。
 */
export function isForwardGroundSafe(bot: CustomBot, yaw: number): boolean {
  if (!bot.entity) return true;
  const pos = bot.entity.position;
  const { dx, dz } = xzDeltaFromYaw(yaw, FORWARD_SAMPLE);
  const bx = Math.floor(pos.x + dx);
  const bz = Math.floor(pos.z + dz);
  const curBx = Math.floor(pos.x);
  const curBz = Math.floor(pos.z);

  const curFeet = supportFeetY(bot, curBx, curBz, pos.y) ?? pos.y;
  const fwdFeet = supportFeetY(bot, bx, bz, pos.y);
  if (fwdFeet === null) {
    return false;
  }
  const drop = curFeet - fwdFeet;
  if (drop > MAX_SAFE_DROP_BLOCKS) {
    return false;
  }
  return true;
}

/**
 * 斥力で求めた向きを優先し、崖でない最初の水平方向の yaw を返す。見つからなければ元の yaw。
 */
export function pickSaferFleeYaw(bot: CustomBot, preferredYaw: number): number {
  if (!bot.entity) return preferredYaw;

  for (const off of YAW_CANDIDATE_OFFSETS) {
    const y = normalizeYaw(preferredYaw + off);
    if (isForwardGroundSafe(bot, y)) {
      return y;
    }
  }
  return preferredYaw;
}
