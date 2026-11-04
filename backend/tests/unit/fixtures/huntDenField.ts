import { Vec3 } from 'vec3';
import { denOffset, denVector, type DenBlock, type DenDirection, type DenWorld, type EndermanDenSpec } from '../../../src/services/minebot/utils/huntEndermanDen.js';
import type { Cell } from '../../../src/services/minebot/utils/localMap.js';

export const DEN_Y = 64;
export function huntDenField(direction: DenDirection = 'east') {
  const den: EndermanDenSpec = { entrance: { x: 0, y: DEN_Y, z: 0 }, direction };
  const blocks = new Map<string, string | null>();
  const vector = denVector(direction), outside = denOffset(den, -1);
  let reads = 0;
  const bot: DenWorld = {
    entity: { position: new Vec3(outside.x + 0.5, outside.y, outside.z + 0.5) },
    blockAt(p): DenBlock | null {
      reads++;
      const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z), key = `${x},${y},${z}`;
      const name = blocks.has(key) ? blocks.get(key) : y < DEN_Y || x * vector.x + z * vector.z >= 0 ? 'netherrack' : 'air';
      if (name === null || name === undefined) return null;
      return { name, boundingBox: name === 'air' || name === 'lava' || name === 'water' ? 'empty' : 'block', hardness: 0.4, diggable: true,
        shapes: name === 'air' || name === 'lava' || name === 'water' ? [] : [[0, 0, 0, 1, 1, 1]] };
    },
  };
  const set = (at: Cell, name: string | null): void => { blocks.set(`${at.x},${at.y},${at.z}`, name); };
  return { bot, den, blocks, set, get reads() { return reads; } };
}
