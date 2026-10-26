import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { mapMarkLines, WOOD_MARK } from '../../src/services/minebot/utils/mapMarks.js';

/**
 * Run 39 (2026-10-26): a mineshaft's planks and fences lay 30 m off and no line of the frame said so while she had no table, 400 s. The body lists the
 * nearest plank or fence within 24 blocks with how many of each; the head shows the line only while she is short of wood.
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

const bodyIn = (built: ReturnType<typeof worldWith>, feet: Vec3) => Object.assign(new EventEmitter(), {
  entity: { id: 1, position: feet, yaw: 0, onGround: true }, entities: {}, game: { dimension: 'overworld' }, registry: built.registry, world: built.world.sync,
  blockAt: (position: Vec3, extra?: boolean) => built.world.sync.getBlock(position, extra),
}) as never;

describe('the wood mark', () => {
  it('names the nearest plank or fence within 24 blocks with how many of each', () => {
    const built = worldWith([[10, 40, 5, 'oak_planks'], [11, 40, 5, 'oak_planks'], [12, 40, 5, 'oak_planks'], [10, 41, 5, 'oak_fence'], [9, 40, 6, 'stone']]);
    const lines = mapMarkLines(bodyIn(built, new Vec3(0.5, 40, 0.5)), 1_000, true);
    const wood = lines.find(line => line.includes(WOOD_MARK));
    expect(wood).toBeDefined();
    expect(wood).toContain('板×3');
    expect(wood).toContain('柵×1');
    expect(wood).toMatch(/\(1[0-2],4[01],5\)/u);
  });

  it('says nothing when no plank or fence is within 24 blocks', () => {
    const built = worldWith([[40, 40, 40, 'oak_planks'], [3, 40, 3, 'stone']]);
    expect(mapMarkLines(bodyIn(built, new Vec3(0.5, 40, 0.5)), 1_000, true).some(line => line.includes(WOOD_MARK))).toBe(false);
  });
});
