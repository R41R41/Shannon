import { bodyBoxAt, boxesOverlap, inflate, isPerched, partBox, shift, type DragonPart, type P3 } from './dragonParts.js';
import { cloudReaches } from './dragonDanger.js';
type Pose = { id?: number; position: P3; yaw: number; phase: number | null };
type Cloud = { id?: number; position: P3; radius: number | null };

export function knockGeometry(feet: P3, dragon: Pose | null, clouds: readonly Cloud[] = []) {
  const bodyBox = bodyBoxAt(feet);
  const parts = dragon ? (['head', 'neck', 'body', 'wing1', 'wing2'] as DragonPart[]).map(part => {
    const box = partBox(dragon, part), contactBox = inflate(box, 1.1);
    const pushBox = part.startsWith('wing') ? shift(inflate(box, 4, 2, 4), 0, -2, 0) : null;
    return { part, box, contactBox, overlaps: boxesOverlap(bodyBox, box), contactOverlap: boxesOverlap(bodyBox, contactBox),
      pushBox, pushOverlap: pushBox !== null && boxesOverlap(bodyBox, pushBox) };
  }) : [];
  return { bodyBox, parts, partModel: !dragon ? 'unavailable' : isPerched(dragon.phase) ? 'perched_partBox_estimate' : 'flight_partBox_estimate',
    dragonBreath: clouds.map(c => ({ ...c, position: { ...c.position }, overlap: cloudReaches(c.position, c.radius ?? 0, feet) })) };
}
