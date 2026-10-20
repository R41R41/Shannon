import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

vi.mock('../../src/services/minebot/execution/observedWait.js', async (original) => ({
  ...(await original() as object), actionDelay: vi.fn(async () => {}),
}));
vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: vi.fn(async () => ({ success: false })) }));

const { biomesAround, describeBiomes, emptyPlaceMemory, mapSummary, noteBiome, parsePlaceMemory, placesDigest, rememberPlace } = await import('../../src/modules/minecraftLearning/places.js');
const { installPlaceMemory } = await import('../../src/services/minebot/utils/placeMemory.js');
const { animalProspect, prospectNote } = await import('../../src/services/minebot/utils/biomeProspects.js');
const { default: ExploreForStructure } = await import('../../src/services/minebot/instantSkills/exploreForStructure.js');
const { default: StartSmelting } = await import('../../src/services/minebot/instantSkills/startSmelting.js');
const { default: AttackContinuously } = await import('../../src/services/minebot/instantSkills/attackContinuously.js');
const { executeAction, physicalActionBusy } = await import('../../src/services/minebot/execution/ActionExecution.js');
const { NativeCommonFcaBody } = await import('../../src/services/minebot/integration/commonFca/nativeBody.js');

const registry = minecraftData('1.21.11');
const at = { x: 0, y: 64, z: 0 };

describe('the remembered bed and village say what they are good for (run 19: an igloo bed in mind for 64 decisions, never taken)', () => {
  it('a placed bed says it can be dug and carried, and is one bed, not "×2"', () => {
    const state = emptyPlaceMemory();
    rememberPlace(state, { kind: 'bed', dimension: 'overworld', position: { x: 69, y: 66, z: 4 }, count: 2 }, 1);
    rememberPlace(state, { kind: 'village', dimension: 'overworld', position: { x: 287, y: 85, z: 13 } }, 1);
    const digest = placesDigest(state, at, 'overworld');
    expect(digest.bed).toBe('69m 東 (69,66,4) 置かれたベッド: dig-block-at takeEquipment=true で掘れば持てる');
    expect(digest.village).toContain('羊・ベッド・食べ物がある見込み');
  });
  it('says nothing of the kind for the body\'s own respawn bed, and shows the bed to take past it', () => {
    const state = emptyPlaceMemory();
    rememberPlace(state, { kind: 'bed', dimension: 'overworld', position: { x: 5, y: 64, z: 0 }, keep: 'respawn', note: 'リスポーン地点' }, 1);
    expect(placesDigest(state, at, 'overworld').bed).not.toContain('掘れば持てる');
    rememberPlace(state, { kind: 'bed', dimension: 'overworld', position: { x: 69, y: 66, z: 4 }, count: 2 }, 1);
    const digest = placesDigest(state, at, 'overworld');
    expect(digest.bed).toContain('(69,66,4)');
    expect(digest.bed).toContain('掘れば持てる');
  });
});

