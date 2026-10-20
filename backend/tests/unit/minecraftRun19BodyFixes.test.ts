import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';

vi.mock('../../src/services/minebot/execution/observedWait.js', async (original) => ({
  ...(await original() as object), actionDelay: vi.fn(async () => {}),
}));
vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: vi.fn(async () => ({ success: false })) }));

const { biomesAround, describeBiomes, emptyPlaceMemory, noteBiome, parsePlaceMemory, placesDigest, rememberPlace } = await import('../../src/modules/minecraftLearning/places.js');
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
