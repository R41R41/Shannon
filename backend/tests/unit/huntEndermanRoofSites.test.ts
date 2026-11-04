import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { endermanRoofSites } from '../../src/services/minebot/utils/huntEndermanCamp.js';

// probe kind=roofsite (S6, 11/5): the roof sites ranked by the endermen whose eyes are seen from them. A wall to the east hides the one there from the body's own
// cell; a site a few blocks north sees past the wall's end.
function body(blocks: Record<string, string>, entities: any[]) {
  const all: Record<number, any> = {};
  for (const e of entities) all[e.id] = e;
  return {
    entity: { position: new Vec3(0.5, 64, 0.5) }, entities: all, registry: {},
    blockAt: (p: Vec3) => {
      const name = blocks[`${p.x},${p.y},${p.z}`] ?? (p.y < 64 ? 'stone' : 'air');
      return { name, boundingBox: name === 'air' ? 'empty' : 'block', shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] };
    },
  };
}
const enderman = (id: number, x: number, z: number) => ({ id, name: 'enderman', position: new Vec3(x, 64, z), isValid: true });

describe('endermanRoofSites', () => {
  it('puts first the site that sees the most eyes, and says how many it sees', () => {
    const wall: Record<string, string> = {};
    for (let z = -6; z <= 3; z++) for (let y = 64; y <= 70; y++) wall[`5,${y},${z}`] = 'stone';
    const bot = body(wall, [enderman(1, 20.5, 0.5)]);
    const { sites, endermen } = endermanRoofSites(bot, 8);
    expect(endermen).toBe(1);
    expect(sites[0].seen).toBe(1);
    expect(sites[0].seenIds).toEqual([1]);
    expect(sites[0].cell.x > 5 || sites[0].cell.z > 3).toBe(true);   // past the wall or its end
    const every = endermanRoofSites(bot, 8, 400).sites;
    expect(every.find(s => s.cell.x === 0 && s.cell.z === 0)?.seen).toBe(0);   // the body's own cell does not see it
  });

  it('none in sight anywhere: every site says 0, nearest and cheapest first', () => {
    const { sites } = endermanRoofSites(body({}, []), 6);
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.every(s => s.seen === 0)).toBe(true);
  });
});
