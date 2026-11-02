import { expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { makeSim, type Sim } from '../helpers/physicsBody.js';
import { digRuleOf, goMovements, type GoState } from '../../src/services/minebot/utils/primitives/go.js';
import { cloudZoneAtCell, lyingCloudZones } from '../../src/services/minebot/utils/dragonDanger.js';

const state = (): GoState => ({ steps: 0, dug: 0, placed: 0, redraws: 0, veto: null, refused: 0, exposed: new Map(), avoid: new Set(), dugCells: new Set(), laidCells: new Set() });
const args = { maxDrop: 3, waterOk: false, maxDig: 0, maxPlace: 0, sprint: false };

/** A flat floor at y 18 (feet at 19), the dimension the End, and a dragon's breath cloud (the particle dragon_breath) laid at (x, 19, 0.5). */
function endWith(cloudX: number | null, start: [number, number, number] = [3.5, 19, 0.5], dimension = 'minecraft:the_end'): Sim {
  const s = makeSim((x, y, z) => y < 19 ? 'stone' : 'air', { start });
  (s.bot as any).game = { ...((s.bot as any).game ?? {}), dimension };
  if (cloudX !== null) {
    const meta: unknown[] = []; meta[8] = 3; meta[10] = { type: 'dragon_breath' };
    (s.bot as any).entities = { ...((s.bot as any).entities ?? {}), 900: { id: 900, name: 'area_effect_cloud', position: new Vec3(cloudX, 19, 0.5), metadata: meta } };
  }
  return s;
}
const movesFrom = (s: Sim, x: number, relax: Record<string, boolean> = {}) => {
  const m = goMovements(s.bot, args, digRuleOf(s.bot.registry, []), [], state(), relax);
  return m.getNeighbors({ x, y: 19, z: 0, remainingBlocks: 0 }).map((p: any) => `${p.x},${p.y},${p.z}`);
};

// the cloud's middle at x 12.5: it reaches 7 blocks and a half block more, so the cells from x 5 on are in it
it('does not step into a dragon cloud that lies in the End, and leaves the way away from it', () => {
  const moves = movesFrom(endWith(12.5), 4);
  expect(moves).toContain('3,19,0');
  expect(moves).not.toContain('5,19,0');
});

it('steps where it likes when the cloud is not the breath (another particle), or the dimension is not the End', () => {
  const s = endWith(12.5);
  ((s.bot as any).entities[900].metadata)[10] = { type: 'flame' };
  expect(movesFrom(s, 4)).toContain('5,19,0');
  expect(movesFrom(endWith(12.5, [3.5, 19, 0.5], 'minecraft:overworld'), 4)).toContain('5,19,0');
});

it('shuts nothing when the body stands in the cloud already (the way out is the first thing to find), and the lifted rule opens the way', () => {
  const inside = endWith(12.5, [9.5, 19, 0.5]);
  expect(movesFrom(inside, 9)).toEqual(expect.arrayContaining(['8,19,0', '10,19,0']));
  expect(movesFrom(endWith(12.5), 4, { dragon: true })).toContain('5,19,0');
  expect(movesFrom(endWith(12.5), 4, { hazards: true })).toContain('5,19,0');
});

it('reads a body one block up as over the cloud: its slab is half a block high', () => {
  const zones = lyingCloudZones(endWith(12.5).bot);
  expect(zones).toHaveLength(1);
  expect(zones[0].radius).toBeGreaterThanOrEqual(7);
  expect(cloudZoneAtCell(zones, 10, 19, 0)).toMatch(/竜の息の雲/u);
  expect(cloudZoneAtCell(zones, 10, 20, 0)).toBeNull();
  expect(cloudZoneAtCell(zones, 10, 16, 0)).toBeNull();
  expect(cloudZoneAtCell(zones, 25, 19, 0)).toBeNull();
});
