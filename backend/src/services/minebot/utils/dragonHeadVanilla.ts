import type { Box, P3 } from './dragonParts.js';

export interface DragonHeadVanillaInput {
  position: Readonly<P3>;
  /** Mineflayer radians: r = PI - theta, theta = vanilla yRot * PI / 180. */
  yaw: number;
  /** Vanilla accumulator (added to yRot in DEGREES during scanning).
   * The part formula multiplies this numeric value by 0.01 RADIANS, not degrees.
   * It is not in a packet. Undefined explicitly selects the unknown-as-zero model. */
  yRotA?: number;
  /** Neck slope in radians: (H5.y - H10.y) * 10 * PI / 180. Not entity.pitch. */
  p: number;
  /** Sitting: -1; otherwise H5.y - H0.y. The caller supplies history/phase policy. */
  hy: number;
}

/** EnderDragon.java:273,295-299,356-362 (1.21.11, sources @6c4ae19).
 * Pure placement only: no packet/time inference, history, AI, or runtime wiring.
 * r' = r + 0.01*yRotA; vanilla psi = theta - 0.01*yRotA = PI - r'.
 * JS double sin/cos approximate vanilla's float lookup table, not bit-exact Java FP.
 */
export function dragonHeadVanilla(input: DragonHeadVanillaInput): {
  feet: P3; box: Box; yaw: number; yRotA: number; rotationAssumedZero: boolean;
} | null {
  const { position, yaw, p, hy } = input, yRotA = input.yRotA ?? 0;
  if (![position.x, position.y, position.z, yaw, p, hy, yRotA].every(Number.isFinite)) return null;
  const headYaw = yaw + 0.01 * yRotA, length = 6.5 * Math.cos(p);
  const feet = {
    x: position.x + Math.sin(headYaw) * length,
    y: position.y + hy + 6.5 * Math.sin(p),
    z: position.z + Math.cos(headYaw) * length,
  };
  return { feet, box: { minX: feet.x - 0.5, minY: feet.y, minZ: feet.z - 0.5,
    maxX: feet.x + 0.5, maxY: feet.y + 1, maxZ: feet.z + 0.5 },
  yaw: headYaw, yRotA, rotationAssumedZero: input.yRotA === undefined };
}
