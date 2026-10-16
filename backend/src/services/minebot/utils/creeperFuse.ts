/** Minecraft 1.21 creeper metadata: index 16 is the fuse state (1 while swelling), index 18 is lit by flint and steel. */
export function creeperLit(entity: { metadata?: unknown[] }): boolean {
  const meta = Array.isArray(entity.metadata) ? entity.metadata : [];
  return meta[16] === 1 || meta[18] === true;
}
