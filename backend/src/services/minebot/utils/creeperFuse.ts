/**
 * A creeper is not fought hand to hand: closing in is what lights it. Run 17 called `combat` on one 6 m away, was cut off, and the
 * next one went off at 3 m from full health. Said by the melee skills when a creeper is asked for by name (a group such as
 * "hostile" leaves creepers out instead). Null when no creeper is named.
 */
export function creeperMeleeRefusal(names: string[]): { success: false; failureType: 'creeper_melee'; recoverable: true; result: string } | null {
  if (!names.some(name => name.trim().toLowerCase() === 'creeper')) return null;
  return { success: false, failureType: 'creeper_melee', recoverable: true,
    result: 'クリーパーとは近くで戦いません（近づくと点火し、3m で爆発する）。flee-from creeper で 8m 以上離れるか、矢があれば shoot-bow で遠くから射る。'
      + '通り道にいるなら、回り道するか、離れて去るのを待つ' };
}

/** Minecraft 1.21 creeper metadata: index 16 is the fuse state (1 while swelling), index 18 is lit by flint and steel. */
export function creeperLit(entity: { metadata?: unknown[] }): boolean {
  const meta = Array.isArray(entity.metadata) ? entity.metadata : [];
  return meta[16] === 1 || meta[18] === true;
}
