import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

/**
 * A practice ground for the hands that work on blocks (mine, make, smelt): a small world of REAL chunks (prismarine-chunk, prismarine-world,
 * the game's block states and collision shapes), a body moved by the client's own physics (prismarine-physics, 50 ms ticks) and, if asked
 * for, mineflayer-pathfinder's real route search on it. No server and no API. What is real: the blocks, their dig times and harvest tables
 * (minecraft-data / prismarine-block), the recipes (prismarine-recipe), the route search, the reading of the chunks by the body's own map and
 * scans. What is stood in for, as little as it goes: the server's answers to a dig (its block-change packet), an item dropping and being
 * taken, the crafting grid's clicks (the recipe's delta is applied to the pack, at a table in reach), and the furnace's window (slots and
 * a clock of its own). Nothing here is the game's own server, and what a real furnace takes in a second or the real windows do is not tested.
 */
export const VERSION = '1.21.11';
const require_ = createRequire(import.meta.url);
export const mcData = minecraftData(VERSION);
const Chunk = require_('prismarine-chunk')(VERSION);
const World = require_('prismarine-world')(VERSION);
const { Physics, PlayerState } = require_('prismarine-physics');
const Item = require_('prismarine-item')(VERSION);
const { Recipe } = require_('prismarine-recipe')(VERSION);

const stateOf = (name: string): number => {
  const block = mcData.blocksByName[name];
  if (!block) throw new Error(`no block ${name}`);
  return block.defaultState as number;
};
const AIR = stateOf('air');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface Furnace { input: any | null; fuel: any | null; output: any | null; burn: number }
export interface GroundOptions {
  /** Where the body stands (the middle of this cell). */
  at?: [number, number, number];
  /** The stone floor's top: the body stands at y = floor + 1 (default 63: stone below y 64). */
  floor?: number;
  /** Mineflayer-pathfinder's real route search on the body (`bot.pathfinder`). */
  pathfinder?: boolean;
}

