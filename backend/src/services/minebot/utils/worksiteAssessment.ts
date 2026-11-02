import { Vec3 } from 'vec3';
import type { Cell } from './localMap.js';
import { holdsWater } from './waterBlocks.js';

export interface WaterExitAssessment {
  floor: Cell;
  stand: Cell;
  floorName: string;
  attach?: { at: Cell; name: string };
  dig: Array<{ at: Cell; name: string }>;
  breathing: 'observed_air' | 'submerged' | 'unknown';
  unknowns: string[];
}
const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const solid = (b: any) => b?.boundingBox === 'block' && !holdsWater(b) && b.name !== 'lava';
const air = (b: any) => b && b.boundingBox === 'empty' && !holdsWater(b) && b.name !== 'lava';

/** A local construction candidate, not a route or a prediction that water will stay out after digging.
 * Call again after every world change. No coordinates or free-form reason can certify breathing. */
export function assessWaterExits(bot: any, feet: Cell): WaterExitAssessment[] {
  const read = (p: Cell) => { try { return bot.blockAt(new Vec3(p.x, p.y, p.z)); } catch { return null; } };
  const options: WaterExitAssessment[] = [];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const floor = { x: feet.x + dx, y: feet.y, z: feet.z + dz }, block = read(floor);
    if (!block || (!solid(block) && !air(block) && !holdsWater(block))) continue;
    const stand = { ...floor, y: floor.y + 1 }, head = { ...floor, y: floor.y + 2 };
    const above = [stand, head].map(at => ({ at, block: read(at) }));
    if (above.some(({ block: b }) => b && (b.name === 'bedrock' || b.name === 'lava' || (b.boundingBox === 'block' && !holdsWater(b) && b.diggable === false)))) continue;
    const attach = solid(block) ? undefined : faces.map(([x, y, z]) => ({ x: floor.x + x, y: floor.y + y, z: floor.z + z }))
      .filter(at => !(at.x === feet.x && at.y === feet.y && at.z === feet.z))
      .map(at => ({ at, block: read(at) })).find(({ block: b }) => solid(b));
    if (!solid(block) && !attach) continue;
    const dig = above.filter(({ block: b }) => solid(b)).map(({ at, block: b }) => ({ at, name: String(b.name) }));
    const unknowns: string[] = [];
    if (above.some(({ block: b }) => !b)) unknowns.push('頭または足の空間が未ロード');
    if (dig.length) unknowns.push('掘削後の空間と水流は未確認');
    if (attach) unknowns.push('足場の設置と資材は未確認');
    const breathing = holdsWater(above[1].block) ? 'submerged'
      : !dig.length && above.every(({ block: b }) => air(b)) && !attach ? 'observed_air' : 'unknown';
    options.push({ floor, stand, floorName: String(block.name), ...(attach ? { attach: { at: attach.at, name: String(attach.block.name) } } : {}),
      dig, breathing, unknowns });
  }
  const rank = { observed_air: 0, unknown: 1, submerged: 2 };
  return options.sort((a, b) => rank[a.breathing] - rank[b.breathing] || a.dig.length + Number(!!a.attach) - b.dig.length - Number(!!b.attach));
}