describe('the biomes passed through are kept and said, each by its nearest column (run 19: only the one stood in was ever said)', () => {
  it('nearest column of each biome, the one underfoot first, with direction and distance', () => {
    const state = emptyPlaceMemory();
    noteBiome(state, 'overworld', 0, 0, 'snowy_plains');
    noteBiome(state, 'overworld', -8, 0, 'badlands');     // 120 m west
    noteBiome(state, 'overworld', 0, 4, 'frozen_ocean');  // 72 m south
    noteBiome(state, 'overworld', -9, 0, 'badlands');
    const areas = biomesAround(state, { x: 8, y: 64, z: 8 }, 'overworld');
    expect(describeBiomes(areas)).toBe('snowy_plains（ここ）・frozen_ocean 南 64m・badlands 西 128m');
  });
  it('is kept on disk and read back, and the oldest go first past the cap', () => {
    const state = emptyPlaceMemory();
    noteBiome(state, 'overworld', 1, 2, 'plains');
    const back = parsePlaceMemory(JSON.parse(JSON.stringify(state)));
    expect(back.biomes).toEqual({ overworld: { '1,2': 'plains' } });
    expect(parsePlaceMemory({ version: 1, places: [], biomes: { overworld: { 'x,y': 'plains', '3,4': 'Not A Biome' } } }).biomes).toBeUndefined();
  });
  it('a column read is noted with the biome it holds itself; one without that biome section is not noted (no "badlands" for id 0)', () => {
    const column = (withBiome: boolean) => ({ minY: -64, sections: new Array(24).fill({ data: { palette: [0], get: () => 0 } }),
      biomes: new Array(24).fill(null).map((_, index) => withBiome || index !== 8 ? {} : null), getBiome: () => registry.biomesByName.plains.id });
    const columns = [{ chunkX: 0, chunkZ: 0, column: column(true) }, { chunkX: 1, chunkZ: 0, column: column(false) }];
    const bot: any = Object.assign(new EventEmitter(), { entity: { position: new Vec3(8, 64, 8) }, registry, game: { dimension: 'overworld' },
      world: { getColumns: () => columns, getColumn: (x: number, z: number) => columns.find(entry => entry.chunkX === x && entry.chunkZ === z)?.column } });
    installPlaceMemory(bot);
    bot.placeMemory.work(1000);
    expect(bot.placeMemory.state.biomes).toEqual({ overworld: { '0,0': 'plains' } });
  });

  it('the place memory says the line, read again only after a few seconds or blocks', () => {
    const bot: any = Object.assign(new EventEmitter(), { entity: { position: new Vec3(8, 64, 8) }, registry: { blocksByName: {} }, game: { dimension: 'overworld' } });
    installPlaceMemory(bot);
    noteBiome(bot.placeMemory.state, 'overworld', 0, 0, 'snowy_plains');
    expect(bot.placeMemory.biomes()).toBe('snowy_plains（ここ）');
    noteBiome(bot.placeMemory.state, 'overworld', 5, 0, 'plains');
    expect(bot.placeMemory.biomes()).toBe('snowy_plains（ここ）');            // within the five seconds
    bot.entity.position = new Vec3(40, 64, 8);
    expect(bot.placeMemory.biomes()).toContain('plains 東');
  });
});

