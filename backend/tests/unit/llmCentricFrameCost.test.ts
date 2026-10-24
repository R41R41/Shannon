import { createRequire } from 'node:module';
import { PerformanceObserver } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it } from 'vitest';
import { bodyReader, localMapFor } from '../../src/services/minebot/utils/localMap.js';
import { insideStructure, mapMarkLines } from '../../src/services/minebot/utils/mapMarks.js';
import { foodPointsOf } from '../../src/services/minebot/utils/foodPoints.js';
import { aroundText } from '../../src/services/minebot/utils/actReport.js';

// Run 27: the body collected garbage 110-685 times a minute (up to 2.2 s). One simulated minute of the LLM-centric frame's extras
// (the map, the marks, `inside`, the food points, a stop's `around`), as the body makes them for a walking body: an observation every
// 250 ms, the feet on a new cell every ~230 ms (4.3 m/s), a zombie and a cow moving, a stop every 5 s. On a real prismarine world
// (mineflayer's own `world.sync`) of 15 x 15 chunk columns: rock, a lake, a lava pool, ore, a village's beds, chests and hay.
// Only functions that exist before and after r3 are called, so the same file measures the old source (`git show HEAD:`) and the new.
const require = createRequire(import.meta.url);

function realWorld() {
  try {
    const registry = require('prismarine-registry')('1.20.4');
    const Chunk = require('prismarine-chunk')(registry);
    const World = require('prismarine-world')(registry);
    return { registry, Chunk, World };
  } catch { return null; }
}

function build() {
  const lib = realWorld();
  if (!lib) return null;
  const { registry, Chunk, World } = lib;
  const world = new World(null, null);
  const columns = new Map<string, any>();
  const state = (name: string, add = 0) => registry.blocksByName[name].defaultState + add;
  const columnAt = (x: number, z: number) => {
    const key = `${x >> 4},${z >> 4}`;
    let column = columns.get(key);
    if (!column) { column = new Chunk({ minY: -64, worldHeight: 384 }); columns.set(key, column); }
    return column;
  };
  const put = (x: number, y: number, z: number, id: number) => columnAt(x, z).setBlockStateId(new Vec3(x & 15, y, z & 15), id);
  const STONE = state('stone'), DIRT = state('dirt'), GRASS = state('grass_block'), WATER = state('water'), LAVA = state('lava');
  const IRON = state('iron_ore'), COAL = state('coal_ore'), AIR = state('air');
  // -120..119 on x and z: 15 x 15 columns. Rock from y 40 to 60, dirt, grass at 63.
  for (let x = -120; x < 120; x++) for (let z = -120; z < 120; z++) {
    for (let y = 40; y <= 60; y++) put(x, y, z, STONE);
    put(x, 61, z, DIRT); put(x, 62, z, DIRT); put(x, 63, z, GRASS);
    // Ore every few blocks in the rock, a cave layer at 50..52 under the east half (ore faces open to air).
    if ((x * 7 + z * 13) % 23 === 0) put(x, 55, z, IRON);
    if ((x * 11 + z * 5) % 17 === 0) put(x, 57, z, COAL);
    if (x > 20 && x < 70 && z > -30 && z < 30) for (let y = 50; y <= 52; y++) put(x, y, z, AIR);
  }
  // A lake (sources and flowing), and a lava pool.
  for (let x = -60; x < -20; x++) for (let z = -20; z < 20; z++) for (let y = 58; y <= 63; y++) put(x, y, z, y === 63 && (x + z) % 5 === 0 ? state('water', 1) : WATER);
  for (let x = 30; x < 36; x++) for (let z = 40; z < 46; z++) put(x, 63, z, LAVA);
  // A village: beds, chests, hay, wheat, a few houses of planks.
  for (let i = 0; i < 6; i++) {
    const bx = -10 + i * 7, bz = 30;
    for (let x = bx; x < bx + 5; x++) for (let z = bz; z < bz + 5; z++) for (let y = 64; y <= 67; y++) if (x === bx || x === bx + 4 || z === bz || z === bz + 4 || y === 67) put(x, y, z, state('oak_planks'));
    put(bx + 2, 64, bz + 2, state('red_bed')); put(bx + 1, 64, bz + 1, state('chest'));
    put(bx + 2, 64, bz - 3, state('hay_block'));
    for (let x = bx; x < bx + 5; x++) put(x, 64, bz + 8, state('wheat'));
  }
  put(0, 64, 0, state('crafting_table')); put(2, 64, 0, state('furnace'));
  for (const [key, column] of columns) { const [cx, cz] = key.split(',').map(Number); world.sync.setColumn(cx, cz, column); }
  return { registry, world };
}

