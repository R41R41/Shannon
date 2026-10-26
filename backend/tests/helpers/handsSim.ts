import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import minecraftData from 'minecraft-data';
import blockLoader from 'prismarine-block';
import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { withinTake } from '../../src/services/minebot/utils/primitives/pickup.js';

/**
 * A body for the hands that work with water, lava, blocks and fire (obsidian, portal): moved by the real client physics (prismarine-physics, the
 * engine mineflayer moves with) and the real route search and executor (mineflayer-pathfinder), in a small world made of a function from a cell to a
 * block name. What is not a server's is made as small as can be and as the game has it:
 *   - digging takes the dig time and tells the world by a server packet (`block_change`), the way digBlockVerified waits for it; the block's drop lies in
 *     its cell and is taken when the body's box (the game's take range, utils/primitives/pickup withinTake) reaches it;
 *   - laying puts no block where the body, as the server last saw it, stands;
 *   - a bucket is a ray of 4.5 from the eye along the look direction: an empty one takes the first source of water or lava it meets before any solid
 *     block, a full one of water puts a source in the cell beside the first solid block's face the ray enters it by (the fluid ignored);
 *   - water: a source runs down into air below it, else out level over air cells up to 7 (the game's flow); a lava cell with water above it or beside it
 *     (not below) becomes obsidian if it is a source and cobblestone if it flows, a quarter of a second after the water is there;
 *   - flint and steel on a block's face lights the cell beside it, and a fire in an empty 2 by 3 frame of obsidian becomes the nether portal; a body
 *     standing in a portal cell for 4 s is in the Nether (`game.dimension`).
 * Lava does not flow here (a cell dug beside lava stays as it is). Names with `~n` are a fluid at level n ('lava~3' flows, 'water~0' is a source).
 * The time is the test's: with fake timers the body moves 50 ms of physics for every 50 ms of fake time (`drive`). No server and no API.
 */
const VERSION = '1.21.11';
export const mcData = minecraftData(VERSION);
const Block = (blockLoader as any)(VERSION);
const { Physics, PlayerState } = createRequire(import.meta.url)('prismarine-physics');

export type Ground = (x: number, y: number, z: number) => string | null;
export interface Stack { name: string; count: number }

const AIR = new Set(['air', 'cave_air', 'void_air']);
const parse = (raw: string) => { const [name, level] = raw.split('~'); return { name, level: level === undefined ? 0 : Number(level) }; };
const solidName = (name: string) => mcData.blocksByName[name]?.boundingBox === 'block';
const HORIZONTAL: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const SETTLE_MS = 250;

