import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

// Run 24 and the contract with the mind (codex/shannon/mb-r24-head):
//   - facts: `alive` is false only for a body known dead (a body back in after a drop has no health yet); `dimension` is the server's word after a
//     portal; the digs the server did not confirm and the state of the link are told;
//   - the map: lava pools by size and top ("（水源12個・岩に覆われている）"), structures built of wood (shipwreck, mineshaft, mansion, outpost).

vi.mock('../../src/services/minebot/execution/observedWait.js', async (original) => ({
  ...(await original() as object), actionDelay: vi.fn(async () => {}),
}));

const { NativeCommonFcaBody } = await import('../../src/services/minebot/integration/commonFca/nativeBody.js');
const { dimensionOfPacket, installDimensionKeeper } = await import('../../src/services/minebot/utils/dimensionKeeper.js');
const { installLinkWatch } = await import('../../src/services/minebot/utils/linkWatch.js');
const { emptyPlaceMemory, mapSummary, rememberPlace, mergeRadius } = await import('../../src/modules/minecraftLearning/places.js');
const { installPlaceMemory } = await import('../../src/services/minebot/utils/placeMemory.js');
const registry = minecraftData('1.21.11');

function body(extra: Record<string, unknown> = {}) {
  const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, position: new Vec3(0, 65, 0), yaw: 0, pitch: 0, onGround: true },
    health: 20, food: 20, oxygenLevel: 20, game: { dimension: 'overworld' }, entities: {}, inventory: { items: () => [] }, controlState: {},
    instantSkills: { getSkills: () => [] }, executingSkill: false, interruptExecution: false,
    clearControlStates: vi.fn(), setControlState: vi.fn(), look: vi.fn(async () => {}), attack: vi.fn(), ...extra });
  return { bot, native: new NativeCommonFcaBody(bot, { serverId: 'home', capture: async () => { throw Error('unused'); } }) };
}

describe('the facts the mind reads (stage: reconnect, portal, digs, link)', () => {
  it('a body back in after a drop (no health yet) is not dead; one at health 0 is', () => {
    const { bot, native } = body();
    expect(native.observe().facts.alive).toBe(true);
    bot.health = undefined;
    expect(native.observe().facts.alive).toBe(true);
    bot.health = 0;
    expect(native.observe().facts.alive).toBe(false);
    bot.health = 0.5;
    expect(native.observe().facts.alive).toBe(true);
  });

  it('tells the digs the server did not confirm, in all and lately, and whether the link is behind', () => {
    const { bot, native } = body();
    expect(native.observe().facts).toMatchObject({ digRestored: 0, digRestoredRecent: 0, linkBehind: false });
    bot.ghostBlocksRestored = 12;
    bot.digUnconfirmedRecent = () => 5;
    expect(native.observe().facts).toMatchObject({ digRestored: 12, digRestoredRecent: 5 });
    // a link whose keep-alive was heard and not answered for over three seconds is behind
    const client: any = Object.assign(new EventEmitter(), { write: vi.fn() });
    let clock = 1_000;
    const link = installLinkWatch(Object.assign(new EventEmitter(), { _client: client }) as any, { now: () => clock, checkMs: 1e9 })!;
    bot.__link = link;
    client.emit('keep_alive', { keepAliveId: 1n });
    clock += 5_000;
    expect(link.behind()).toBe(true);
  });

  it('says the dimension the server names, and how long ago it changed', () => {
    const client = new EventEmitter();
    const { bot, native } = body({ _client: client });
    installDimensionKeeper(bot, () => 50_000);
    expect(native.observe().facts.dimensionSinceSec).toBeNull();
    // mineflayer's own reading left the dimension as it was (the registry entry for the number was not found)
    client.emit('respawn', { worldState: { dimension: 2, name: 'minecraft:the_nether' } });
    expect(bot.game.dimension).toBe('the_nether');
    expect(native.observe().facts.dimension).toBe('the_nether');
    expect(typeof native.observe().facts.dimensionSinceSec).toBe('number');
    // the same word again is no change; a packet with no name changes nothing
    const first = bot.dimensionChange.at;
    client.emit('respawn', { worldState: { name: 'minecraft:the_nether' } });
    client.emit('respawn', { worldState: { dimension: 1 } });
    expect(bot.dimensionChange.at).toBe(first);
    expect(bot.game.dimension).toBe('the_nether');
    expect(dimensionOfPacket({ worldState: { name: 'minecraft:overworld' } })).toBe('overworld');
    expect(dimensionOfPacket({ dimension: 'minecraft:the_end' })).toBe('the_end');
    expect(dimensionOfPacket({ worldState: { dimension: 3 } })).toBeNull();
  });
});