describe('the map: structures, caves and lava read from the loaded world, and said for a route planner (owner, 2026-10-20)', () => {
  const columnWith = async () => {
    const Chunk = (await import('prismarine-chunk')).default('1.21.11') as any;
    const chunk = new Chunk({ minY: -64, worldHeight: 384 });
    const set = (x: number, y: number, z: number, name: string) => chunk.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].defaultState);
    // A ruined portal: netherrack, crying obsidian, two obsidian of its frame and its chest.
    set(3, 69, 3, 'netherrack'); set(4, 69, 3, 'netherrack'); set(5, 70, 3, 'crying_obsidian'); set(3, 70, 3, 'obsidian'); set(3, 71, 3, 'obsidian'); set(6, 70, 5, 'chest');
    // An igloo's floor; a lone carpet on grass is not one.
    set(10, 69, 10, 'snow_block'); set(10, 70, 10, 'white_carpet'); set(14, 69, 1, 'grass_block'); set(14, 70, 1, 'white_carpet');
    // A shipwreck's chest with water beside it, a lava pool open to the air.
    set(12, 40, 12, 'chest'); set(13, 40, 12, 'water'); set(1, 60, 14, 'lava');
    // A cave: a section of stone (y -32..-17) with a hollow of 1,000 cells.
    for (let x = 0; x < 16; x++) for (let y = -32; y <= -17; y++) for (let z = 0; z < 16; z++) {
      set(x, y, z, x >= 2 && x < 12 && y >= -30 && y < -20 && z >= 2 && z < 12 ? 'air' : 'stone');
    }
    return chunk;
  };
  const bodyWith = (chunk: any, dimension = 'overworld') => Object.assign(new EventEmitter(), { entity: { position: new Vec3(8, 70, 8) }, registry,
    game: { dimension }, world: { getColumns: () => [{ chunkX: 0, chunkZ: 0, column: chunk }], getColumn: (x: number, z: number) => x === 0 && z === 0 ? chunk : undefined } }) as any;

  it('reads a ruined portal, an igloo, a shipwreck, a cave and obsidian from a real 1.21.11 column, and the map says each with its chest', async () => {
    const bot = bodyWith(await columnWith());
    installPlaceMemory(bot);
    bot.placeMemory.work(5000);
    const kinds = new Set(bot.placeMemory.state.places.map((place: any) => place.kind));
    for (const kind of ['ruined_portal', 'obsidian', 'igloo', 'shipwreck', 'cave', 'lava', 'chest']) expect(kinds).toContain(kind);
    expect(bot.placeMemory.state.places.filter((place: any) => place.kind === 'igloo')).toHaveLength(1);
    expect(bot.placeMemory.state.places.find((place: any) => place.kind === 'cave').count).toBe(1000);
    const map: string = bot.placeMemory.map();
    expect(map).toContain('荒廃したポータル: ');
    expect(map).toMatch(/荒廃したポータル: \d+m \S+ \(\d+,\d+,\d+\)（黒曜石2個・箱 \(6,70,5\): 火打石と打ち金・黒曜石が入ることがある）/);
    expect(map).toContain('イグルー: ');
    expect(map).toContain('難破船: ');
    expect(map).toMatch(/洞窟 1か所（うち大きな空洞0）: \d+m \S+ \(\d+,-\d+,\d+\) 約1000マス/);
    expect(map).toContain('溶岩の溜まり 1か所: ');
    expect(map).toContain('地表');
  });
  it('in the Nether netherrack is the ground, not a ruined portal, and no caves are counted', async () => {
    const bot = bodyWith(await columnWith(), 'the_nether');
    installPlaceMemory(bot);
    bot.placeMemory.work(5000);
    const kinds = new Set(bot.placeMemory.state.places.map((place: any) => place.kind));
    expect(kinds).toContain('ruined_portal');   // the crying obsidian still is one
    expect(bot.placeMemory.state.places.filter((place: any) => place.kind === 'ruined_portal')[0].count ?? 1).toBe(1);
    expect(kinds).not.toContain('cave');
  });
  it('a village says its smith\'s chest, ores are counted with the nearest few, and the whole stays within 3,000 characters', () => {
    const state = emptyPlaceMemory();
    const now = 1;
    rememberPlace(state, { kind: 'village', dimension: 'overworld', position: { x: 171, y: 70, z: 0 } }, now);
    rememberPlace(state, { kind: 'grindstone', dimension: 'overworld', position: { x: 180, y: 70, z: 10 } }, now);
    rememberPlace(state, { kind: 'chest', dimension: 'overworld', position: { x: 182, y: 70, z: 12 }, note: '中身: iron_ingot×5 obsidian×3' }, now);
    for (let i = 0; i < 400; i++) rememberPlace(state, { kind: i % 2 ? 'iron_ore' : 'coal_ore', dimension: 'overworld', position: { x: (i % 40) * 20 - 400, y: 30, z: Math.floor(i / 40) * 20 - 100 } }, now);
    for (let column = 0; column < 30; column++) noteBiome(state, 'overworld', column - 15, 0, ['plains', 'forest', 'desert', 'snowy_plains', 'badlands', 'savanna', 'taiga', 'swamp', 'jungle', 'river'][column % 10]);
    const map = mapSummary(state, { x: 0, y: 70, z: 0 }, 'overworld');
    expect(map).toContain('村: 171m 東 (171,70,0)（鍛冶屋の箱 (182,70,12) 中身: iron_ingot×5 obsidian×3: 鉄・黒曜石が入ることがある）');
    expect(map).toMatch(/鉄 200か所（\d+m \S+ \(-?\d+,30,-?\d+\)、\d+m/);
    expect(map).toContain('バイオーム: ');
    expect(map.length).toBeLessThanOrEqual(3000);
    expect(mapSummary(state, { x: 0, y: 70, z: 0 }, 'overworld', { maxCharacters: 300 }).length).toBeLessThanOrEqual(300);
  });
});

