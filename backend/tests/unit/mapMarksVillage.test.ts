import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { mapMarkLines } from '../../src/services/minebot/utils/mapMarks.js';

/**
 * Run 6 (22:14): a bed 40 m under the village was called "村のベッド" because the village's reach was flat (64 m); the two halves of one bed counted as two beds, and three kept marks were
 * a bed and a half. A bed is two blocks side by side; a mark is "村の" only within the village's height.
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
const bodyIn = (built: ReturnType<typeof worldWith>, feet: Vec3, landmarks: unknown[]) => Object.assign(new EventEmitter(), {
  entity: { id: 1, position: feet, yaw: 0, onGround: true }, entities: {}, game: { dimension: 'overworld' }, registry: built.registry, world: built.world.sync, landmarks,
  blockAt: (position: Vec3, extra?: boolean) => built.world.sync.getBlock(position, extra),
}) as never;
const village = { kind: 'village', distance: 5, direction: '東', position: { x: 12, y: 64, z: 0 }, evidence: 'ベッド2台' };

describe('the village marks', () => {
  it('a bed 40 m under the village is the body\'s own find, not "村の"; one in the village is', () => {
    const built = worldWith([[10, 64, 2, 'red_bed'], [10, 24, 3, 'white_bed']]);
    const lines = mapMarkLines(bodyIn(built, new Vec3(0.5, 64, 0.5), [village]), 1_000, true);
    expect(lines.some(line => line.includes('村のベッド') && line.includes('(10,64,2)'))).toBe(true);
    const under = lines.find(line => line.includes('(10,24,3)'));
    expect(under).toBeDefined();
    expect(under).not.toContain('村の');
  });
  it('the two halves of one bed are one bed (three beds are three marks, not a bed and a half)', () => {
    const built = worldWith([[10, 64, 2, 'red_bed'], [11, 64, 2, 'red_bed'], [10, 64, 6, 'red_bed'], [11, 64, 6, 'red_bed'], [10, 64, 10, 'red_bed'], [11, 64, 10, 'red_bed']]);
    const lines = mapMarkLines(bodyIn(built, new Vec3(0.5, 64, 0.5), [village]), 1_000, true).filter(line => line.includes('red_bed'));
    expect(lines).toHaveLength(3);
    for (const z of [2, 6, 10]) expect(lines.some(line => line.includes(`(1${0},64,${z})`) || line.includes(`(11,64,${z})`))).toBe(true);
  });
});
