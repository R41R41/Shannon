/**
 * 敵対 Mob 名のヒント（部分一致）。CombatEventHandler / 距離判定で共有する。
 * リストを変える場合は CombatEventHandler と整合させること。
 */
export const HOSTILE_MOB_NAME_HINTS: readonly string[] = [
  'zombie',
  'skeleton',
  'creeper',
  'spider',
  'enderman',
  'witch',
  'phantom',
  'drowned',
  'husk',
  'stray',
  'blaze',
  'ghast',
  'magma_cube',
  'slime',
  'pillager',
  'vindicator',
  'evoker',
  'warden',
  'piglin_brute',
  'hoglin',
  'zoglin',
] as const;

export function isLikelyHostileMobName(mobName: string): boolean {
  const n = mobName.toLowerCase();
  return HOSTILE_MOB_NAME_HINTS.some((h) => n.includes(h));
}