describe('explore-for-structure: a bed, and the prospect of finding animals where it went (run 19)', () => {
  const explorer = (extra: Record<string, unknown> = {}) => {
    const bot: any = { entity: { position: new Vec3(62, 70, 14), yaw: 0 }, entities: {}, registry, game: { dimension: 'overworld' }, ...extra };
    const skill: any = new ExploreForStructure(bot);
    skill.callSkill = vi.fn(async () => ({ success: false, result: 'blocked' }));
    return { skill, bot };
  };
  it('a bed in mind is said at once, with how to take it; the body\'s own bed is not', async () => {
    const recall = vi.fn(() => [{ keep: 'respawn', distance: 3, direction: '北', position: { x: 62, y: 70, z: 11 } },
      { distance: 13, direction: '北東', position: { x: 69, y: 66, z: 4 } }]);
    const { skill } = explorer({ placeMemory: { recall } });
    const result = await skill.runImpl('bed', 'north');
    expect(result).toMatchObject({ success: true });
    expect(result.result).toContain('座標(69, 66, 4)');
    expect(result.result).toContain('takeEquipment=true');
    expect(skill.callSkill).not.toHaveBeenCalled();
  });
  it('a bed in the loaded chunks that is the body\'s own is passed over for another', async () => {
    const own = { kind: 'bed', keep: 'respawn', position: { x: 62, y: 70, z: 11 } };
    const columns = [{ chunkX: 3, chunkZ: 0, column: { minY: -64, sections: new Array(24).fill(null).map((_, index) => index === 8 ? {
      data: { palette: [registry.blocksByName.red_bed.minStateId], get: (cell: number) => cell === 11 * 16 + 14 || cell === 0 ? registry.blocksByName.red_bed.minStateId : 0 } } : null) } }];
    // red_bed cells: (48, 64, 0) and (62, 64, 11)... the own one is at (62, 70, 11) in memory: only the one within 2 blocks is passed over.
    const { skill } = explorer({ placeMemory: { recall: () => [], state: { places: [{ ...own, position: { x: 62, y: 64, z: 11 } }] } }, world: { getColumns: () => columns } });
    const result = await skill.runImpl('bed', 'north', 48);
    expect(result).toMatchObject({ success: true });
    expect(result.result).toContain('座標(48, 64, 0)');
  });
  it('no sheep: says which biomes passed were poor for them, the grass in mind, and the village', async () => {
    const memory = { state: emptyPlaceMemory(), recall: (kind?: string) => kind === 'village' ? [{ distance: 171, direction: '東', position: { x: 287, y: 85, z: 13 } }] : [] };
    noteBiome(memory.state, 'overworld', 12, 0, 'plains');
    const { skill } = explorer({ placeMemory: memory, world: { getBiome: () => registry.biomesByName.snowy_plains.id } });
    const result = await skill.runImpl('sheep', 'south', 96);
    expect(result).toMatchObject({ success: false, failureType: 'target_not_found' });
    expect(result.result).toContain('通ったバイオーム: snowy_plains');
    expect(result.result).toContain('snowy_plainsには羊がほとんど出ない');
    expect(result.result).toContain('羊の出る plains は記憶では東');
    expect(result.result).toContain('村（羊・ベッド・食べ物がある見込み）は東 171m');
  });
  it('reads a biome as good, poor or unknown for a kind', () => {
    expect(animalProspect('sheep', 'plains')).toBe('good');
    expect(animalProspect('sheep', 'frozen_ocean')).toBe('poor');
    expect(animalProspect('sheep', 'badlands')).toBe('poor');
    expect(animalProspect('rabbit', 'snowy_plains')).toBe('good');
    expect(prospectNote('sheep', ['sheep'], [], undefined, at, 'overworld')).toBe('');
  });
});

describe('start-smelting says the coal to hand when it burns wood (run 19 D15: six logs burned, coal ore 12 m off)', () => {
  const smelter = (items: any[], hits: any[] = []) => {
    const bot: any = { version: '1.21.11', registry, entity: { position: new Vec3(116, 50, -28) }, inventory: { items: () => items },
      world: { getColumns: () => [] } };
    const skill: any = new StartSmelting(bot);
    return { skill, bot };
  };
  it('names the coal carried, and says nothing for coal itself', () => {
    const { skill } = smelter([{ name: 'coal', count: 3 }]);
    expect(skill.coalNote('spruce_log')).toContain('石炭・木炭を3個持っています');
    expect(skill.coalNote('coal')).toBe('');
  });
  it('without coal in the pack or near, nothing is said', () => {
    const { skill } = smelter([{ name: 'spruce_log', count: 8 }]);
    expect(skill.coalNote('spruce_log')).toBe('');
  });
});

