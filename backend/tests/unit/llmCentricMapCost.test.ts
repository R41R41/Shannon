import { createRequire } from 'node:module';
import { PerformanceObserver } from 'node:perf_hooks';
import v8 from 'node:v8';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { bodyReader, drawLocalMap, localMapFor, type BlockReader, type MapBlock } from '../../src/services/minebot/utils/localMap.js';

// The cost of the decision's map (run 27: 110-685 GCs a minute, up to 2.2 s; the map redraw was the suspect). The map's text is the
// contract's and must not change; what is measured is how it is read: `bot.blockAt` builds a Block (with light, biome, shapes) for every
// cell, ~1,000 cells in the rock and ~5,000 under the open sky. A real prismarine world (mineflayer's own `world.sync`) is built here so
// that the numbers are the real library's; without the packages the benchmark is skipped and only the fake-world tests run.
const require = createRequire(import.meta.url);

/** The reader as it was before the state-id path: one `bot.blockAt` per cell (kept here to compare against, byte for byte and in cost). */
function legacyReader(bot: any): BlockReader {
  return (x, y, z) => {
    let block: any;
    try { block = bot.blockAt?.(new Vec3(x, y, z), false); } catch { block = null; }
    if (!block) return null;
    const name = String(block.name);
    const out: MapBlock = { name, solid: block.boundingBox === 'block' };
    if (name === 'water' || name === 'lava' || name === 'end_portal_frame') {
      try {
        const properties = block.getProperties?.() ?? {};
        if (name === 'end_portal_frame') out.eye = properties.eye === true || properties.eye === 'true';
        else out.level = Number(properties.level ?? block.metadata ?? 0);
      } catch { out.level = Number(block.metadata ?? 0); }
    }
    return out;
  };
}

function realWorld() {
  try {
    const registry = require('prismarine-registry')('1.20.4');
    const Chunk = require('prismarine-chunk')(registry);
    const World = require('prismarine-world')(registry);
    const world = new World(null, null);
    const columns = new Map<string, any>();
    const columnAt = (x: number, z: number) => {
      const key = `${x >> 4},${z >> 4}`;
      let column = columns.get(key);
      if (!column) { column = new Chunk({ minY: -64, worldHeight: 384 }); columns.set(key, column); }
      return column;
    };
    const state = (name: string, add = 0) => registry.blocksByName[name].defaultState + add;
    const put = (x: number, y: number, z: number, id: number) => columnAt(x, z).setBlockStateId(new Vec3(x & 15, y, z & 15), id);
    return { registry, world, columns, state, put, columnAt, done() { for (const [key, column] of columns) { const [cx, cz] = key.split(',').map(Number); world.sync.setColumn(cx, cz, column); } } };
  } catch { return null; }
}

function bodyOn(built: NonNullable<ReturnType<typeof realWorld>>, at: Vec3) {
  const counter = { blockAt: 0 };
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { position: at, yaw: 0, onGround: true }, entities: {}, game: { dimension: 'overworld' }, registry: built.registry, world: built.world.sync,
    blockAt: (position: Vec3) => { counter.blockAt++; return built.world.sync.getBlock(position); },
  });
  return { bot, counter };
}