export function createGround(options: GroundOptions = {}) {
  const floor = options.floor ?? 63;
  const world = new World(null).sync;
  // 3x3 chunks of stone up to the floor, a thin bed below that (the body does not dig down in these scenes).
  for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
    const column = new Chunk({ minY: -64, worldHeight: 384 });
    const from = cx === 0 && cz === 0 ? floor - 24 : floor - 6;
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = from; y <= floor; y++) column.setBlockStateId(new Vec3(x, y, z), stateOf('stone'));
    world.setColumn(cx, cz, column);
  }
  const blocks = new Map<string, any>();
  const get = (x: number, y: number, z: number) => world.getBlock(new Vec3(x, y, z));
  const nameAt = (x: number, y: number, z: number): string => String(get(x, y, z)?.name ?? 'unloaded');
  const set = (x: number, y: number, z: number, name: string) => { world.setBlockStateId(new Vec3(x, y, z), stateOf(name)); };
  const fill = (a: [number, number, number], b: [number, number, number], name: string) => {
    for (let x = Math.min(a[0], b[0]); x <= Math.max(a[0], b[0]); x++) for (let y = Math.min(a[1], b[1]); y <= Math.max(a[1], b[1]); y++) for (let z = Math.min(a[2], b[2]); z <= Math.max(a[2], b[2]); z++) set(x, y, z, name);
  };

  // --- the pack: slots 9..44 as in the game; a stack never exceeds the item's size
  const slots: any[] = new Array(46).fill(null);
  const itemsIn = () => slots.slice(9, 45).filter(Boolean);
  const countOf = (name: string) => itemsIn().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
  const give = (name: string, count: number) => {
    const info = mcData.itemsByName[name];
    if (!info) throw new Error(`no item ${name}`);
    let left = count;
    for (let slot = 9; slot <= 44 && left > 0; slot++) {
      const held = slots[slot];
      if (held && held.name === name && held.count < info.stackSize) { const put = Math.min(left, info.stackSize - held.count); held.count += put; left -= put; }
    }
    for (let slot = 9; slot <= 44 && left > 0; slot++) {
      if (!slots[slot]) { const put = Math.min(left, info.stackSize); const stack = new Item(info.id, put); stack.slot = slot; slots[slot] = stack; left -= put; }
    }
    return count - left;
  };
  const take = (name: string, count: number) => {
    let left = count;
    for (let slot = 9; slot <= 44 && left > 0; slot++) {
      const held = slots[slot];
      if (held && held.name === name) { const out = Math.min(left, held.count); held.count -= out; left -= out; if (held.count <= 0) slots[slot] = null; }
    }
    return count - left;
  };

  const control: Record<string, boolean> = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  const [sx, sy, sz] = options.at ?? [8, floor + 1, 8];
  const client = Object.assign(new EventEmitter(), { prependListener: EventEmitter.prototype.prependListener });
  const entities: Record<number, any> = {};
  let nextEntity = 100;
  const bot: any = Object.assign(new EventEmitter(), {
    version: VERSION, jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0, health: 20, food: 20, game: { dimension: 'overworld' },
    registry: mcData, world, entities, _client: client, supportFeature: (feature: string) => (mcData as any).supportFeature(feature),
    inventory: { slots, items: itemsIn, count: (type: number) => itemsIn().filter(item => item.type === type).reduce((sum, item) => sum + item.count, 0) },
    heldItem: null as any, quickBarSlot: 0, currentWindow: null as any,
    entity: { id: 1, name: 'player', type: 'player', position: new Vec3(sx + 0.5, sy, sz + 0.5), velocity: new Vec3(0, 0, 0), onGround: true, isInWater: false, isInLava: false, isInWeb: false,
      isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false, yaw: 0, pitch: 0, effects: {}, attributes: {}, height: 1.8, width: 0.6 },
    getControlState: (name: string) => control[name], setControlState: (name: string, value: boolean) => { control[name] = value; },
    clearControlStates: () => { for (const key of Object.keys(control)) control[key] = false; },
    blockAt: (position: Vec3) => world.getBlock(position.floored()),
    controlState: control,
    _updateBlockState: (position: Vec3, stateId: number) => { world.setBlockStateId(position, stateId); },
    reflexLedger: undefined,
  });
  const physics = Physics(mcData, world);
  bot.physics = physics;
  bot.look = async (yaw: number, pitch: number) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; };
  bot.lookAt = async (point: Vec3) => {
    const eye = bot.entity.position.offset(0, 1.62, 0), delta = point.minus(eye);
    bot.entity.yaw = Math.atan2(-delta.x, -delta.z); bot.entity.pitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
  };

  // --- equipping, digging and what drops (the server's side, stood in for)
  bot.equip = async (item: any) => { bot.heldItem = item; bot.emit('heldItemChanged', item); };
  bot.unequip = async () => { bot.heldItem = null; bot.emit('heldItemChanged', null); };
  bot.digTime = (block: any) => Number(block.digTime(bot.heldItem?.type ?? null, false, false, false, [], {}));
  const dugLog: Array<{ x: number; y: number; z: number; name: string; tool: string; harvested: boolean }> = [];
  bot.stopDigging = () => undefined;
  bot.dig = async (block: any) => {
    const position = block.position as Vec3;
    const real = bot.digTime(block);
    await sleep(Math.min(40, real));
    const harvested = block.canHarvest(bot.heldItem?.type ?? null);
    const name = String(block.name);
    // The server says the block is gone (digBlockVerified waits for exactly this), then the library writes air into its own world.
    client.emit('block_change', { location: position, type: AIR });
    world.setBlockStateId(position, AIR);
    dugLog.push({ x: position.x, y: position.y, z: position.z, name, tool: bot.heldItem?.name ?? 'hand', harvested });
    if (bot.heldItem && bot.heldItem.maxDurability) bot.heldItem.durabilityUsed = (bot.heldItem.durabilityUsed ?? 0) + 1;
    bot.emit('diggingCompleted', block);
    if (bot.heldItem?.maxDurability && bot.heldItem.durabilityUsed >= bot.heldItem.maxDurability) {
      // The tool breaks.
      slots[bot.heldItem.slot] = null; bot.heldItem = null; bot.emit('heldItemChanged', null);
    }
    if (harvested) for (const dropId of block.drops ?? mcData.blocksByName[name].drops ?? []) drop(String(mcData.items[dropId.drop ?? dropId].name), 1, position);
  };
  const drop = (name: string, count: number, at: Vec3) => {
    const id = nextEntity++;
    const stack = new Item(mcData.itemsByName[name].id, count);
    entities[id] = { id, name: 'item', type: 'object', displayName: 'Item', position: new Vec3(at.x + 0.5, at.y + 0.25, at.z + 0.5), velocity: new Vec3(0, 0, 0), getDroppedItem: () => stack, metadata: [] };
  };
  const dropped = () => Object.values(entities).filter((entity: any) => entity.name === 'item');

  // --- placing (a block set against a face)
  const placeLog: Array<{ x: number; y: number; z: number; name: string }> = [];
  bot.placeBlock = async (reference: any, face: Vec3) => {
    const target = reference.position.plus(face);
    await sleep(30);
    const held = bot.heldItem;
    if (!held) throw new Error('nothing in hand');
    const blockInfo = mcData.blocksByName[held.name];
    if (!blockInfo) throw new Error(`${held.name} is not a block`);
    world.setBlockStateId(target, blockInfo.defaultState);
    placeLog.push({ x: target.x, y: target.y, z: target.z, name: held.name });
    take(held.name, 1);
    if (!slots[held.slot]) { bot.heldItem = null; }
    bot.emit(`blockUpdate:${target}`, null, world.getBlock(target));
  };

  // --- crafting: mineflayer's own recipesAll over the real recipes; the grid's clicks become the recipe's delta, at a table in reach
  bot.recipesAll = (itemType: number, metadata: number | null, craftingTable: unknown) =>
    (Recipe.find(itemType, metadata) as any[]).filter(recipe => !recipe.requiresTable || craftingTable);
  const craftLog: Array<{ item: string; times: number; table: boolean }> = [];
  bot.craft = async (recipe: any, count: number, table?: any) => {
    if (recipe.requiresTable && !table) throw new Error('Recipe requires craftingTable, but one was not supplied');
    if (table && bot.entity.position.distanceTo(table.position.offset(0.5, 0.5, 0.5)) > 6) throw new Error('the crafting table is out of reach of the server');
    await sleep(20 * count);
    for (let time = 0; time < count; time++) {
      for (const entry of recipe.delta) if (entry.count < 0 && countOf(String(mcData.items[entry.id].name)) < -entry.count) throw new Error('missing ingredient for the craft');
      for (const entry of recipe.delta) {
        const name = String(mcData.items[entry.id].name);
        if (entry.count < 0) take(name, -entry.count);
        else if (give(name, entry.count) < entry.count) throw new Error('inventory full');
      }
    }
    craftLog.push({ item: String(mcData.items[recipe.result.id].name), times: count, table: !!table });
  };

  // --- furnaces: the window's slots, with a burn clock of its own
  const furnaces = new Map<string, Furnace>();
  const furnaceAt = (position: Vec3): Furnace => {
    const key = `${position.x},${position.y},${position.z}`;
    if (!furnaces.has(key)) furnaces.set(key, { input: null, fuel: null, output: null, burn: 0 });
    return furnaces.get(key)!;
  };
  bot.openFurnace = async (block: any) => {
    if (bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 6) throw new Error('the furnace is out of reach of the server');
    await sleep(15);
    const state = furnaceAt(block.position);
    const view = (stack: any) => stack ? { name: stack.name, count: stack.count, type: stack.type } : null;
    const move = (name: string, count: number, slot: 'input' | 'fuel') => {
      const have = countOf(name);
      const put = Math.min(count, have);
      if (put <= 0) return;
      take(name, put);
      const current = state[slot];
      state[slot] = current ? { ...current, count: current.count + put } : { name, count: put, type: mcData.itemsByName[name].id };
    };
    return {
      type: 'minecraft:furnace', fuel: state.burn, progress: 0,
      inputItem: () => view(state.input), fuelItem: () => view(state.fuel), outputItem: () => view(state.output),
      putInput: async (type: number, _meta: unknown, count: number) => { await sleep(10); const name = String(mcData.items[type].name); if (state.input && state.input.name !== name) throw new Error('input slot is taken'); move(name, count, 'input'); },
      putFuel: async (type: number, _meta: unknown, count: number) => { await sleep(10); move(String(mcData.items[type].name), count, 'fuel'); },
      takeInput: async () => { const stack = state.input; if (stack) { give(stack.name, stack.count); state.input = null; } return stack; },
      takeFuel: async () => { const stack = state.fuel; if (stack) { give(stack.name, stack.count); state.fuel = null; } return stack; },
      takeOutput: async () => { const stack = state.output; if (stack) { give(stack.name, stack.count); state.output = null; } return stack; },
      close: () => undefined,
      on: () => undefined, removeListener: () => undefined,
    };
  };
  bot.closeWindow = () => { bot.currentWindow = null; };

  // --- the clock: physics every 50 ms, and what the body takes up (the server's pickup)
  const withinTake = (item: Vec3) => Math.abs(item.x - bot.entity.position.x) <= 1.4 && Math.abs(item.z - bot.entity.position.z) <= 1.4
    && item.y >= bot.entity.position.y - 0.7 && item.y <= bot.entity.position.y + 2.3;
  let timer: ReturnType<typeof setInterval> | null = null;
  const tick = () => {
    physics.simulatePlayer(new PlayerState(bot, control), world).apply(bot);
    bot.emit('physicsTick');
    for (const entity of dropped() as any[]) {
      if (!withinTake(entity.position)) continue;
      const stack = entity.getDroppedItem();
      if (give(stack.name, stack.count) > 0) { delete entities[entity.id]; bot.emit('playerCollect', bot.entity, entity); }
    }
  };
  const start = () => { if (!timer) timer = setInterval(tick, 50); };
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  if (options.pathfinder) {
    const { pathfinder } = require_('mineflayer-pathfinder');
    bot.loadPlugin = (plugin: (bot: unknown) => void) => plugin(bot);
    bot.loadPlugin(pathfinder);
  }
  void blocks;
  return { bot, world, mcData, set, get, nameAt, fill, give, take, countOf, drop, dropped, dugLog, placeLog, craftLog, furnaceAt, furnaces, tick, start, stop, control, slots };
}
export type Ground = ReturnType<typeof createGround>;

/** A StepContext for a hand: nothing stops it but the signal given, and 30 s of time. */
export function stepContext(bot: any, signal: AbortSignal = new AbortController().signal, seconds = 30) {
  const feet = { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y + 1e-3), z: Math.floor(bot.entity.position.z) };
  return { bot, stop: signal, deadline: Date.now() + seconds * 1000, facing: 'north' as const, base: feet };
}