describe('the map: lava pools by size and top, and the structures that are wood (the contract with the mind)', () => {
  it('each pool says "（水源N個・岩に覆われている／覆われていない）", covered and open together, nearest first', () => {
    const state = emptyPlaceMemory();
    rememberPlace(state, { kind: 'lava', dimension: 'overworld', position: { x: 82, y: 70, z: 0 }, count: 12 }, 1);
    rememberPlace(state, { kind: 'lava_covered', dimension: 'overworld', position: { x: 29, y: 70, z: 0 }, count: 6 }, 1);
    const map = mapSummary(state, { x: 0, y: 70, z: 0 }, 'overworld');
    expect(map).toContain('溶岩の溜まり 2か所: ');
    expect(map).toMatch(/29m \S+ \(29,70,0\) 地表 ×6（水源6個・岩に覆われている）/);
    expect(map).toMatch(/82m \S+ \(82,70,0\) 地表 ×12（水源12個・岩に覆われていない）/);
    expect(map.indexOf('(29,70,0)')).toBeLessThan(map.indexOf('(82,70,0)'));
    // a pool of one source says "水源1個"
    const one = emptyPlaceMemory();
    rememberPlace(one, { kind: 'lava', dimension: 'overworld', position: { x: 5, y: 60, z: 0 } }, 1);
    expect(mapSummary(one, { x: 0, y: 70, z: 0 }, 'overworld')).toContain('（水源1個・岩に覆われていない）');
  });

  it('names the shipwreck, the old mine, the mansion and the outpost as structures, and as wood', () => {
    const state = emptyPlaceMemory();
    rememberPlace(state, { kind: 'shipwreck', dimension: 'overworld', position: { x: 47, y: 55, z: 99 } }, 1);
    rememberPlace(state, { kind: 'mineshaft', dimension: 'overworld', position: { x: -60, y: 70, z: 20 } }, 1);
    rememberPlace(state, { kind: 'mansion', dimension: 'overworld', position: { x: 300, y: 70, z: 0 } }, 1);
    rememberPlace(state, { kind: 'outpost', dimension: 'overworld', position: { x: 0, y: 75, z: -200 } }, 1);
    rememberPlace(state, { kind: 'village', dimension: 'overworld', position: { x: 230, y: 70, z: 0 } }, 1);
    const map = mapSummary(state, { x: 0, y: 70, z: 0 }, 'overworld');
    for (const word of ['難破船: ', '廃坑: ', '森の洋館: ', '前哨基地: ', '村: ']) expect(map).toContain(word);
    expect(map.match(/［原木・板材あり］/g)).toHaveLength(4);
    expect(map).toMatch(/廃坑: 63m 西 \(-60,70,20\)/);
    expect(mergeRadius('mineshaft')).toBe(48);
  });

  it('the world read from a real column: rails are an old mine, lava under rock is a covered pool, lava under air an open one', async () => {
    const Chunk = (await import('prismarine-chunk')).default('1.21.11') as any;
    const chunk = new Chunk({ minY: -64, worldHeight: 384 });
    const set = (x: number, y: number, z: number, name: string) => chunk.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].defaultState);
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 20; y <= 30; y++) set(x, y, z, 'stone');
    // an old mine's rails, a lava pool of four under a roof of stone, and a lava source open to the air
    set(3, 31, 3, 'rail'); set(4, 31, 3, 'rail'); set(5, 31, 3, 'rail');
    for (const [x, z] of [[8, 8], [9, 8], [8, 9], [9, 9]]) set(x, 25, z, 'lava');
    set(2, 60, 14, 'lava');
    const bot: any = Object.assign(new EventEmitter(), { entity: { position: new Vec3(8, 70, 8) }, registry, game: { dimension: 'overworld' },
      world: { getColumns: () => [{ chunkX: 0, chunkZ: 0, column: chunk }], getColumn: (x: number, z: number) => (x === 0 && z === 0 ? chunk : undefined) } });
    installPlaceMemory(bot);
    bot.placeMemory.work(5000);
    const places = bot.placeMemory.state.places as Array<{ kind: string; count?: number }>;
    expect(places.find(place => place.kind === 'mineshaft')).toBeTruthy();
    expect(places.find(place => place.kind === 'lava_covered')?.count).toBe(4);
    expect(places.find(place => place.kind === 'lava')?.count ?? 1).toBe(1);
    const map: string = bot.placeMemory.map();
    expect(map).toContain('廃坑: ');
    expect(map).toContain('（水源4個・岩に覆われている）');
    expect(map).toContain('（水源1個・岩に覆われていない）');
  });
});