/** An open field with a pond, a tree and ore under it (surface mode), and a cave pocket in solid rock (layers mode). */
function terrain() {
  const built = realWorld();
  if (!built) return null;
  const { put, state } = built;
  for (let x = -40; x < 120; x++) for (let z = -40; z < 120; z++) {
    for (let y = 20; y <= 59; y++) put(x, y, z, state('stone'));
    put(x, 60, z, state('stone')); put(x, 61, z, state('dirt')); put(x, 62, z, state('dirt')); put(x, 63, z, state('grass_block'));
  }
  // Open field around (8, 64, 8): a pond, a tree, torches, flowers.
  for (let x = 12; x <= 15; x++) for (let z = 4; z <= 7; z++) { put(x, 63, z, state('water')); put(x, 62, z, state('water', (x + z) % 3)); }
  for (let y = 64; y <= 68; y++) put(4, y, 12, state('oak_log'));
  for (let x = 2; x <= 6; x++) for (let z = 10; z <= 14; z++) for (let y = 67; y <= 69; y++) if (!(x === 4 && z === 12 && y < 69)) put(x, y, z, state('oak_leaves'));
  put(9, 64, 9, state('torch')); put(7, 64, 10, state('poppy')); put(10, 64, 6, state('short_grass'));
  // Solid rock to the sky around (50, 45, 50): a pocket 9 x 9 x 4, lava and water in it, ore in the walls, a spawner above.
  for (let x = 30; x <= 70; x++) for (let z = 30; z <= 70; z++) for (let y = 64; y <= 90; y++) put(x, y, z, state('stone'));
  for (let x = 46; x <= 54; x++) for (let z = 46; z <= 54; z++) for (let y = 45; y <= 48; y++) put(x, y, z, state('air'));
  put(52, 44, 52, state('lava')); put(48, 44, 48, state('water')); put(45, 46, 50, state('iron_ore')); put(55, 47, 50, state('diamond_ore'));
  put(50, 52, 50, state('spawner')); put(50, 49, 47, state('coal_ore'));
  built.done();
  return built;
}

const FEET_FIELD = new Vec3(8.5, 64, 8.5), FEET_CAVE = new Vec3(50.5, 45, 50.5);
const crowd = (at: Vec3) => new Map<string, string>([[`${Math.floor(at.x) + 2},${Math.floor(at.y)},${Math.floor(at.z) + 1}`, '!'], [`${Math.floor(at.x) - 3},${Math.floor(at.y)},${Math.floor(at.z)}`, 'm']]);
const trail = (at: Vec3) => new Set([`${Math.floor(at.x) - 1},${Math.floor(at.y)},${Math.floor(at.z)}`, `${Math.floor(at.x) - 2},${Math.floor(at.y)},${Math.floor(at.z)}`]);

/** Heap bytes one call leaves (garbage and kept, a collection before and none during), the median of several, when gc can be called. */
function allocatedBytes(run: () => unknown, rounds = 15): number | null {
  let gc: (() => void) | undefined;
  try { v8.setFlagsFromString('--expose-gc'); gc = vm.runInNewContext('gc') as () => void; } catch { gc = undefined; }
  if (!gc) return null;
  const sizes: number[] = [];
  for (let i = 0; i < rounds; i++) { gc(); const before = process.memoryUsage().heapUsed; run(); sizes.push(process.memoryUsage().heapUsed - before); }
  return sizes.sort((a, b) => a - b)[Math.floor(sizes.length / 2)];
}
async function timed(run: () => unknown, loops: number) {
  const collections: Array<{ kind: number; ms: number }> = [];
  const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) collections.push({ kind: (entry as any).detail?.kind ?? (entry as any).kind, ms: entry.duration }); });
  observer.observe({ entryTypes: ['gc'] });
  const started = performance.now();
  for (let i = 0; i < loops; i++) run();
  const ms = performance.now() - started;
  await new Promise(resolve => setTimeout(resolve, 30));
  observer.disconnect();
  return { ms, perDraw: ms / loops, gcs: collections.length, gcMs: collections.reduce((sum, entry) => sum + entry.ms, 0) };
}

