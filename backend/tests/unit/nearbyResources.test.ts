import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { nearbyResources, treesOf } from '../../src/services/minebot/utils/nearbyResources.js';

/**
 * Run 7 (11/11): the planner saw "oak_log×12" and one cow at 9.5 m, and took the cow and the minimum of wood. The body lists by purpose, with counts and the nearest few places:
 * trees (touching logs are one tree), food animals, a village's hay and fields, with how far each count reaches. It does not say what is enough.
 */
const require = createRequire(import.meta.url);

function worldWith(blocks: Array<[number, number, number, string]>) {
  const registry = require('prismarine-registry')('1.20.4');
  const Chunk = require('prismarine-chunk')(registry);
  const World = require('prismarine-world')(registry);
  const world = new World(null, null);
  const columns = new Map<string, any>();
  for (const [x, y, z, name] of blocks) {
    const key = `${x >> 4},${z >> 4}`;
    let column = columns.get(key);
    if (!column) { column = new Chunk({ minY: 0, worldHeight: 256 }); columns.set(key, column); }
    column.setBlockStateId(new Vec3(x & 15, y, z & 15), registry.blocksByName[name].defaultState);
  }
  for (const [key, column] of columns) { const [cx, cz] = key.split(',').map(Number); world.sync.setColumn(cx, cz, column); }
  return { registry, world };
}

const bodyIn = (built: ReturnType<typeof worldWith>, feet: Vec3, extra: Record<string, unknown> = {}) => Object.assign(new EventEmitter(), {
  entity: { id: 1, position: feet, yaw: 0, onGround: true }, entities: {}, game: { dimension: 'overworld' }, registry: built.registry, world: built.world.sync,
  blockAt: (position: Vec3, e?: boolean) => built.world.sync.getBlock(position, e), ...extra,
}) as never;
const trunk = (x: number, z: number, y = 40, height = 4): Array<[number, number, number, string]> => Array.from({ length: height }, (_, i) => [x, y + i, z, 'oak_log']);

describe('nearby resources', () => {
  it('lists wood as logs and trees (touching logs are one), the nearest three trees by their foot, and how far the count reaches', () => {
    const built = worldWith([...trunk(5, 3), ...trunk(6, 4), ...trunk(20, 3), ...trunk(30, 9), ...trunk(60, 3)]);
    const list = nearbyResources(bodyIn(built, new Vec3(0.5, 40, 0.5)), 1_000);
    const wood = list.find(entry => entry.purpose === 'wood')!;
    expect(wood).toMatchObject({ kind: 'oak_log', count: 20, trees: 4, range: 128 });
    expect(wood.sites).toHaveLength(3);
    expect(wood.sites[0]).toMatchObject({ x: 5, y: 40, z: 3, note: 'oak_log 幹 8 本' });
    expect(wood.sites[1]).toMatchObject({ x: 20, y: 40, z: 3 });
  });

  it('groups touching logs into one tree with its lowest log as the foot', () => {
    const hits = [[5, 41, 3], [5, 40, 3], [6, 42, 4], [30, 40, 3]].map(([x, y, z]) => ({ name: 'oak_log', position: new Vec3(x, y, z), distance: Math.hypot(x, z) }));
    const trees = treesOf(hits);
    expect(trees).toHaveLength(2);
    expect(trees[0]).toMatchObject({ foot: { x: 5, y: 40, z: 3 }, logs: 3 });
  });

  it('counts food animals within 48 m by kind with their ids, nearest first; none when none is told of', () => {
    const built = worldWith([[3, 39, 3, 'stone']]);
    const entities = {
      7: { id: 7, name: 'cow', position: new Vec3(12, 40, 3) }, 8: { id: 8, name: 'cow', position: new Vec3(20, 40, 3) }, 9: { id: 9, name: 'sheep', position: new Vec3(30, 40, 3) },
      10: { id: 10, name: 'cow', position: new Vec3(90, 40, 3) }, 11: { id: 11, name: 'zombie', position: new Vec3(4, 40, 3) },
    };
    const list = nearbyResources(bodyIn(built, new Vec3(0.5, 40, 0.5), { entities }), 1_000);
    const animals = list.filter(entry => entry.purpose === 'food_animal');
    expect(animals.map(entry => [entry.kind, entry.count])).toEqual([['cow', 2], ['sheep', 1]]);
    expect(animals[0].sites[0]).toMatchObject({ x: 12, y: 40, z: 3, note: '#7' });
    expect(animals[0].range).toBe(48);
    expect(nearbyResources(bodyIn(built, new Vec3(0.5, 40, 0.5)), 1_000).some(entry => entry.purpose === 'food_animal')).toBe(false);
  });

  it('lists a village\'s hay and fields up to 128 m, the hay with how much bread it makes', () => {
    const hay: Array<[number, number, number, string]> = [[100, 40, 5, 'hay_block'], [101, 40, 5, 'hay_block'], [110, 40, 20, 'hay_block']];
    const built = worldWith([...hay, [112, 40, 20, 'wheat']]);
    const bot = bodyIn(built, new Vec3(0.5, 40, 0.5), { landmarks: [{ kind: 'village', position: { x: 105, y: 40, z: 10 } }] });
    const list = nearbyResources(bot, 1_000);
    const hayEntry = list.find(entry => entry.purpose === 'food_village' && entry.kind === 'hay_block')!;
    expect(hayEntry).toMatchObject({ count: 3, range: 128 });
    expect(hayEntry.sites[0]).toMatchObject({ x: 100, y: 40, z: 5, note: '作れば最大パン 9' });
    expect(list.some(entry => entry.purpose === 'food_village' && entry.kind === 'wheat')).toBe(true);
    // No village known: no list of its food.
    expect(nearbyResources(bodyIn(built, new Vec3(0.5, 40, 0.5)), 1_000).some(entry => entry.purpose === 'food_village')).toBe(false);
  });
});