describe('attack-continuously lets a target in the water go (run 19: salmon in a frozen sea, about 400 s for four)', () => {
  it('a salmon in the water that no blow reaches is let go after a few seconds, and said', async () => {
    let clock = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 500));
    try {
      const salmon: any = { id: 2, name: 'salmon', position: new Vec3(12.5, 60, 0.5), height: 0.4, isValid: true };
      const bot: any = { registry, entity: { id: 1, position: new Vec3(0.5, 61, 0.5), isInWater: true, height: 1.8 }, health: 20, food: 20,
        entities: { 2: salmon }, inventory: { items: () => [], slots: [] }, heldItem: null, equip: async () => {},
        setControlState: () => {}, clearControlStates: () => {}, pathfinder: { stop: () => {}, setGoal: () => {} }, lookAt: async () => {}, attack: async () => {},
        nearestEntity: (match: (entity: any) => boolean) => [salmon].filter(entity => match(entity))[0] ?? null,
        blockAt: (p: Vec3) => ({ name: p.y <= 62 ? 'water' : 'air', boundingBox: 'empty', position: p }) };
      const result: any = await (new AttackContinuously(bot) as any).runImpl('salmon', 30, 24, 1);
      expect(result).toMatchObject({ success: false });
      expect(result.result).toContain('水中のsalmonは追いきれず');
    } finally { now.mockRestore(); }
  });
  const sea = (entities: any[]) => ({ registry, entity: { id: 1, position: new Vec3(0.5, 61, 0.5), isInWater: true, height: 1.8 }, health: 20, food: 20,
    entities: Object.fromEntries(entities.map(entity => [entity.id, entity])), inventory: { items: () => [], slots: [] }, heldItem: null, equip: async () => {},
    setControlState: () => {}, clearControlStates: () => {}, pathfinder: { stop: () => {}, setGoal: () => {} }, lookAt: async () => {}, attack: async () => {},
    nearestEntity: (match: (entity: any) => boolean) => entities.filter(entity => match(entity))[0] ?? null,
    blockAt: (p: Vec3) => ({ name: p.y <= 62 ? 'water' : 'air', boundingBox: 'empty', position: p }) }) as any;
  it('lets each go after 12 s, and stops the call after 40 s in the water in all', async () => {
    let clock = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 500));
    try {
      const fish = [2, 3, 4, 5, 6].map(id => ({ id, name: 'salmon', position: new Vec3(12.5 + id, 60, 0.5), height: 0.4, isValid: true }));
      const result: any = await (new AttackContinuously(sea(fish)) as any).runImpl('salmon', 30, 24, 0);
      expect(result.result).toContain('この呼び出しはここまで');
      expect(result.result).toMatch(/[34]匹をあきらめました/);
    } finally { now.mockRestore(); }
  });
  it('a hostile in the water is not let go: it is fought', async () => {
    let clock = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 500));
    try {
      const drowned = { id: 2, name: 'drowned', position: new Vec3(2.5, 61, 0.5), height: 1.95, isValid: true };
      const result: any = await (new AttackContinuously(sea([drowned])) as any).runImpl('drowned', 3, 24, 0);
      expect(result.result).not.toContain('追いきれず');
      expect(result.result).toContain('計3回攻撃');
    } finally { now.mockRestore(); }
  });
});

describe('stair-mine steps down into a cave a block or two below instead of stopping at its edge (ladder probe, y -13)', () => {
  const world = (floorY: number, lavaBeside = false) => ({ version: '1.21.11', entity: { position: new Vec3(0.5, 44, 0.5) }, inventory: { items: () => [] },
    blockAt: (p: Vec3) => p.y === floorY ? { name: 'stone', boundingBox: 'block', position: p }
      : lavaBeside && p.y === floorY + 1 && p.x === 2 ? { name: 'lava', boundingBox: 'empty', position: p } : { name: 'air', boundingBox: 'empty', position: p } });
  const StairMineClass = async () => (await import('../../src/services/minebot/instantSkills/stairMine.js')).default;
  it('a floor one or two blocks under the step (a fall of two or three) is a step down; deeper, or lava beside, is not', async () => {
    const StairMine = await StairMineClass();
    const next = new Vec3(1, 43, 0);
    expect((new StairMine(world(41) as any) as any).shallowFloorBelow(next)).toBe(1);
    expect((new StairMine(world(40) as any) as any).shallowFloorBelow(next)).toBe(2);
    expect((new StairMine(world(39) as any) as any).shallowFloorBelow(next)).toBeNull();
    expect((new StairMine(world(41, true) as any) as any).shallowFloorBelow(next)).toBeNull();
  });
  it('a cave too deep to step into has its floor found below, beside the pillar stood on (ladder probe, y 3)', async () => {
    const StairMine = await StairMineClass();
    const cave = (floorY: number) => ({ ...world(floorY), blockAt: (p: Vec3) =>
      (p.x === 0 && p.z === 0 && p.y <= 43) || p.y === floorY ? { name: 'stone', boundingBox: 'block', position: p } : { name: 'air', boundingBox: 'empty', position: p } });
    const floor = (new StairMine(cave(30) as any) as any).caveFloorBelow(new Vec3(0, 44, 0), -58);
    expect(floor.y).toBe(30);
    expect(Math.abs(floor.x) + Math.abs(floor.z)).toBe(1);
    expect((new StairMine(cave(41) as any) as any).caveFloorBelow(new Vec3(0, 44, 0), -58)).toBeNull();
    expect((new StairMine(cave(30) as any) as any).caveFloorBelow(new Vec3(0, 44, 0), 35)).toBeNull();
  });
});

