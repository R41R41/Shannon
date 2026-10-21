/**
 * How well the body is armoured, from the four armour slots (5 head, 6 chest, 7 legs, 8 feet of the inventory window).
 *
 * Run 24: a body in a whole set of iron and an iron sword was cut off from its work three times by "flee from the creeper" (13-15 m away, one
 * of them behind a wall), and the dig guard refused every wall the creeper could see through, so a walk of 76 m ran out of time. With
 * 15 armour points a creeper's blast is about 40% of what it is bare, and one that is not lit and not within five blocks is no reason to
 * stop. Points are the game's own (a set of iron is 15, of diamond 20).
 */
const POINTS: Record<string, [number, number, number, number]> = {
  leather: [1, 3, 2, 1], golden: [2, 5, 3, 1], chainmail: [2, 5, 4, 1], iron: [2, 6, 5, 2], diamond: [3, 8, 6, 3], netherite: [3, 8, 6, 3],
};
const PIECES = ['helmet', 'chestplate', 'leggings', 'boots'];

interface ArmourBody { inventory?: { slots?: Array<{ name?: string } | null | undefined> }; health?: number }

/** Armour points worn (0 to 20). */
export function armourPoints(bot: ArmourBody): number {
  const slots = bot.inventory?.slots;
  if (!Array.isArray(slots)) return 0;
  let points = 0;
  for (let index = 0; index < 4; index++) {
    const name = slots[5 + index]?.name ?? '';
    if (index === 0 && name === 'turtle_helmet') { points += 2; continue; }
    const match = /^(leather|golden|chainmail|iron|diamond|netherite)_(helmet|chestplate|leggings|boots)$/u.exec(name);
    if (match && PIECES.indexOf(match[2]) === index) points += POINTS[match[1]][index];
  }
  return points;
}

/** Worn enough to go on working with a creeper that is not lit and not near: 12 points (a whole set of chainmail or better) and 14 health. */
export const WELL_ARMOURED_POINTS = 12;
export const WELL_ARMOURED_HEALTH = 14;
export function wellArmoured(bot: ArmourBody): boolean {
  return armourPoints(bot) >= WELL_ARMOURED_POINTS && (bot.health ?? 20) >= WELL_ARMOURED_HEALTH;
}