function body(built: NonNullable<ReturnType<typeof build>>) {
  const mobs: Record<string, any> = {
    7: { id: 7, name: 'zombie', type: 'hostile', position: new Vec3(5.5, 64, 3.5) },
    8: { id: 8, name: 'cow', type: 'animal', position: new Vec3(-3.5, 64, -2.5) },
  };
  const bot: any = Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true }, entities: mobs, game: { dimension: 'overworld' },
    registry: built.registry, world: built.world.sync, food: 17, foodSaturation: 2.5,
    inventory: { items: () => [{ name: 'bread', count: 3 }, { name: 'cobblestone', count: 40 }, { name: 'stone_pickaxe', count: 1 }, { name: 'beef', count: 2 }] },
    landmarks: [{ kind: 'village', position: { x: 10, y: 64, z: 32 }, evidence: '鐘・家6' }],
    blockAt: (position: Vec3, extra?: boolean) => built.world.sync.getBlock(position, extra),
  });
  return { bot, mobs };
}

/** The walk: a square of 60 blocks a side round the start, at 4.3 m/s. */
function feetAt(ms: number): Vec3 {
  const metres = (ms / 1000) * 4.3, side = 60, around = metres % (side * 4), leg = Math.floor(around / side), along = around % side;
  const [x, z] = leg === 0 ? [along, 0] : leg === 1 ? [side, along] : leg === 2 ? [side - along, side] : [0, side - along];
  return new Vec3(x - 30 + 0.5, 64, z - 30 + 0.5);
}

