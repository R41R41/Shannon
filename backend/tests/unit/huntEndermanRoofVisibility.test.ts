import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { endermanRoofSites } from '../../src/services/minebot/utils/huntEndermanCamp.js';
import { ENDERMAN_EYE, endermanLine } from '../../src/services/minebot/utils/huntEnderman.js';
import { bodyReader } from '../../src/services/minebot/utils/localMap.js';

// The saved1106c anchor and first blocking cap; the target/flat field below are
// controlled geometry, not a reconstruction of its unrecorded live target pose.
const anchor = { x: 315, y: 48, z: -110 };
const from = { x: 315.5, y: 48, z: -109.5 };
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
const entity = (id: number, x: number, y: number, z = -109.5, name = 'enderman') =>
  ({ id, name, position: new Vec3(x, y, z), width: 0.6, height: name === 'enderman' ? 2.9 : 1.8, isValid: true });
const elevated = () => entity(315, 315.5, 60, -99.5);
function body(blocks: Record<string, string | null> = {}, entities: any[] = [elevated()]) {
  return {
    entity: { id: 1, position: new Vec3(from.x, from.y, from.z) },
    entities: Object.fromEntries(entities.map(e => [e.id, e])), registry: {},
    blockAt(p: Vec3) {
      const cell = key(p.x, p.y, p.z);
      const name = cell in blocks ? blocks[cell] : p.y < anchor.y ? 'stone' : 'air';
      return name === null ? null : { name, boundingBox: name === 'air' ? 'empty' : 'block',
        shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]] };
    },
  };
}
const site = (bot: ReturnType<typeof body>) => endermanRoofSites(bot, 4, 400).sites
  .find(s => s.cell.x === anchor.x && s.cell.y === anchor.y && s.cell.z === anchor.z);
function unknownExitFloors() {
  return Object.fromEntries([[2, 0], [-2, 0], [0, 2], [0, -2]].map(([dx, dz]) =>
    [key(anchor.x + dx, anchor.y - 1, anchor.z + dz), null]));
}

describe('public roofsite visibility after the same completeNine roof', () => {
  it('does not count eyes that the planned central cap hides when no known exit exists', () => {
    const bot = body(unknownExitFloors());
    expect(endermanLine(bodyReader(bot), from, elevated().position, ENDERMAN_EYE).clear).toBe(true);
    const complete: Record<string, string | null> = { ...unknownExitFloors() };
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++)
      complete[key(anchor.x + dx, anchor.y + 2, anchor.z + dz)] = 'cobblestone';
    const blocked = endermanLine(bodyReader(body(complete)), from, elevated().position, ENDERMAN_EYE);
    expect(blocked.between[0]).toEqual({ at: { x: 315, y: 50, z: -110 }, name: 'cobblestone' });
    expect(site(bot)).toMatchObject({ seen: 0, seenIds: [] });
    expect(bot.blockAt(new Vec3(315, 50, -110))?.name).toBe('air'); // prediction did not build
  });

  it('retains a cap-hidden target when the existing known exit geometry can see its eyes', () => {
    expect(site(body())).toMatchObject({ seen: 1, seenIds: [315] });
  });

  it('uses the same occupied-column rejection for those existing exits', () => {
    const occupied = [[2, 0], [-2, 0], [0, 2], [0, -2]].map(([dx, dz], i) =>
      entity(400 + i, from.x + dx, from.y, from.z + dz, 'zombie'));
    expect(site(body({}, [elevated(), ...occupied]))).toMatchObject({ seen: 0, seenIds: [] });
  });

  it('keeps the flat visible case, ID order and valid original site ordering', () => {
    const result = endermanRoofSites(body({}, [entity(400, 339.5, 48), entity(315, 335.5, 48)]), 4);
    expect(result.sites.every(s => s.seen === 2 && JSON.stringify(s.seenIds) === '[315,400]')).toBe(true);
    expect(result.sites.map(s => s.cell)).toEqual([
      { x: 315, y: 48, z: -110 }, { x: 314, y: 48, z: -110 },
      { x: 315, y: 48, z: -111 }, { x: 315, y: 48, z: -109 }, { x: 316, y: 48, z: -110 },
    ]);
  });

  it('keeps unknown sight blocked unless an independently known existing exit sees the eyes', () => {
    expect(site(body({ '315,50,-110': null }))?.seen ?? 0).toBe(0);
    const unknownRay = { '325,50,-110': null };
    expect(site(body({ ...unknownExitFloors(), ...unknownRay }, [entity(315, 335.5, 48)])))
      .toMatchObject({ seen: 0, seenIds: [] });
    // A known, clear allowed exit is a separate ray; the unknown centre ray was not made clear.
    expect(site(body(unknownRay, [entity(315, 335.5, 48)]))).toMatchObject({ seen: 1, seenIds: [315] });
  });
});
