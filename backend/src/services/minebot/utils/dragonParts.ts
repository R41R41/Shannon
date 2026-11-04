/**
 * The ender dragon as the client can know it (the End fight, 2026-11-02 sprint).
 *
 * Mineflayer holds one entity for the dragon, its body. The server hits and hurts it through eight parts of its own (head, neck, body,
 * three tail pieces, two wings) whose ids follow the body's: head = id + 1, neck + 2, body + 3, tail + 4..6, wings + 7 and + 8, and the
 * server takes an attack on any of them (1.21.x). A part sits at the body's position plus an offset along the body's yaw; the head is
 * 6.5 blocks out and one below the body's feet. A blow at the head does the sword's whole damage, at any other part a quarter and a block.
 * Only the SITTING phases (5 flaming, 6 scanning, 7 attacking: the dragon perched on the exit portal's pillar) hold the offsets still
 * enough to aim by; in flight they are an estimate.
 *
 * The part ids, the head's offset and the phase numbers were learned from mine-ai-mcp (MIT, https://github.com/aibengineering/mine-ai-mcp,
 * the work of aibengineering), and written again here for Shannon's own contracts (this file holds no code of theirs).
 */

/** The dragon's phases (`EnderDragonPhase` ids, the entity's `phase` metadata). */
export const DRAGON_PHASE = {
  holdingPattern: 0, strafePlayer: 1, landingApproach: 2, landing: 3, takeoff: 4, sittingFlaming: 5, sittingScanning: 6, sittingAttacking: 7,
  chargingPlayer: 8, dying: 9, hovering: 10,
} as const;
export const PHASE_NAMES: readonly string[] = ['holding_pattern', 'strafe_player', 'landing_approach', 'landing', 'takeoff', 'sitting_flaming',
  'sitting_scanning', 'sitting_attacking', 'charging_player', 'dying', 'hovering'];
export const DRAGON_MAX_HEALTH = 200;
/** A cloud of the dragon's breath is at least this wide in radius for the body: the client's number is a tick old and the cloud grows from 3 to 7. */
export const BREATH_RADIUS_MIN = 7;

export const phaseName = (phase: number | null | undefined): string | null => typeof phase === 'number' ? PHASE_NAMES[phase] ?? null : null;
/** On the perch: flaming (5), scanning (6) or attacking (7). A blow can be struck, an arrow does nothing. */
export const isPerched = (phase: number | null | undefined): boolean => phase === 5 || phase === 6 || phase === 7;
/** Coming down (2 approach, 3 landing): the perch is near, the parts still move. */
export const isLanding = (phase: number | null | undefined): boolean => phase === 2 || phase === 3;
export const isDying = (phase: number | null | undefined): boolean => phase === 9;

export type DragonPart = 'head' | 'neck' | 'body' | 'wing1' | 'wing2';
/** The part's id minus the body's. */
export const PART_ID_OFFSET: Readonly<Record<DragonPart, number>> = { head: 1, neck: 2, body: 3, wing1: 7, wing2: 8 };
/** The parts to try for a blow, the head (whole damage) first. */
export const STRIKE_ORDER: readonly DragonPart[] = ['head', 'neck', 'body', 'wing1', 'wing2'];
const SIZE: Readonly<Record<DragonPart, { w: number; h: number }>> = {
  head: { w: 1, h: 1 }, neck: { w: 3, h: 3 }, body: { w: 5, h: 3 }, wing1: { w: 4, h: 2 }, wing2: { w: 4, h: 2 },
};

export interface P3 { x: number; y: number; z: number }
export interface Box { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }

