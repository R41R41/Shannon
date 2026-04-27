import { Vec3 } from 'vec3';
import type { CustomBot } from '../types.js';

export const FOUNTAIN_CENTER_X = 0;
export const FOUNTAIN_CENTER_Z = 0;

export const DRAGON_PHASE_CIRCLING = 0;
export const DRAGON_PHASE_STRAFING = 1;
export const DRAGON_PHASE_FLYING_TO_PORTAL = 2;
export const DRAGON_PHASE_LANDING = 3;
export const DRAGON_PHASE_SITTING = 4;
export const DRAGON_PHASE_ROARING = 5;

export const HEAD_OFFSET_BLOCKS = 4;
export const HEAD_BLAST_RANGE = 4.5;
export const PERCH_HORIZONTAL_THRESHOLD = 20;
export const PERCH_VERTICAL_OFFSET = 30;

export const REPLACEABLE_BLOCKS = new Set([
  'air', 'cave_air', 'void_air', 'fire', 'soul_fire',
  'tall_grass', 'short_grass', 'grass', 'snow',
]);

export const DRAGON_PHASE_NAMES: Record<number, string> = {
  [DRAGON_PHASE_CIRCLING]: 'circling',
  [DRAGON_PHASE_STRAFING]: 'strafing',
  [DRAGON_PHASE_FLYING_TO_PORTAL]: 'flying_to_portal',
  [DRAGON_PHASE_LANDING]: 'landing',
  [DRAGON_PHASE_SITTING]: 'sitting',
  [DRAGON_PHASE_ROARING]: 'roaring',
};

export function findDragon(bot: CustomBot): any | null {
  return bot.nearestEntity(e => e.name === 'ender_dragon');
}

export function getDragonPhase(dragon: any): number | null {
  if (!dragon.metadata) return null;
  const phase = dragon.metadata[16];
  if (typeof phase === 'number') return phase;
  return null;
}

export function getDragonPhaseName(dragon: any): string {
  const phase = getDragonPhase(dragon);
  if (phase === null) return 'unknown';
  return DRAGON_PHASE_NAMES[phase] ?? `unknown(${phase})`;
}

export function isDragonFlying(dragon: any, fountainTopY: number): boolean {
  const phase = getDragonPhase(dragon);
  if (phase !== null) {
    return phase === DRAGON_PHASE_CIRCLING || phase === DRAGON_PHASE_STRAFING;
  }
  const dx = Math.abs(dragon.position.x - FOUNTAIN_CENTER_X);
  const dz = Math.abs(dragon.position.z - FOUNTAIN_CENTER_Z);
  const hDist = Math.sqrt(dx * dx + dz * dz);
  return hDist > PERCH_HORIZONTAL_THRESHOLD || dragon.position.y > fountainTopY + PERCH_VERTICAL_OFFSET;
}

export function isDragonApproaching(dragon: any, fountainTopY: number): boolean {
  const phase = getDragonPhase(dragon);
  if (phase !== null) {
    return phase === DRAGON_PHASE_FLYING_TO_PORTAL;
  }
  const dx = Math.abs(dragon.position.x - FOUNTAIN_CENTER_X);
  const dz = Math.abs(dragon.position.z - FOUNTAIN_CENTER_Z);
  const hDist = Math.sqrt(dx * dx + dz * dz);
  return hDist < PERCH_HORIZONTAL_THRESHOLD
    && dragon.position.y > fountainTopY + 3
    && dragon.position.y < fountainTopY + PERCH_VERTICAL_OFFSET;
}

export function isDragonPerched(dragon: any): boolean {
  const phase = getDragonPhase(dragon);
  return phase === DRAGON_PHASE_SITTING || phase === DRAGON_PHASE_ROARING;
}

export function isDragonInPerchSequence(dragon: any, fountainTopY: number): boolean {
  const phase = getDragonPhase(dragon);
  if (phase !== null) {
    return phase >= DRAGON_PHASE_FLYING_TO_PORTAL && phase <= DRAGON_PHASE_ROARING;
  }
  const dx = Math.abs(dragon.position.x - FOUNTAIN_CENTER_X);
  const dz = Math.abs(dragon.position.z - FOUNTAIN_CENTER_Z);
  const hDist = Math.sqrt(dx * dx + dz * dz);
  return hDist < PERCH_HORIZONTAL_THRESHOLD && dragon.position.y < fountainTopY + PERCH_VERTICAL_OFFSET;
}