const built = terrain();
describe.skipIf(!built)('the map drawer on a real prismarine world: the same text, far fewer Block objects', () => {
  for (const [label, at] of [['open field (surface, ~5,000 reads)', FEET_FIELD], ['cave in rock (layers)', FEET_CAVE]] as const) {
    it(`${label}: byte for byte the same as the one-blockAt-per-cell reader, with a handful of blockAt calls instead of thousands`, async () => {
      const { bot, counter } = bodyOn(built!, at);
      const feet = { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) };
      const input = (read: BlockReader) => ({ feet, read, trail: trail(at), creatures: crowd(at) });
      counter.blockAt = 0;
      const before = drawLocalMap(input(legacyReader(bot)));
      const legacyCalls = counter.blockAt;
      counter.blockAt = 0;
      const after = drawLocalMap(input(bodyReader(bot)));
      const newCalls = counter.blockAt;
      expect(after).toBe(before);
      expect(before.split('\n')[0]).toContain(label.startsWith('open') ? '方式=surface' : '方式=layers');
      expect(legacyCalls).toBeGreaterThan(900);
      // Drawn again (the state ids are known by now): no more blockAt than the first time.
      counter.blockAt = 0;
      drawLocalMap(input(bodyReader(bot)));
      const againCalls = counter.blockAt;

      // The numbers for the report (vitest prints them; asserted below only for the direction).
      const bytesBefore = allocatedBytes(() => drawLocalMap(input(legacyReader(bot))));
      const bytesAfter = allocatedBytes(() => drawLocalMap(input(bodyReader(bot))));
      const run = (read: () => BlockReader) => () => drawLocalMap(input(read()));
      await timed(run(() => legacyReader(bot)), 20); await timed(run(() => bodyReader(bot)), 20);
      const oldCost = await timed(run(() => legacyReader(bot)), 150), newCost = await timed(run(() => bodyReader(bot)), 150);
      // eslint-disable-next-line no-console
      console.log(`[map cost] ${label}: blockAt/draw ${legacyCalls} -> ${newCalls}; heap/draw ${bytesBefore === null ? 'n/a' : `${Math.round(bytesBefore / 1024)} KB`} -> ${bytesAfter === null ? 'n/a' : `${Math.round(bytesAfter / 1024)} KB`}; `
        + `ms/draw ${oldCost.perDraw.toFixed(2)} -> ${newCost.perDraw.toFixed(2)}; GCs in 150 draws ${oldCost.gcs} (${oldCost.gcMs.toFixed(0)} ms) -> ${newCost.gcs} (${newCost.gcMs.toFixed(0)} ms)`);
      expect(newCalls).toBeLessThan(legacyCalls / 20);
      expect(againCalls).toBeLessThanOrEqual(newCalls);
      expect(newCost.perDraw).toBeLessThan(oldCost.perDraw);
    }, 60_000);
  }
});

// ---- the redraw trigger (the contract: the feet cell changed, a block within 12 changed, or a creature's cell changed; at most every 500 ms) ----
describe('localMapFor: when it draws again', () => {
  function fake() {
    const calls = { blockAt: 0 };
    const mobs: Record<string, any> = {};
    const bot: any = Object.assign(new EventEmitter(), {
      entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true }, entities: mobs, game: { dimension: 'overworld' },
      blockAt: (p: Vec3) => { calls.blockAt++; return Math.floor(p.y) < 64 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }; },
    });
    return { bot, calls, mobs };
  }
  it('a creature moving to another cell redraws at most once a second; the feet or a block change keep the 500 ms', () => {
    const { bot, calls, mobs } = fake();
    mobs[7] = { id: 7, name: 'zombie', type: 'hostile', position: new Vec3(3.5, 64, 0.5) };
    const first = localMapFor(bot, { now: 10_000 })!;
    const drawn = calls.blockAt;
    expect(drawn).toBeGreaterThan(0);
    // The zombie steps to the next cell: inside the second, the map stays as drawn.
    mobs[7].position = new Vec3(4.5, 64, 0.5);
    expect(localMapFor(bot, { now: 10_600 })).toBe(first);
    expect(localMapFor(bot, { now: 10_990 })).toBe(first);
    expect(calls.blockAt).toBe(drawn);
    // From a second on it is drawn again, with the zombie where it is.
    const second = localMapFor(bot, { now: 11_000 })!;
    expect(second).not.toBe(first);
    expect(calls.blockAt).toBeGreaterThan(drawn);
    // The feet moving to another cell: drawn again after 500 ms, not a second.
    const afterSecond = calls.blockAt;
    bot.entity.position = new Vec3(1.5, 64, 0.5);
    expect(localMapFor(bot, { now: 11_300 })).toBe(second);
    expect(calls.blockAt).toBe(afterSecond);
    expect(localMapFor(bot, { now: 11_500 })).not.toBe(second);
    // A block changed within 12: also 500 ms.
    const afterFeet = calls.blockAt;
    bot.emit('blockUpdate', null, { position: new Vec3(2, 64, 0) });
    expect(localMapFor(bot, { now: 11_800 })).toBeTruthy();
    expect(calls.blockAt).toBe(afterFeet);
    localMapFor(bot, { now: 12_000 });
    expect(calls.blockAt).toBeGreaterThan(afterFeet);
  });
});
