/** Continuous body coordinates, rather than an integer route cell. */
export interface FootPosition { x: number; y: number; z: number }
export type FloorNameReader = (x: number, y: number, z: number) => string | null | undefined;

/** The first magma block touched by the body's 0.6 m width (centre first), matching the existing magma reflex. */
export function magmaAtFootprint(read: FloorNameReader, position: FootPosition | null | undefined): FootPosition | null {
  if (!position) return null;
  const y = Math.floor(position.y - 0.01);
  const cx = Math.floor(position.x), cz = Math.floor(position.z);
  if (read(cx, y, cz) === 'magma_block') return { x: cx, y, z: cz };
  for (const [dx, dz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) {
    const x = Math.floor(position.x + dx), z = Math.floor(position.z + dz);
    if (x === cx && z === cz) continue;
    if (read(x, y, z) === 'magma_block') return { x, y, z };
  }
  return null;
}

/** A level diagonal sweeps both corner floors. Cardinal cell-centre steps never touch a parallel neighbouring row. */
export function magmaAcrossStep(read: FloorNameReader, from: FootPosition, to: FootPosition): FootPosition | null {
  // Integer route nodes stand at (x + 0.5, y, z + 0.5), whose whole width is inside this one floor cell.
  if (read(to.x, to.y - 1, to.z) === 'magma_block') return { x: to.x, y: to.y - 1, z: to.z };
  if (from.y !== to.y || Math.abs(to.x - from.x) !== 1 || Math.abs(to.z - from.z) !== 1) return null;
  for (const [x, z] of [[to.x, from.z], [from.x, to.z]]) {
    if (read(x, to.y - 1, z) === 'magma_block') return { x, y: to.y - 1, z };
  }
  return null;
}

/**
 * end1109f18 (fortress lane): the body stood on a magma block's edge with its centre over a one-wide lava source; the walk and go stopped at the
 * first step ("the width is on magma"), the head asked for walks eight times and then jumped into the lava. The words of such a stop name the
 * cell under the centre when it is lava or air, and the hand that fills it.
 */
export function holeUnderCentreWords(read: FloorNameReader, position: FootPosition | null | undefined): string {
  if (!position) return '';
  const x = Math.floor(position.x), y = Math.floor(position.y - 0.01), z = Math.floor(position.z);
  const name = read(x, y, z);
  if (name !== 'lava' && name !== 'air' && name !== 'cave_air') return '';
  const cell = `${x},${y},${z}`;
  return `。体の中心の真下 (${cell}) は${name === 'lava' ? '溶岩' : '空気'}で、マグマの縁に掛かって立っている（跳ぶ・歩くと落ちる）: place cobblestone ${cell} でそのマスを埋めてから歩く`;
}