describe('the nether ladder\'s tools (lab probe 2026-10-20): where a poured bucket lands, and the inside of a portal', () => {
  it('the ray from the eyes meets the first solid block, with the face it enters: a block in front of the aimed face takes the water', async () => {
    const { rayFace } = await import('../../src/services/minebot/utils/rayFace.js');
    const solid = new Set(['3,63,0', '1,63,0']);
    const blockAt = (p: Vec3) => ({ boundingBox: solid.has(`${p.x},${p.y},${p.z}`) ? 'block' : 'empty' });
    // Aimed at the west face of (3,63,0) from high enough to pass over (1,63,0): clear, the face is (-1,0,0).
    expect(rayFace(blockAt, new Vec3(0.5, 66, 0.5), new Vec3(3.0, 63.5, 0.5))).toMatchObject({ cell: new Vec3(3, 63, 0), face: new Vec3(-1, 0, 0) });
    // From lower down the line runs into (1,63,0) first: that block (its west side) is hit, not the face aimed at.
    const hit = rayFace(blockAt, new Vec3(0.5, 64.1, 0.5), new Vec3(3.0, 63.2, 0.5));
    expect(hit?.cell).toEqual(new Vec3(1, 63, 0));
    expect(hit?.face).toEqual(new Vec3(-1, 0, 0));
    // Straight down onto a top: the top face.
    expect(rayFace(blockAt, new Vec3(1.5, 66, 0.5), new Vec3(1.5, 63.9, 0.5))?.face).toEqual(new Vec3(0, 1, 0));
  });
  it('water for a lava under a low roof goes to another source of the same pool, poured from the shore', async () => {
    const { default: UseItemOnBlock } = await import('../../src/services/minebot/instantSkills/useItemOnBlock.js');
    // A pool at y 63 from x 0 to 4 (z 0); the roof is solid at y 64 over x 0..1, open over x 2..4; a stone shore at x 5 (y 63).
    const blockAt = (p: Vec3) => {
      const name = p.y === 63 && p.z === 0 && p.x >= 0 && p.x <= 4 ? 'lava' : (p.y === 64 && p.z === 0 && p.x <= 1 && p.x >= 0) || p.y <= 63 ? 'stone' : 'air';
      return { name, boundingBox: name === 'stone' ? 'block' : 'empty', position: p, metadata: 0, getProperties: () => ({ level: 0 }) };
    };
    const skill: any = new UseItemOnBlock({ version: '1.21.11', entity: { position: new Vec3(6.5, 64, 0.5) }, blockAt, inventory: { items: () => [] } } as any);
    const pool = skill.poolSources(new Vec3(0, 63, 0));
    expect(pool[0]).toEqual(new Vec3(0, 63, 0));
    expect(pool.slice(1).map((at: Vec3) => at.x)).toEqual([2, 3, 4]);   // only those with air over them
    // A stand on the shore by the open part: floor solid, lava beside the floor is allowed.
    const stands = skill.waterStands(new Vec3(4, 63, 0));
    expect(stands.some((at: Vec3) => at.equals(new Vec3(5, 64, 0)))).toBe(true);
  });
  it('the portal\'s inside is the 2x3 the frame encloses, and nothing for a blueprint with no frame', async () => {
    const { default: BuildStructure } = await import('../../src/services/minebot/instantSkills/buildStructure.js');
    const skill: any = new BuildStructure({ version: '1.21.11', entity: { position: new Vec3(0, 64, 0), yaw: 0 }, inventory: { items: () => [] } } as any);
    const portal = { name: 'nether_portal', materials: { O: 'obsidian' }, layers: [['.OO.'], ['O..O'], ['O..O'], ['O..O'], ['.OO.']] };
    const inside = skill.enclosedCells(portal, new Vec3(0, 64, 0), 'south');
    expect(inside).toHaveLength(6);
    expect(new Set(inside.map((cell: Vec3) => cell.y))).toEqual(new Set([65, 66, 67]));
    expect(skill.enclosedCells({ name: 'wall', materials: { C: 'cobblestone' }, layers: [['CCC'], ['CCC']] }, new Vec3(0, 64, 0), 'south')).toEqual([]);
  });
  it('a body standing in a frame cell steps off to a stand clear of the frame and its inside, two blocks away (ladder probe: 9 of 10)', async () => {
    const { default: BuildStructure } = await import('../../src/services/minebot/instantSkills/buildStructure.js');
    const { gotoSafe } = await import('../../src/services/minebot/utils/gotoSafe.js');
    const bot: any = { version: '1.21.11', entity: { position: new Vec3(1.5, 64, 0.5), yaw: 0 }, inventory: { items: () => [] },
      blockAt: (p: Vec3) => ({ position: p, name: p.y <= 63 || p.x <= 0 || p.z !== 0 ? 'deepslate' : 'air', boundingBox: p.y <= 63 || p.x <= 0 || p.z !== 0 ? 'block' : 'empty' }) };
    const skill: any = new BuildStructure(bot);
    skill.sleep = async () => {};
    skill.buildCells = [new Vec3(2, 64, 0), new Vec3(1, 65, 0)];
    vi.mocked(gotoSafe).mockImplementationOnce(async (_bot: any, goal: any) => { bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); return { success: true }; });
    expect(await skill.stepAside(new Vec3(1, 64, 0))).toBe(true);
    expect(bot.entity.position.floored()).toEqual(new Vec3(3, 64, 0));
  });
});