export function estimateHeadPosition(bot: CustomBot, dragon: any, fountainTopY: number): Vec3 {
  for (const entity of Object.values(bot.entities) as any[]) {
    if (!entity || !entity.position) continue;
    const name = (entity.name || '').toLowerCase();
    if (name.includes('dragon') && name.includes('head')) {
      return entity.position.clone();
    }
    if (entity.entityType !== undefined && entity.name === 'ender_dragon' && entity !== dragon) {
      const dist = entity.position.distanceTo(dragon.position);
      if (dist < 8 && dist > 1) return entity.position.clone();
    }
  }
  const yaw = dragon.yaw ?? 0;
  const headX = dragon.position.x - Math.sin(yaw) * HEAD_OFFSET_BLOCKS;
  const headZ = dragon.position.z + Math.cos(yaw) * HEAD_OFFSET_BLOCKS;
  const headY = Math.min(dragon.position.y, fountainTopY + 3);
  return new Vec3(headX, headY, headZ);
}

export function getDragonTailSafePos(dragon: any, botY: number): Vec3 {
  const yaw = dragon.yaw ?? 0;
  const tailDirX = Math.sin(yaw);
  const tailDirZ = -Math.cos(yaw);
  const dist = 3;
  return new Vec3(
    FOUNTAIN_CENTER_X + tailDirX * dist,
    botY,
    FOUNTAIN_CENTER_Z + tailDirZ * dist,
  );
}

export function findFountainTop(bot: CustomBot): number {
  for (let y = 75; y >= 50; y--) {
    const block = bot.blockAt(new Vec3(FOUNTAIN_CENTER_X, y, FOUNTAIN_CENTER_Z));
    if (block && block.name === 'bedrock') {
      let topY = y;
      for (let checkY = y + 1; checkY <= y + 10; checkY++) {
        const above = bot.blockAt(new Vec3(FOUNTAIN_CENTER_X, checkY, FOUNTAIN_CENTER_Z));
        if (above && above.name === 'bedrock') topY = checkY;
        else break;
      }
      return topY;
    }
  }
  for (let y = 76; y <= 100; y++) {
    const block = bot.blockAt(new Vec3(FOUNTAIN_CENTER_X, y, FOUNTAIN_CENTER_Z));
    if (block && block.name === 'bedrock') {
      let topY = y;
      for (let checkY = y + 1; checkY <= y + 10; checkY++) {
        const above = bot.blockAt(new Vec3(FOUNTAIN_CENTER_X, checkY, FOUNTAIN_CENTER_Z));
        if (above && above.name === 'bedrock') topY = checkY;
        else break;
      }
      return topY;
    }
  }
  return 0;
}

export function countBeds(bot: CustomBot): number {
  return bot.inventory.items()
    .filter(i => i.name.includes('bed') && !i.name.includes('bedrock'))
    .reduce((sum, i) => sum + i.count, 0);
}

export function findBedItem(bot: CustomBot): any | null {
  return bot.inventory.items().find(
    i => i.name.includes('bed') && !i.name.includes('bedrock'),
  ) || null;
}

export async function equipDigTool(bot: CustomBot): Promise<void> {
  const pickaxe = bot.inventory.items().find(i => i.name.includes('pickaxe'));
  if (pickaxe) {
    try { await bot.equip(pickaxe, 'hand'); } catch { /* ignore */ }
  } else {
    try { await bot.unequip('hand'); } catch { /* ignore */ }
  }
}

export async function digUntilGone(bot: CustomBot, pos: Vec3, maxAttempts = 3): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const block = bot.blockAt(pos);
    if (!block || !REPLACEABLE_BLOCKS.has(block.name)) return true;
    if (block.name === 'air' || block.name === 'cave_air' || block.name === 'void_air') return true;
    try {
      await equipDigTool(bot);
      await bot.dig(block);
      await new Promise(r => setTimeout(r, 100));
    } catch { /* ignore */ }
    const after = bot.blockAt(pos);
    if (!after || after.name === 'air' || after.name === 'cave_air' || after.name === 'void_air') return true;
  }
  return false;
}
