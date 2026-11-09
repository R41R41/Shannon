import { boxCentre, partBox, type P3 } from './dragonParts.js';
const finitePoint = (p: P3 | undefined): p is P3 => !!p && [p.x, p.y, p.z].every(Number.isFinite);

export function seatedDragonHead(dragon: { position: P3; yaw: number; phase: number | null }) {
  if ((dragon.phase !== 7 && dragon.phase !== 5) || !finitePoint(dragon.position) || !Number.isFinite(dragon.yaw)) return null;
  const box = partBox(dragon, 'head'), centre = boxCentre(box);
  return { box, centre, feet: { ...centre, y: box.minY },
    cloud: { x: centre.x + Math.sin(dragon.yaw) * 2.5, y: centre.y, z: centre.z + Math.cos(dragon.yaw) * 2.5 },
    source: 'seated_body_position_yaw' as const };
}
