import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import minecraftData from 'minecraft-data';
import blockLoader from 'prismarine-block';
import pathfinder from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';

/**
 * A body moved by the real client physics (prismarine-physics, the engine mineflayer moves with) and the real route search and executor
 * (mineflayer-pathfinder's plugin), in a small world made of a function from a cell to a block name. Nothing is a server: digging and laying
 * take a few ticks and change the world the way the server would, a block is not laid in a cell the body (as the server last saw it, a tick ago)
 * overlaps, and the world keeps what was changed. For tests; no network, no API.
 *
 * The time is the test's: with fake timers the body moves 50 ms of physics for every 50 ms of fake time (`run`), so a walk of a minute takes the
 * time the route search takes and no more.
 */
const VERSION = '1.21.11';
export const mcData = minecraftData(VERSION);
const Block = (blockLoader as any)(VERSION);
const { Physics, PlayerState } = createRequire(import.meta.url)('prismarine-physics');

export type Ground = (x: number, y: number, z: number) => string | null;
export interface Stack { name: string; count: number }

/**
 * A block by name, with its state when the name has one: `spruce_trapdoor[facing=west,half=bottom,open=true,powered=false,waterlogged=false]` (every state of the block named,
 * in the order minecraft-data lists them; the last one changes fastest).
 */
export function makeBlock(name: string): any {
  const found = /^([a-z_0-9]+)\[(.*)\]$/u.exec(name);
  if (!found) return new Block(mcData.blocksByName[name].id, 0, 0);
  const info = mcData.blocksByName[found[1]!]!;
  const given = Object.fromEntries(found[2]!.split(',').map(pair => pair.split('=') as [string, string]));
  let offset = 0;
  for (const state of info.states ?? []) {
    const values: string[] = state.type === 'bool' ? ['true', 'false'] : state.values.map(String);
    const index = values.indexOf(given[state.name] ?? values[0]!);
    offset = offset * state.num_values + Math.max(0, index);
  }
  return Block.fromStateId(info.minStateId + offset, 0);
}

export function makeSim(ground: Ground, options: { start?: [number, number, number]; items?: Stack[]; digMs?: number; ghost?: (x: number, y: number, z: number) => string | null | undefined } = {}) {
  const changed = new Map<string, string | null>();
  const cache = new Map<string, any>();
  const nameAtCell = (x: number, y: number, z: number): string | null => {
    const key = `${x},${y},${z}`;
    return changed.has(key) ? changed.get(key)! : ground(x, y, z);
  };
  const blockOf = (name: string | null, x: number, y: number, z: number) => {
    if (name === null) return null;
    const key = `${name}@${x},${y},${z}`;
    let block = cache.get(key);
    if (!block) { block = makeBlock(name); block.position = new Vec3(x, y, z); cache.set(key, block); }
    return block;
  };
  const world = {
    getBlock: (position: Vec3) => { const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z); return blockOf(nameAtCell(x, y, z), x, y, z); },
    set: (x: number, y: number, z: number, name: string | null) => { changed.set(`${x},${y},${z}`, name); },
    nameAt: nameAtCell,
    changed,
  };
  // `ghost`: blocks only the physics knows (the body meets them; the route search and the map do not see them), as a server's refusal is.
  const felt = {
    getBlock: (position: Vec3) => {
      const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
      const name = options.ghost?.(x, y, z);
      return name ? blockOf(name, x, y, z) : world.getBlock(position);
    },
  };
  const physics = Physics(mcData, felt);
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
  const bot: any = Object.assign(new EventEmitter(), {
    version: VERSION, registry: mcData, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, health: 20, food: 20,
    game: { minY: -64, dimension: 'overworld', height: 384 }, entities: {} as Record<string, any>,
    inventory: { slots: new Array(46).fill(null), items: () => items.filter(item => item.count > 0) },
    heldItem: null as any,
    entity: { position: new Vec3(start[0], start[1], start[2]), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false,
      isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false, yaw: 0, pitch: 0, effects: {}, attributes: {}, height: 1.8, width: 0.6 },
    controlState: control, physics,
    serverAt: new Vec3(start[0], start[1], start[2]),
    dugBlocks: [] as string[], placedBlocks: [] as string[],
    blockAt: (position: Vec3) => world.getBlock(position),
    getControlState: (name: string) => control[name],
    setControlState: (name: string, value: boolean) => { control[name] = value; },
    clearControlStates: () => { for (const key of Object.keys(control)) control[key] = false; },
    look: async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; },
    lookAt: async (point: Vec3) => {
      const delta = point.minus(bot.entity.position.offset(0, 1.62, 0));
      bot.entity.yaw = Math.atan2(-delta.x, -delta.z); bot.entity.pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
    },
    equip: async (item: any) => { bot.heldItem = item; },
    unequip: async () => { bot.heldItem = null; },
    stopDigging: () => undefined,
    digTime: (block: any) => options.digMs ?? 200,
    dig: async (block: any) => {
      const at = block.position;
      await new Promise(resolve => setTimeout(resolve, options.digMs ?? 200));
      const old = world.getBlock(at);
      world.set(at.x, at.y, at.z, 'air');
      bot.dugBlocks.push(`${old?.name}@${at.x},${at.y},${at.z}`);
      bot.emit('blockUpdate', old, world.getBlock(at));
      bot.emit('diggingCompleted', old);
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
      bot.emit('blockPlaced', old, world.getBlock(dest));
    },
    activateBlock: async () => undefined,
  });
  pathfinder.pathfinder(bot);
  const tick = () => {
    bot.serverAt = bot.entity.position.clone();
    physics.simulatePlayer(new PlayerState(bot, control), felt).apply(bot);
    bot.emit('physicsTick');
  };
  return { bot, world, control, tick, give, items, nameAt: world.nameAt };
}
export type Sim = ReturnType<typeof makeSim>;