const built = build();
describe.skipIf(!built)('one minute of the LLM-centric frame\'s extras (map, marks, inside, food points, around)', () => {
  it('measures the GCs and the milliseconds per simulated minute, the mean of three (printed as [gc])', async () => {
    const { bot, mobs } = body(built!);
    const parts = { map: 0, marks: 0, inside: 0, food: 0, around: 0 };
    const draw = (start: number, minutes: number) => {
      let frames = 0;
      for (let t = start; t < start + minutes * 60_000; t += 250) {
        const feet = feetAt(t - start);
        bot.entity.position = feet;
        mobs[7].position = feet.offset(3 + Math.sin(t / 700) * 2, 0, 2);
        mobs[8].position = feet.offset(-4, 0, Math.cos(t / 900) * 3);
        let started = performance.now();
        localMapFor(bot, { now: t }); parts.map += performance.now() - started;
        started = performance.now(); mapMarkLines(bot, t); parts.marks += performance.now() - started;
        started = performance.now(); insideStructure(bot, t); parts.inside += performance.now() - started;
        started = performance.now(); foodPointsOf(bot, t); parts.food += performance.now() - started;
        if (t % 5000 === 0) {
          started = performance.now();
          aroundText(bodyReader(bot), { x: Math.floor(feet.x) + 1, y: 64, z: Math.floor(feet.z) }, { x: Math.floor(feet.x), y: 64, z: Math.floor(feet.z) });
          parts.around += performance.now() - started;
        }
        frames++;
      }
      return frames;
    };
    // Warm up (the JIT, the state caches), then one minute measured.
    draw(1_000_000, 0.5);
    for (const key of Object.keys(parts) as Array<keyof typeof parts>) parts[key] = 0;
    const collections: number[] = [];
    const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) collections.push(entry.duration); });
    observer.observe({ entryTypes: ['gc'] });
    const started = performance.now();
    const MINUTES = 3;
    const frames = draw(5_000_000, MINUTES);
    const ms = performance.now() - started;
    await new Promise(resolve => setTimeout(resolve, 50));
    observer.disconnect();
    const gcMs = collections.reduce((sum, value) => sum + value, 0);
    // eslint-disable-next-line no-console
    console.log(`[gc] per simulated minute (${frames / MINUTES} frames, mean of ${MINUTES}): GCs ${(collections.length / MINUTES).toFixed(1)} (${(gcMs / MINUTES).toFixed(1)} ms, max ${Math.max(0, ...collections).toFixed(1)} ms); `
      + `work ${(ms / MINUTES).toFixed(0)} ms = map ${(parts.map / MINUTES).toFixed(0)} / marks ${(parts.marks / MINUTES).toFixed(0)} / inside ${(parts.inside / MINUTES).toFixed(1)} / food ${(parts.food / MINUTES).toFixed(1)} / around ${(parts.around / MINUTES).toFixed(1)} ms`);
    expect(frames).toBe(240 * MINUTES);
  }, 120_000);

  it('scanLoadedBlocksMany gives every query what the one-query scan of before gave it (same hits, same order)', async () => {
    const { scanLoadedBlocksMany } = await import('../../src/services/minebot/utils/loadedBlockScan.js');
    /** scanLoadedBlocks as it was before r3 (one query, a Vec3 for every matching cell). */
    const legacy = (bot: any, names: string[], options: { maxHits?: number; maxDistance?: number }) => {
      const wanted = new Map<number, string>();
      for (const name of names) { const block = bot.registry.blocksByName[name]; if (block?.minStateId === undefined) continue; for (let s = block.minStateId; s <= block.maxStateId; s++) wanted.set(s, name); }
      const origin = bot.entity.position, hits: Array<{ name: string; position: Vec3; distance: number }> = [];
      if (!wanted.size) return hits;
      const maxDistance = options.maxDistance ?? Infinity, maxHits = options.maxHits ?? Infinity;
      const columns = bot.world.getColumns().filter((entry: any) => entry.column?.sections).map((entry: any) => {
        const baseX = Number(entry.chunkX) * 16, baseZ = Number(entry.chunkZ) * 16;
        const dx = Math.max(baseX - origin.x, 0, origin.x - (baseX + 16)), dz = Math.max(baseZ - origin.z, 0, origin.z - (baseZ + 16));
        return { column: entry.column, baseX, baseZ, edge: Math.hypot(dx, dz) };
      }).sort((a: any, b: any) => a.edge - b.edge);
      let furthest = Infinity;
      for (const { column, baseX, baseZ, edge } of columns) {
        if (edge > maxDistance || edge > furthest) break;
        const minY = typeof column.minY === 'number' ? column.minY : 0;
        for (let index = 0; index < column.sections.length; index++) {
          const data = column.sections[index]?.data;
          if (!data) continue;
          if (data.palette ? !data.palette.some((s: number) => wanted.has(s)) : typeof data.value === 'number' && !wanted.has(data.value)) continue;
          for (let cell = 0; cell < 4096; cell++) {
            const name = wanted.get(data.get(cell)); if (!name) continue;
            const position = new Vec3(baseX + (cell & 15), minY + index * 16 + (cell >> 8), baseZ + ((cell >> 4) & 15));
            const distance = position.distanceTo(origin);
            if (distance <= maxDistance) hits.push({ name, position, distance });
          }
        }
        if (hits.length >= maxHits) { hits.sort((a, b) => a.distance - b.distance); hits.length = maxHits; furthest = hits[maxHits - 1].distance; }
      }
      hits.sort((a, b) => a.distance - b.distance);
      if (hits.length > maxHits) hits.length = maxHits;
      return hits;
    };
    const { bot } = body(built!);
    const queries = [
      { names: ['water'], maxDistance: 48, maxHits: 64 }, { names: ['stone'], maxDistance: 30, maxHits: 50 }, { names: ['iron_ore', 'coal_ore'], maxDistance: 24, maxHits: 128 },
      { names: ['red_bed', 'chest', 'furnace', 'crafting_table'], maxDistance: 48, maxHits: 64 }, { names: ['hay_block', 'wheat'], maxDistance: 96, maxHits: 3 },
      { names: ['lava'], maxDistance: 96 }, { names: ['spawner'], maxDistance: 96, maxHits: 4 }, { names: ['no_such_block'], maxHits: 5 }, { names: ['dirt', 'grass_block'], maxHits: 7 },
    ];
    for (const at of [new Vec3(0.5, 64, 0.5), new Vec3(-40.5, 62, 0.5), new Vec3(33.5, 51, 41.5)]) {
      bot.entity.position = at;
      const many = scanLoadedBlocksMany(bot, queries);
      queries.forEach((query, index) => {
        const want = legacy(bot, query.names, query).map(hit => `${hit.name}@${hit.position.x},${hit.position.y},${hit.position.z}:${hit.distance}`);
        const got = many[index].hits.map(hit => `${hit.name}@${hit.position.x},${hit.position.y},${hit.position.z}:${hit.distance}`);
        expect(got, `${query.names.join(',')} at ${at}`).toEqual(want);
      });
    }
  });

  it('the marks read the same before and after (printed as [marks] to compare against the old source)', () => {
    const { bot } = body(built!);
    for (const [index, at] of [new Vec3(0.5, 64, 0.5), new Vec3(-25.5, 64, 4.5), new Vec3(40.5, 51, 0.5), new Vec3(5.5, 64, 33.5)].entries()) {
      bot.entity.position = at;
      const lines = mapMarkLines(bot, 7_000_000 + index * 10_000, true);
      // eslint-disable-next-line no-console
      console.log(`[marks] ${index} ${lines.join(' | ')}`);
      expect(lines.length).toBeGreaterThan(0);
    }
  });

  it('the whole observation as the body sends it (captureWorldObservation and its JSON copy, four a second): GCs per simulated minute', async () => {
    const { bot, mobs } = body(built!);
    const { captureWorldObservation } = await import('../../src/services/minebot/cognition/worldFrame.js');
    const realNow = Date.now;
    let clock = 9_000_000;
    // The frame reads the clock itself: the simulated one.
    Date.now = () => clock;
    try {
      const run = (minutes: number) => {
        let chars = 0;
        for (let i = 0; i < minutes * 240; i++) {
          clock += 250;
          const feet = feetAt(i * 250);
          bot.entity.position = feet;
          mobs[7].position = feet.offset(3 + Math.sin(i / 3) * 2, 0, 2);
          mobs[8].position = feet.offset(-4, 0, Math.cos(i / 4) * 3);
          chars += JSON.stringify(JSON.parse(JSON.stringify(captureWorldObservation(bot)))).length;
        }
        return chars;
      };
      run(0.5);
      const collections: number[] = [];
      const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) collections.push(entry.duration); });
      observer.observe({ entryTypes: ['gc'] });
      const MINUTES = 3;
      const started = performance.now();
      const chars = run(MINUTES);
      const ms = performance.now() - started;
      await new Promise(resolve => setTimeout(resolve, 50));
      observer.disconnect();
      // eslint-disable-next-line no-console
      console.log(`[gc] whole frame per simulated minute (mean of ${MINUTES}): GCs ${(collections.length / MINUTES).toFixed(1)} (${(collections.reduce((sum, value) => sum + value, 0) / MINUTES).toFixed(1)} ms); `
        + `work ${(ms / MINUTES).toFixed(0)} ms; ${Math.round(chars / MINUTES / 240)} chars a frame`);
      expect(chars).toBeGreaterThan(0);
    } finally { Date.now = realNow; }
  }, 120_000);

  it('r4: the whole observation with world.scan kept, and what each probe costs on this world (printed as [gc] r4 / [probe]; skipped on a source before r4)', async () => {
    let scanModule: typeof import('../../src/services/minebot/utils/worldScan.js');
    let probeModule: typeof import('../../src/services/minebot/instantSkills/probe.js');
    try {
      scanModule = await import('../../src/services/minebot/utils/worldScan.js');
      probeModule = await import('../../src/services/minebot/instantSkills/probe.js');
    } catch { return; }
    const { bot, mobs } = body(built!);
    const summary = (await scanModule.scanWorld(bot))!;
    const { longestSliceMs, ...kept } = summary;
    bot.worldScan = { ...kept, trigger: 'login', at: '2026-10-22T04:00:00.000Z', dimension: 'overworld', center: { x: 0, y: 64, z: 0 } };
    const { captureWorldObservation } = await import('../../src/services/minebot/cognition/worldFrame.js');
    const realNow = Date.now;
    let clock = 9_000_000;
    Date.now = () => clock;
    try {
      const run = (minutes: number) => {
        let chars = 0;
        for (let i = 0; i < minutes * 240; i++) {
          clock += 250;
          const feet = feetAt(i * 250);
          bot.entity.position = feet;
          mobs[7].position = feet.offset(3 + Math.sin(i / 3) * 2, 0, 2);
          mobs[8].position = feet.offset(-4, 0, Math.cos(i / 4) * 3);
          chars += JSON.stringify(JSON.parse(JSON.stringify(captureWorldObservation(bot)))).length;
        }
        return chars;
      };
      run(0.5);
      const collections: number[] = [];
      const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) collections.push(entry.duration); });
      observer.observe({ entryTypes: ['gc'] });
      const MINUTES = 3;
      const started = performance.now();
      const chars = run(MINUTES);
      const ms = performance.now() - started;
      await new Promise(resolve => setTimeout(resolve, 50));
      observer.disconnect();
      // eslint-disable-next-line no-console
      console.log(`[gc] r4 whole frame with world.scan (${summary.rows.length} rows, ${summary.chunks} chunks scanned in ${summary.ms} ms, longest hold ${longestSliceMs} ms) per simulated minute (mean of ${MINUTES}): `
        + `GCs ${(collections.length / MINUTES).toFixed(1)} (${(collections.reduce((sum, value) => sum + value, 0) / MINUTES).toFixed(1)} ms); work ${(ms / MINUTES).toFixed(0)} ms; ${Math.round(chars / MINUTES / 240)} chars a frame`);
    } finally { Date.now = realNow; }
    // Each kind once on this world, from the start (the probe's own time: a decision asks at most two in a step).
    bot.entity.position = new Vec3(0.5, 64, 0.5);
    const times: string[] = [];
    for (const input of [{ kind: 'path', to: { x: 40, y: 51, z: 0 } }, { kind: 'path', to: { x: -40, y: 64, z: 0 } }, { kind: 'sight', target: { x: 2, y: 64, z: 0 } },
      { kind: 'column', yFrom: 40, yTo: 70 }, { kind: 'around', radius: 16 }, { kind: 'history' }, { kind: 'scan' }]) {
      const started = performance.now();
      const result = await probeModule.runProbe(bot, input);
      times.push(`${input.kind}${input.kind === 'path' ? `→${(input as { to: { x: number } }).to.x}` : ''} ${(performance.now() - started).toFixed(1)} ms ${result.result.length} chars`);
      expect(result.success).toBe(true);
    }
    // eslint-disable-next-line no-console
    console.log(`[probe] ${times.join(' / ')}`);
  }, 120_000);
});