describe('the release after a command waits for auto-swim to reach the air (run 19: two FCA_BODY_OUTCOME_UNKNOWN)', () => {
  const fixture = () => {
    const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, position: new Vec3(0, 60, 0), yaw: 0, pitch: 0, onGround: false },
      health: 20, food: 20, oxygenLevel: 13, game: { dimension: 'overworld' }, entities: {}, inventory: { items: () => [] }, controlState: {},
      instantSkills: { getSkills: () => [] }, executingSkill: false, interruptExecution: false,
      clearControlStates: vi.fn(), setControlState: vi.fn(), look: vi.fn(async () => {}), attack: vi.fn() });
    const body = new NativeCommonFcaBody(bot, { serverId: 'home', capture: async () => ({ dataUrl: 'data:image/jpeg;base64,YQ==', capturedAt: new Date().toISOString() }) });
    return { bot, body };
  };
  const surfacing = (bot: any, ms: number) => executeAction(bot, 'auto-swim', 0, async () => { await new Promise(resolve => setTimeout(resolve, ms));
    return { success: true, result: 'surfaced' }; }, { waitForQuiescence: true, safetyLease: true, priority: 300 });
  it('after a command (its deadline given), a surfacing of 3.5 s is waited for and the body comes back released', async () => {
    const { bot, body } = fixture();
    const swim = surfacing(bot, 3500);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(physicalActionBusy(bot)).toBe(true);
    expect(await body.release(AbortSignal.timeout(50), Date.now() + 20_000)).toBe(true);
    await swim; await body.dispose();
  }, 10_000);
  it('an API stop or release (no deadline given) keeps its 3 s', async () => {
    const { bot, body } = fixture();
    const swim = surfacing(bot, 3500);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(await body.release(AbortSignal.timeout(50))).toBe(false);
    await swim; await body.dispose();
  }, 10_000);
});

