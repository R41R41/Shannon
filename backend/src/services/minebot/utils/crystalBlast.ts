import { bodyReader, type BlockReader } from './localMap.js';
import type { P3 } from './dragonParts.js';

/**
 * What an end crystal's blast would do to the body where it stands, by the game's own rule (Explosion.explode, power 6: it reaches 12 blocks;
 * an entity at distance d with a fraction `seen` of its box in the blast's sight takes ((i² + i) / 2) * 7 * 12 + 1 with i = (1 - d / 12) * seen,
 * as a whole number; then the difficulty, then the armour). An estimate: enchantments, the shield, resistance and absorption are not counted,
 * and a ray through iron bars is counted as passing (a bar is a thin post). So a blast is judged worse, not better, than it will be.
 */
export const CRYSTAL_POWER = 6;
export const CRYSTAL_REACH = CRYSTAL_POWER * 2;
/** An arrow is shot from at least this far (the blast reaches 12). */
export const CRYSTAL_SAFE_SHOT = 13;
/** A blow is struck only when the estimate leaves the body this much health. */
export const BLAST_MARGIN = 4;

const ARMOR: Record<string, { head: number; chest: number; legs: number; feet: number; toughness: number }> = {
  leather: { head: 1, chest: 3, legs: 2, feet: 1, toughness: 0 }, golden: { head: 2, chest: 5, legs: 3, feet: 1, toughness: 0 },
  chainmail: { head: 2, chest: 5, legs: 4, feet: 1, toughness: 0 }, iron: { head: 2, chest: 6, legs: 5, feet: 2, toughness: 0 },
  diamond: { head: 3, chest: 8, legs: 6, feet: 3, toughness: 2 }, netherite: { head: 3, chest: 8, legs: 6, feet: 3, toughness: 3 },
  turtle: { head: 2, chest: 0, legs: 0, feet: 0, toughness: 0 },
};
/** The armour points and toughness of what is worn (the head, chest, legs and feet slots 5 to 8). */
export function armorOf(bot: any): { points: number; toughness: number } {
  let points = 0, toughness = 0;
  const slots: Array<[number, 'head' | 'chest' | 'legs' | 'feet']> = [[5, 'head'], [6, 'chest'], [7, 'legs'], [8, 'feet']];
  for (const [slot, part] of slots) {
    const name = String(bot?.inventory?.slots?.[slot]?.name ?? '');
    const material = Object.keys(ARMOR).find(key => name.startsWith(`${key}_`));
    if (!material) continue;
    points += ARMOR[material][part]; toughness += ARMOR[material].toughness;
  }
  return { points, toughness };
}

/** The damage after armour (CombatRules.getDamageAfterAbsorb). */
export function afterArmor(damage: number, points: number, toughness: number): number {
  const f = 2 + toughness / 4;
  const reduction = Math.min(20, Math.max(points - damage / f, points * 0.2));
  return damage * (1 - reduction / 25);
}
export function afterDifficulty(damage: number, difficulty: string | undefined): number {
  switch (String(difficulty ?? 'normal')) {
    case 'peaceful': return 0;
    case 'easy': return Math.min(damage / 2 + 1, damage);
    case 'hard': return damage * 1.5;
    default: return damage;
  }
}
/** The blast's raw damage at `distance` for the fraction of the body that is in its sight. */
export function blastRaw(distance: number, seen: number, power = CRYSTAL_POWER): number {
  const reach = power * 2;
  if (distance >= reach || seen <= 0) return 0;
  const impact = (1 - distance / reach) * seen;
  return Math.floor((impact * impact + impact) / 2 * 7 * reach + 1);
}

/** The fraction of nine points in the body's box that a straight line from the blast's centre reaches (iron bars are passed). */
export function seenFraction(read: BlockReader, centre: P3, feet: P3, ignore: P3[] = []): number {
  let seen = 0, total = 0;
  // The cell the blast is centred in is never in its way (a bed is gone when it blows), nor are the cells given.
  const skip = new Set([centre, ...ignore].map(cell => `${Math.floor(cell.x)},${Math.floor(cell.y)},${Math.floor(cell.z)}`));
  for (const h of [0.15, 0.9, 1.65]) for (const [dx, dz] of [[0, 0], [0.22, 0.22], [-0.22, -0.22]] as const) {
    total++;
    const to = { x: feet.x + dx, y: feet.y + h, z: feet.z + dz };
    const length = Math.hypot(to.x - centre.x, to.y - centre.y, to.z - centre.z), steps = Math.max(1, Math.ceil(length / 0.25));
    let blocked = false;
    for (let i = 1; i < steps && !blocked; i++) {
      const t = i / steps;
      const bx = Math.floor(centre.x + (to.x - centre.x) * t), by = Math.floor(centre.y + (to.y - centre.y) * t), bz = Math.floor(centre.z + (to.z - centre.z) * t);
      if (skip.has(`${bx},${by},${bz}`)) continue;
      const block = read(bx, by, bz);
      if (!block) continue;
      if (block.solid === true && block.name !== 'iron_bars') blocked = true;
    }
    if (!blocked) seen++;
  }
  return seen / total;
}

export interface BlastEstimate { distance: number; seen: number; raw: number; expected: number; armor: number; health: number; safe: boolean }
/** What a blast of `power` (a crystal's 6, a bed's 5) at `centre` would take from the body at `feet` (the body's own place by default), and whether the body can take it. */
export function blastAt(bot: any, centre: P3, feet: P3 = bot.entity.position, power = CRYSTAL_POWER, ignore: P3[] = []): BlastEstimate {
  const distance = Math.hypot(feet.x - centre.x, feet.y - centre.y, feet.z - centre.z);
  const seen = distance >= power * 2 ? 0 : seenFraction(bodyReader(bot), centre, feet, ignore);
  const raw = blastRaw(distance, seen, power);
  const { points, toughness } = armorOf(bot);
  const expected = raw === 0 ? 0 : Math.round(afterArmor(afterDifficulty(raw, bot?.game?.difficulty), points, toughness) * 10) / 10;
  const health = Number(bot?.health ?? 20);
  return { distance: Math.round(distance * 10) / 10, seen: Math.round(seen * 100) / 100, raw, expected, armor: points, health, safe: expected + BLAST_MARGIN < health };
}