/** The part's offset from the body's position, for the body's (mineflayer) yaw; the server's own tick positions the parts the same way. */
export function partOffset(part: DragonPart, yaw: number): P3 {
  const s = Math.sin(yaw), c = Math.cos(yaw);
  switch (part) {
    case 'head': return { x: 6.5 * s, y: -1, z: 6.5 * c };
    case 'neck': return { x: 5.5 * s, y: -1, z: 5.5 * c };
    case 'body': return { x: 0.5 * s, y: 0, z: 0.5 * c };
    case 'wing1': return { x: -4.5 * c, y: 2, z: 4.5 * s };
    case 'wing2': return { x: 4.5 * c, y: 2, z: -4.5 * s };
  }
}

/** A part's box: centred over its position on x and z, standing on it on y (the server's entity boxes). */
export function partBox(dragon: { position: P3; yaw?: number }, part: DragonPart): Box {
  const o = partOffset(part, dragon.yaw ?? 0), size = SIZE[part];
  const x = dragon.position.x + o.x, y = dragon.position.y + o.y, z = dragon.position.z + o.z;
  return { minX: x - size.w / 2, minY: y, minZ: z - size.w / 2, maxX: x + size.w / 2, maxY: y + size.h, maxZ: z + size.w / 2 };
}
export const boxCentre = (box: Box): P3 => ({ x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2, z: (box.minZ + box.maxZ) / 2 });
export function inflate(box: Box, dx: number, dy = dx, dz = dx): Box {
  return { minX: box.minX - dx, minY: box.minY - dy, minZ: box.minZ - dz, maxX: box.maxX + dx, maxY: box.maxY + dy, maxZ: box.maxZ + dz };
}
export const shift = (box: Box, dx: number, dy: number, dz: number): Box =>
  ({ minX: box.minX + dx, minY: box.minY + dy, minZ: box.minZ + dz, maxX: box.maxX + dx, maxY: box.maxY + dy, maxZ: box.maxZ + dz });
/** The distance from a point to the nearest point of a box (0 inside): what the server's reach check measures from the eye. */
export function boxDistance(point: P3, box: Box): number {
  const dx = Math.max(box.minX - point.x, 0, point.x - box.maxX), dy = Math.max(box.minY - point.y, 0, point.y - box.maxY), dz = Math.max(box.minZ - point.z, 0, point.z - box.maxZ);
  return Math.hypot(dx, dy, dz);
}
export const boxesOverlap = (a: Box, b: Box): boolean =>
  a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY && a.minZ < b.maxZ && a.maxZ > b.minZ;
/** The body's own box at a feet position (a player: 0.6 wide, 1.8 tall). */
export const bodyBoxAt = (feet: P3): Box => ({ minX: feet.x - 0.3, minY: feet.y, minZ: feet.z - 0.3, maxX: feet.x + 0.3, maxY: feet.y + 1.8, maxZ: feet.z + 0.3 });

/** What a blow at the id `dragonId + offset` is: the object `bot.attack` takes (only the id is sent), with where the part is for the caller's reading. */
export function partTarget(dragon: { id: number; position: P3; yaw?: number }, part: DragonPart): { id: number; name: string; dragonPart: DragonPart; dragonId: number; position: P3 } {
  const centre = boxCentre(partBox(dragon, part));
  return { id: dragon.id + PART_ID_OFFSET[part], name: 'ender_dragon_part', dragonPart: part, dragonId: dragon.id, position: centre };
}

/** The server's damage rule for a part (EnderDragon.hurt): the head takes it whole, any other part a quarter and (at most) one more. */
export const partDamage = (part: DragonPart, damage: number): number => part === 'head' ? damage : damage / 4 + Math.min(damage, 1);

/** The cloud the dragon breathes on the perch (phase 5, ten ticks in): 2.5 blocks out from the head along the body's line, on the ground. */
export function flameCloudCentre(dragon: { position: P3; yaw?: number }): P3 {
  const head = boxCentre(partBox(dragon, 'head'));
  const dx = head.x - dragon.position.x, dz = head.z - dragon.position.z, length = Math.hypot(dx, dz) || 1;
  return { x: head.x + dx / length * 2.5, y: head.y, z: head.z + dz / length * 2.5 };
}