describe('use-item-on-block count≥2 makes and mines obsidian from a pool in one call (mb-arch: ten decisions for ten obsidian)', () => {
  const pool = (length: number) => {
    // A row of lava sources at y 60 on stone, stone walls round it; the body stands on the bank at its west end.
    const cells = new Map<string, string>();
    for (let x = 0; x < length; x++) cells.set(`${x},60,0`, 'lava');
    const name = (p: Vec3) => cells.get(`${p.x},${p.y},${p.z}`) ?? (p.y >= 61 ? 'air' : 'stone');
    const inventory: Array<{ name: string; count: number; type?: number }> = [
      { name: 'diamond_pickaxe', count: 1 }, { name: 'water_bucket', count: 1 }];
    const bot: any = {
      version: '1.21.11', game: { dimension: 'overworld' }, entity: { position: new Vec3(-0.5, 61, 0.5) },
      inventory: { items: () => inventory.filter(item => item.count > 0) },
      instantSkills: { getSkill: () => ({}) },
      blockAt: (p: Vec3) => { const n = name(p); return { name: n, position: p, metadata: 0, getProperties: () => ({ level: 0 }),
        boundingBox: n === 'air' || n === 'lava' ? 'empty' : 'block' }; },
      findBlocks: ({ matching, point, maxDistance }: any) => {
        const out: Vec3[] = [];
        for (let x = -12; x <= 12; x++) for (let y = 56; y <= 64; y++) for (let z = -4; z <= 4; z++) {
          const p = new Vec3(x, y, z);
          if (p.distanceTo(point) <= maxDistance && matching(bot.blockAt(p))) out.push(p);
        }
        return out;
      },
    };
    return { cells, inventory, bot };
  };
  const skillFor = async (world: ReturnType<typeof pool>) => {
    const { default: UseItemOnBlock } = await import('../../src/services/minebot/instantSkills/useItemOnBlock.js');
    const skill: any = new UseItemOnBlock(world.bot);
    const poured: string[] = [], dug: string[] = [];
    skill.placeWaterNearLava = async (lava: Vec3) => { world.cells.set(`${lava.x},${lava.y},${lava.z}`, 'obsidian'); poured.push(`${lava.x}`); return { success: true }; };
    skill.callSkill = async (name: string, x: any, y: number, z: number) => {
      if (name === 'drop-item') { for (const item of world.inventory) if (item.name === x) item.count = 0; return { success: true }; }
      world.cells.set(`${x},${y},${z}`, 'air'); dug.push(`${x}`);
      const held = world.inventory.find(item => item.name === 'obsidian');
      if (held) held.count++; else world.inventory.push({ name: 'obsidian', count: 1 });
      return { success: true };
    };
    return { skill, poured, dug };
  };
  it('pours first while too few can be taken (obsidian beside lava burns its drop), then mines them, and says how many', async () => {
    const world = pool(5);
    const { skill, poured, dug } = await skillFor(world);
    const result = await skill.runImpl(0, 60, 0, 'water_bucket', 5);
    expect(result.success).toBe(true);
    expect(result.result).toContain('黒曜石を5個作って掘りました（溶岩5か所に水をかけ、所持 obsidian=5個）');
    expect(poured).toEqual(['0', '1', '2', '3', '4']);
    expect(dug).toHaveLength(5);
  });
  it('a pool too small says how many it got and why, with the water bucket kept', async () => {
    const world = pool(3);
    const { skill } = await skillFor(world);
    const result = await skill.runImpl(0, 60, 0, 'water_bucket', 5);
    expect(result.success).toBe(false);
    expect(result.failureType).toBe('partial_completion');
    expect(result.result).toContain('黒曜石を3個作って掘りました');
    expect(result.result).toContain('残り2個: 近くに水をかけられる溶岩も、すぐ掘れる黒曜石も、もうありません');
    expect(result.result).toContain('水はwater_bucketへ回収済み');
  });
  it('a full pack is made room in first, so the obsidian is taken and not left on the floor (ladder probe: five dug, none taken)', async () => {
    const world = pool(2);
    for (let i = 0; i < 34; i++) world.inventory.push({ name: 'cobbled_deepslate', count: 64 });
    const { skill } = await skillFor(world);
    const result = await skill.runImpl(0, 60, 0, 'water_bucket', 2);
    expect(result.success).toBe(true);
    expect(result.result).toContain('持ち物の空きを作るためcobbled_deepslate×');
  });
  it('without a diamond pickaxe, or in the Nether, nothing is poured', async () => {
    const world = pool(3);
    world.inventory.splice(0, 1);
    const { skill, poured } = await skillFor(world);
    expect((await skill.runImpl(0, 60, 0, 'water_bucket', 5)).failureType).toBe('missing_tool');
    world.bot.game.dimension = 'the_nether';
    expect((await skill.runImpl(0, 60, 0, 'water_bucket', 5)).failureType).toBe('invalid_input');
    expect(poured).toEqual([]);
  });
});

const { shouldPauseMiningForDeposit, slotsForDrops } = await import('../../src/services/minebot/utils/inventorySpillDetection.js');

describe('the room for what is mined is counted in slots (ladder probe: ten obsidian refused with five slots free)', () => {
  const pack = (free: number, items: Array<{ name: string; count: number }> = []) => ({
    registry, inventory: { emptySlotCount: () => free, items: () => items },
  }) as any;
  it('ten obsidian fit five free slots; the old count of blocks against slots refused them', () => {
    expect(slotsForDrops(pack(5), 10, ['obsidian'])).toBe(2);
    expect(shouldPauseMiningForDeposit(pack(5), 10, ['obsidian'])).toBe(false);
    expect(shouldPauseMiningForDeposit(pack(5), 10)).toBe(true);
  });
  it('gravel counts its flint too, the stack held first, and lapis its several', () => {
    expect(slotsForDrops(pack(3, [{ name: 'gravel', count: 60 }]), 10, ['gravel', 'flint'])).toBe(3);
    expect(slotsForDrops(pack(3), 10, ['lapis_lazuli'])).toBe(3);
    expect(shouldPauseMiningForDeposit(pack(1), 10, ['obsidian'])).toBe(true);
    expect(shouldPauseMiningForDeposit(pack(0), 1, ['obsidian'])).toBe(true);
  });
});
