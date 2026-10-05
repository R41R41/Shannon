/**
 * Cheap, deliberately conservative ranking proxy for a block whose actual
 * path has not been computed yet.  Vertical travel commonly needs stairs,
 * support blocks or tunnelling, so one vertical metre costs more than one
 * horizontal metre.  This only orders known candidates: it never declares a
 * lower cave unreachable or replaces pathfinder's real route validation.
 */
export function estimateBlockApproachCost(
  from: { x: number; y: number; z: number },
  block: { x: number; y: number; z: number },
  exposed = true,
): number {
  const dx = from.x - (block.x + 0.5);
  const dy = from.y - (block.y + 0.5);
  const dz = from.z - (block.z + 0.5);
  return Math.hypot(dx, dy * 2, dz) + (exposed ? 0 : 8);
}