export function makeHandsSim(ground: Ground, options: { start?: [number, number, number]; items?: Stack[] } = {}) {
  const changed = new Map<string, string | null>();
  const flow = new Map<string, string>();
  const cache = new Map<string, any>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  /** The cell's name before the water's flow is read: what was set, else the ground. */
  const baseRaw = (x: number, y: number, z: number): string | null => (changed.has(key(x, y, z)) ? changed.get(key(x, y, z))! : ground(x, y, z));
  const rawAt = (x: number, y: number, z: number): string | null => {
    const base = baseRaw(x, y, z);
    if (base === null || AIR.has(base)) return flow.get(key(x, y, z)) ?? base;
    return base;
  };
  const blockOf = (raw: string | null, x: number, y: number, z: number) => {
    if (raw === null) return null;
    const cacheKey = `${raw}@${x},${y},${z}`;
    let block = cache.get(cacheKey);
    if (!block) {
      const { name, level } = parse(raw);
      block = new Block(mcData.blocksByName[name].id, 0, level);
      block.position = new Vec3(x, y, z);
      cache.set(cacheKey, block);
    }
    return block;
  };
  const world = {
    getBlock: (position: Vec3) => { const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z); return blockOf(rawAt(x, y, z), x, y, z); },
    set: (x: number, y: number, z: number, raw: string | null) => { changed.set(key(x, y, z), raw); },
    nameAt: (x: number, y: number, z: number) => { const raw = rawAt(x, y, z); return raw === null ? null : parse(raw).name; },
    rawAt,
    changed,
  };
  const physics = Physics(mcData, world);
  const control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const items: any[] = [];
  const give = (name: string, count: number) => {
    const found = items.find(item => item.name === name);
    if (found) { found.count += count; return found; }
    const info = mcData.itemsByName[name];
    const item: any = { type: info.id, name, count, slot: 36 + items.length, maxDurability: info.maxDurability, durabilityUsed: 0, nbt: undefined };
    items.push(item);
    return item;
  };
  for (const stack of options.items ?? []) give(stack.name, stack.count);
  const start = options.start ?? [0.5, 64, 0.5];
  const client: any = Object.assign(new EventEmitter(), { write: () => undefined });
  const log: string[] = [];
  let nextEntity = 1000;
  let portalTicks = 0;
  let settling: ReturnType<typeof setTimeout> | null = null;

  const bot: any = Object.assign(new EventEmitter(), {
    version: VERSION, registry: mcData, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, health: 20, food: 20,
    game: { minY: -64, dimension: 'overworld', height: 384 }, entities: {} as Record<string, any>,
    inventory: { slots: new Array(46).fill(null), items: () => items.filter(item => item.count > 0) },
    heldItem: null as any,
    entity: { position: new Vec3(start[0], start[1], start[2]), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false,
      isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false, yaw: 0, pitch: 0, effects: {}, attributes: {}, height: 1.8, width: 0.6 },
    controlState: control, physics, _client: client,
    serverAt: new Vec3(start[0], start[1], start[2]),
    dugBlocks: [] as string[], placedBlocks: [] as string[], poured: [] as string[], scooped: [] as string[], lit: [] as string[],
    supportFeature: () => false,
    blockAt: (position: Vec3) => world.getBlock(position),
    getControlState: (name: string) => control[name],
    setControlState: (name: string, value: boolean) => { control[name] = value; },
    clearControlStates: () => { for (const k of Object.keys(control)) control[k] = false; },
    look: async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; },
    lookAt: async (point: Vec3) => {
      const delta = point.minus(bot.entity.position.offset(0, 1.62, 0));
      bot.entity.yaw = Math.atan2(-delta.x, -delta.z); bot.entity.pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
    },
    equip: async (item: any) => { bot.heldItem = item; },
    unequip: async () => { bot.heldItem = null; },
    stopDigging: () => undefined,
    deactivateItem: () => undefined,
    digTime: (block: any) => (block.name === 'obsidian' ? 9400 : 300),
    dig: async (block: any) => {
      const at = block.position;
      await new Promise(resolve => setTimeout(resolve, bot.digTime(block)));
      const old = world.getBlock(at);
      world.set(at.x, at.y, at.z, 'air');
      bot.dugBlocks.push(`${old?.name}@${at.x},${at.y},${at.z}`);
      log.push(`dig ${old?.name}@${at.x},${at.y},${at.z}`);
      spawnDrop(old?.name === 'stone' ? 'cobblestone' : String(old?.name), at);
      client.emit('block_change', { location: { x: at.x, y: at.y, z: at.z }, type: 0 });
      bot.emit('blockUpdate', old, world.getBlock(at));
      bot.emit(`blockUpdate:${at}`, old, world.getBlock(at));
      bot.emit('diggingCompleted', old);
      scheduleSettle();
    },
    placeBlock: async (reference: any, face: Vec3) => {
      const dest = reference.position.plus(face);
      await new Promise(resolve => setTimeout(resolve, 80));
      const held = bot.heldItem;
      if (!held || held.count <= 0) throw new Error('No item in hand');
      const existing = world.nameAt(dest.x, dest.y, dest.z);
      if (existing && !['air', 'cave_air', 'water', 'lava', 'short_grass'].includes(existing)) throw new Error(`No block has been placed : the block is still ${existing}`);
      // The server puts no block where the body (as it last saw it) stands.
      const s = bot.serverAt;
      if (s.x + 0.3 > dest.x && s.x - 0.3 < dest.x + 1 && s.z + 0.3 > dest.z && s.z - 0.3 < dest.z + 1 && s.y + 1.8 > dest.y && s.y < dest.y + 1) {
        throw new Error(`Event blockUpdate:(${dest.x}, ${dest.y}, ${dest.z}) did not fire within timeout of 5000ms`);
      }
      const old = world.getBlock(dest);
      world.set(dest.x, dest.y, dest.z, held.name);
      held.count--;
      bot.placedBlocks.push(`${held.name}@${dest.x},${dest.y},${dest.z}`);
      bot.emit('blockUpdate', old, world.getBlock(dest));
      bot.emit(`blockUpdate:${dest}`, old, world.getBlock(dest));
      scheduleSettle();
    },
    /** A right click with the item in the hand, along the look direction (the packet the body sends: the bucket's). */
    activateItem: () => {
      const held = bot.heldItem;
      if (!held) return;
      const eye = bot.entity.position.offset(0, 1.62, 0);
      const yaw = bot.entity.yaw, pitch = bot.entity.pitch;
      const direction = new Vec3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      if (held.name === 'bucket') {
        const hit = march(eye, direction, 4.5, true);
        if (!hit || !hit.fluid) return;
        const { name } = parse(rawAt(hit.cell.x, hit.cell.y, hit.cell.z)!);
        world.set(hit.cell.x, hit.cell.y, hit.cell.z, 'air');
        held.name = `${name}_bucket`; held.type = mcData.itemsByName[held.name].id;
        bot.scooped.push(`${name}@${hit.cell.x},${hit.cell.y},${hit.cell.z}`);
        log.push(`scoop ${name}@${hit.cell.x},${hit.cell.y},${hit.cell.z}`);
        bot.emit('blockUpdate', null, null);
        scheduleSettle();
      } else if (held.name === 'water_bucket') {
        const hit = march(eye, direction, 4.5, false);
        if (!hit) return;
        const target = new Vec3(hit.cell.x + hit.face.x, hit.cell.y + hit.face.y, hit.cell.z + hit.face.z);
        const there = world.nameAt(target.x, target.y, target.z);
        if (there && !AIR.has(there) && there !== 'water' && there !== 'lava') return;
        world.set(target.x, target.y, target.z, 'water');
        held.name = 'bucket'; held.type = mcData.itemsByName.bucket.id;
        bot.poured.push(`${target.x},${target.y},${target.z}`);
        log.push(`pour ${target.x},${target.y},${target.z}`);
        bot.emit('blockUpdate', null, null);
        scheduleSettle();
      }
    },
    /** A right click on a block's face (flint and steel lights the cell beside it). */
    activateBlock: async (block: any, direction?: Vec3) => {
      const held = bot.heldItem;
      if (held?.name !== 'flint_and_steel' || !direction) return;
      const cell = block.position.plus(direction);
      const there = world.nameAt(cell.x, cell.y, cell.z);
      if (!there || !AIR.has(there)) return;
      world.set(cell.x, cell.y, cell.z, 'fire');
      held.durabilityUsed++;
      bot.lit.push(`${cell.x},${cell.y},${cell.z}`);
      makePortal(cell);
      bot.emit('blockUpdate', null, null);
    },
  });
  pathfinder.pathfinder(bot);

  /** The first solid block (or, with `fluid`, the first source of water or lava) the ray meets, with the face it enters by (a vector pointing out of the block). */
  function march(eye: Vec3, direction: Vec3, reach: number, fluid: boolean): { cell: Vec3; face: Vec3; fluid: boolean } | null {
    let previous = new Vec3(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z));
    for (let t = 0.005; t <= reach; t += 0.005) {
      const cell = new Vec3(Math.floor(eye.x + direction.x * t), Math.floor(eye.y + direction.y * t), Math.floor(eye.z + direction.z * t));
      if (cell.equals(previous)) continue;
      const raw = rawAt(cell.x, cell.y, cell.z);
      const { name, level } = raw === null ? { name: 'air', level: 0 } : parse(raw);
      const solid = raw !== null && solidName(name);
      const source = (name === 'water' || name === 'lava') && level === 0;
      if (solid || (fluid && source)) {
        const moved = [cell.x - previous.x, cell.y - previous.y, cell.z - previous.z];
        const components = [Math.abs(direction.x), Math.abs(direction.y), Math.abs(direction.z)];
        let axis = -1, best = -1;
        moved.forEach((delta, i) => { if (delta !== 0 && components[i] > best) { best = components[i]; axis = i; } });
        const face = new Vec3(0, 0, 0);
        if (axis === 0) face.x = -Math.sign(moved[0]); else if (axis === 1) face.y = -Math.sign(moved[1]); else face.z = -Math.sign(moved[2]);
        return { cell, face, fluid: !solid };
      }
      previous = cell;
    }
    return null;
  }

  function spawnDrop(name: string, at: Vec3) {
    const id = nextEntity++;
    bot.entities[id] = { id, name: 'item', displayName: 'Item', type: 'other', position: new Vec3(at.x + 0.5, at.y + 0.4, at.z + 0.5), velocity: new Vec3(0, 0, 0),
      getDroppedItem: () => ({ name, count: 1 }), metadata: [] };
  }

  /** The water's flow from every source, and the lava it meets set; repeated until nothing changes. */
  function recompute() {
    for (let round = 0; round < 8; round++) {
      flow.clear();
      const sources: Vec3[] = [];
      for (const [k, raw] of changed) if (raw === 'water' || raw === 'water~0') { const [x, y, z] = k.split(',').map(Number); sources.push(new Vec3(x, y, z)); }
      const queue: Array<{ x: number; y: number; z: number; level: number }> = sources.map(s => ({ x: s.x, y: s.y, z: s.z, level: 0 }));
      const waters = new Set(sources.map(s => key(s.x, s.y, s.z)));
      while (queue.length) {
        const c = queue.shift()!;
        if (c.y <= -60) continue;
        const below = baseRaw(c.x, c.y - 1, c.z);
        if (below !== null && AIR.has(below)) {
          const k = key(c.x, c.y - 1, c.z);
          if (!flow.has(k)) { flow.set(k, 'water~8'); waters.add(k); queue.push({ x: c.x, y: c.y - 1, z: c.z, level: 8 }); }
          continue;
        }
        const next = c.level >= 8 ? 1 : c.level + 1;
        if (next > 7) continue;
        for (const [dx, dz] of HORIZONTAL) {
          const raw = baseRaw(c.x + dx, c.y, c.z + dz);
          const k = key(c.x + dx, c.y, c.z + dz);
          if (raw === null || !AIR.has(raw)) continue;
          const had = flow.get(k);
          if (had !== undefined && parse(had).level <= next) continue;
          flow.set(k, `water~${next}`); waters.add(k); queue.push({ x: c.x + dx, y: c.y, z: c.z + dz, level: next });
        }
      }
      let converted = false;
      for (const k of waters) {
        const [x, y, z] = k.split(',').map(Number);
        for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
          const raw = baseRaw(x + dx, y + dy, z + dz);
          if (raw === null) continue;
          const { name, level } = parse(raw);
          if (name !== 'lava') continue;
          const before = world.getBlock(new Vec3(x + dx, y + dy, z + dz));
          world.set(x + dx, y + dy, z + dz, level === 0 ? 'obsidian' : 'cobblestone');
          converted = true;
          bot.emit(`blockUpdate:${new Vec3(x + dx, y + dy, z + dz)}`, before, world.getBlock(new Vec3(x + dx, y + dy, z + dz)));
        }
      }
      if (!converted) break;
    }
    bot.emit('blockUpdate', null, null);
  }
  function scheduleSettle() {
    if (settling) return;
    settling = setTimeout(() => { settling = null; recompute(); }, SETTLE_MS);
  }

  /** A fire lit at `cell`: a frame of obsidian round an empty 2 by 3 inside (either plane) becomes the portal. */
  function makePortal(cell: Vec3) {
    const open = (x: number, y: number, z: number) => { const name = world.nameAt(x, y, z); return !!name && (AIR.has(name) || name === 'fire'); };
    const frameOk = (x: number, y: number, z: number) => { const name = world.nameAt(x, y, z); return name === 'obsidian' || name === 'crying_obsidian'; };
    for (const axis of ['x', 'z'] as const) for (let a0 = -1; a0 <= 0; a0++) for (let y0 = -2; y0 <= 0; y0++) {
      const at = (a: number, up: number): [number, number, number] => (axis === 'x' ? [cell.x + a0 + a, cell.y + y0 + up, cell.z] : [cell.x, cell.y + y0 + up, cell.z + a0 + a]);
      const cells: Array<[number, number, number]> = [];
      for (let a = 0; a <= 1; a++) for (let up = 0; up <= 2; up++) cells.push(at(a, up));
      if (!cells.some(c => c[0] === cell.x && c[1] === cell.y && c[2] === cell.z)) continue;
      const frame: Array<[number, number, number]> = [];
      for (let a = 0; a <= 1; a++) { frame.push(at(a, -1)); frame.push(at(a, 3)); }
      for (let up = 0; up <= 2; up++) { frame.push(at(-1, up)); frame.push(at(2, up)); }
      if (cells.every(c => open(...c)) && frame.every(c => frameOk(...c))) {
        for (const c of cells) world.set(c[0], c[1], c[2], `nether_portal~${axis === 'x' ? 0 : 1}`);
        log.push(`portal ${axis}`);
        return;
      }
    }
  }

  const tick = () => {
    bot.serverAt = bot.entity.position.clone();
    physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
    for (const [id, entity] of Object.entries<any>(bot.entities)) {
      if (entity.name === 'item' && withinTake(bot.entity.position, entity.position)) {
        give(entity.getDroppedItem().name, 1);
        delete bot.entities[id];
      }
    }
    const feet = bot.entity.position;
    if (world.nameAt(Math.floor(feet.x), Math.floor(feet.y), Math.floor(feet.z)) === 'nether_portal') {
      portalTicks++;
      if (portalTicks >= 80 && bot.game.dimension === 'overworld') { bot.game.dimension = 'the_nether'; log.push('dimension the_nether'); bot.emit('respawn'); }
    } else portalTicks = 0;
    bot.emit('physicsTick');
  };
  return { bot, world, control, tick, give, items, nameAt: world.nameAt, log, recompute, count: (name: string) => items.filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0) };
}
export type HandsSim = ReturnType<typeof makeHandsSim>;
