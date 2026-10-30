import { Vec3 } from 'vec3';

/** Check nearby footing behind the body in the direction a hit would push. No keys or world changes: the planner chooses how to secure it. */
export function combatFootingRisk(bot: any, enemy: { position?: { x: number; z: number } }): { at: { x: number; y: number; z: number }; kind: string } | null {
  const from = bot.entity?.position, target = enemy.position;
  if (!from || !target || typeof bot.blockAt !== 'function') return null;
  const dx = from.x - target.x, dz = from.z - target.z, length = Math.hypot(dx, dz);
  if (length < 0.01) return null;
  const read = (x: number, y: number, z: number) => {
    try { return bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)), false); } catch { return null; }
  };
  const feetY = Math.floor(from.y + 0.01);
  for (const distance of [0.25, 0.5, 0.75, 1]) {
    const x = from.x + dx / length * distance, z = from.z + dz / length * distance;
    const feet = read(x, feetY, z), head = read(x, feetY + 1, z);
    // A two-high backstop prevents the push, including a critical-hit jump. Do not judge cells behind it.
    if (feet?.boundingBox === 'block' && head?.boundingBox === 'block') return null;
    for (let depth = 0; depth <= 4; depth++) {
      const y = feetY - depth, block = read(x, y, z);
      if (!block) break; // Unknown terrain is not evidence of lava.
      const kind = String(block.name);
      if (/^(?:lava|fire|soul_fire|magma_block)$/u.test(kind)) {
        return { at: { x: Math.floor(x), y, z: Math.floor(z) }, kind };
      }
      if (block.boundingBox === 'block' || /^(?:water|bubble_column)$/u.test(kind)) break;
    }
  }
  return null;
}
