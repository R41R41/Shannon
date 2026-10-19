import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { describe, expect, it, vi } from 'vitest';
import UseItem from '../../src/services/minebot/instantSkills/useItem.js';
import ActivateBlock from '../../src/services/minebot/instantSkills/activateBlock.js';
import SleepInBed from '../../src/services/minebot/instantSkills/sleepInBed.js';
import AutoAvoidDragonBreath from '../../src/services/minebot/constantSkills/autoAvoidDragonBreath.js';
import { DRAGON_GOALS, HIDDEN_FOR_DRAGON, OFFERED_ELSEWHERE, bodySkillCatalog, isDragonGoal, offeredSchema } from '../../src/services/minebot/integration/commonFca/skillCatalog.js';
import { captureWorldObservation } from '../../src/services/minebot/cognition/worldFrame.js';
import { isBedName } from '../../src/services/minebot/utils/bedRules.js';

vi.mock('../../src/services/minebot/utils/gotoSafe.js', () => ({ gotoSafe: vi.fn(async () => {}) }));
const scanned: string[][] = [];
vi.mock('../../src/services/minebot/utils/loadedBlockScan.js', () => ({
  scanLoadedBlocks: vi.fn((_bot: unknown, blocks: string[]) => { scanned.push(blocks); return { hits: [], reachMetres: 96 }; }),
}));
const { default: FindStructure } = await import('../../src/services/minebot/instantSkills/findStructure.js');

describe('eye of ender: the course of the thrown eye, for a triangulation', () => {
  it('reads the bearing and the climb of the eye over its first second', async () => {
    const eye = { name: 'ender_eye', count: 3, type: 1 };
    const bot: any = { version: '1.21.11', entity: { position: new Vec3(100.4, 70, -20.6) }, entities: {}, heldItem: null,
      inventory: { items: () => [eye], slots: [] }, equip: vi.fn(async (item: any) => { bot.heldItem = item; }) };
    let timer: ReturnType<typeof setInterval> | undefined;
    bot.activateItem = vi.fn(async () => {
      // Flies north-east (+x, -z) and up, as an eye toward a stronghold does.
      const flying = { id: 77, name: 'eye_of_ender', position: new Vec3(100.4, 71.6, -20.6) };
      bot.entities[77] = flying;
      timer = setInterval(() => { flying.position = flying.position.offset(0.2, 0.05, -0.2); }, 50);
    });
    try {
      const result = await new UseItem(bot).runImpl('ender_eye');
      expect(result.success).toBe(true);
      expect(result.result).toContain('(100, 70, -21)');
      expect(result.result).toMatch(/方位4[45]\.\d°/);
      expect(result.result).toContain('北東');
      expect(result.result).toContain('x=0.707');
      expect(result.result).toContain('z=-0.707');
    } finally { clearInterval(timer); }
  });

  it('says so when no eye leaves the hand (no stronghold in this dimension, or a frame in the look)', async () => {
    const eye = { name: 'ender_eye', count: 1, type: 1 };
    const bot: any = { version: '1.21.11', entity: { position: new Vec3(0, 70, 0) }, entities: {}, heldItem: null,
      inventory: { items: () => [eye], slots: [] }, equip: vi.fn(async (item: any) => { bot.heldItem = item; }), activateItem: vi.fn(async () => {}) };
    expect(await new UseItem(bot).runImpl('ender_eye')).toMatchObject({ success: false, failureType: 'eye_not_thrown' });
  });
});

describe('find-structure looks for the blocks only the structure places', () => {
  it('a stronghold by its portal frame and infested bricks, a bastion without plain blackstone', async () => {
    const bot: any = { version: '1.21.11', entity: { position: new Vec3(0, 30, 0) } };
    scanned.length = 0;
    const stronghold = await new FindStructure(bot).runImpl('stronghold');
    await new FindStructure(bot).runImpl('bastion');
    expect(scanned[0]).toEqual(['end_portal_frame', 'infested_stone_bricks', 'infested_mossy_stone_bricks', 'infested_cracked_stone_bricks']);
    expect(scanned[0]).not.toContain('stone_bricks');
    expect(scanned[1]).toEqual(['polished_blackstone_bricks', 'gilded_blackstone']);
    // Not in the loaded chunks: the eye of ender is pointed to.
    expect(stronghold.result).toContain('use-item ender_eye');
  });
});

/** A bed at (5, 64, 5) of the given colour; `say` is what the server answers the right-click with. */
function bedBot(options: { colour?: string; dimension?: string; say?: string[]; sleeps?: boolean } = {}) {
  const bed = { name: `${options.colour ?? 'red'}_bed`, position: new Vec3(5, 64, 5) };
  const bot: any = Object.assign(new EventEmitter(), {
    version: '1.21.11', game: { dimension: options.dimension ?? 'overworld' }, entity: { position: new Vec3(4, 64, 5) },
    time: { timeOfDay: 6000 }, entities: {}, isSleeping: false, inventory: { items: () => [] },
    blockAt: (position: Vec3) => (position.equals(bed.position) ? bed : { name: 'air', position }),
    findBlock: vi.fn(({ matching }: any) => {
      const id = minecraftData('1.21.11').blocksByName[bed.name].id;
      return (Array.isArray(matching) ? matching.includes(id) : matching === id) ? bed : null;
    }),
  });
  bot.activateBlock = vi.fn(async () => {
    for (const key of options.say ?? []) bot.emit('message', { translate: key });
    if (options.sleeps) bot.isSleeping = true;
  });
  return { bot, bed };
}

describe('beds: the respawn point by a right-click, never a bed where it explodes', () => {
  it('takes a bed of any colour, and by day the right-click sets the respawn point (the server says so, then that sleep waits for night)', async () => {
    expect(isBedName('bed') && isBedName('light_blue_bed') && isBedName('minecraft:red_bed')).toBe(true);
    expect(isBedName('bedrock')).toBe(false);
    const { bot } = bedBot({ colour: 'light_blue', say: ['block.minecraft.set_spawn', 'block.minecraft.bed.no_sleep'] });
    const result = await new ActivateBlock(bot).runImpl('bed');
    expect(bot.activateBlock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ success: true });
    expect(result.result).toContain('リスポーン地点をlight_blue_bed(5, 64, 5)に決めました');
    expect(result.result).toContain('夜でないので');
    // A colour named and another colour standing there: still that bed, at the given place.
    const other = bedBot({ colour: 'white', say: ['block.minecraft.set_spawn'] });
    expect((await new ActivateBlock(other.bot).runImpl('red_bed', 5, 64, 5)).result).toContain('white_bed(5, 64, 5)');
  });

  it('says when no word came back (the bed already holds the point), and when the bed could not be used', async () => {
    const quiet = bedBot({ say: [] });
    expect((await new ActivateBlock(quiet.bot).runImpl('bed')).result).toContain('知らせは来ませんでした');
    const blocked = bedBot({ say: ['block.minecraft.bed.obstructed'] });
    expect(await new ActivateBlock(blocked.bot).runImpl('bed')).toMatchObject({ success: false, recoverable: true });
  });

  it('at night the right-click puts the body to sleep, and says how to get up', async () => {
    const { bot } = bedBot({ say: ['block.minecraft.set_spawn'], sleeps: true });
    expect((await new ActivateBlock(bot).runImpl('bed')).result).toContain('wakeUp=true');
  });

  it('refuses a bed in the Nether and the End, in both skills, before anything is touched', async () => {
    for (const dimension of ['the_nether', 'the_end']) {
      const { bot } = bedBot({ dimension });
      expect(await new ActivateBlock(bot).runImpl('bed')).toMatchObject({ success: false, failureType: 'bed_explodes' });
      expect(await new SleepInBed(bot).runImpl(false, false)).toMatchObject({ success: false, failureType: 'bed_explodes' });
      expect(bot.activateBlock).not.toHaveBeenCalled();
      expect(bot.findBlock).not.toHaveBeenCalled();
    }
    // Other blocks are still used there.
    const { bot } = bedBot({ dimension: 'the_nether' });
    bot.findBlock = vi.fn(() => ({ name: 'crafting_table', position: new Vec3(1, 64, 1) }));
    expect(await new ActivateBlock(bot).runImpl('crafting_table')).toMatchObject({ success: true });
  });

  it('by day sleep-in-bed points to activate-block for the respawn point alone', async () => {
    const { bot } = bedBot();
    const result = await new SleepInBed(bot).runImpl(false, false);
    expect(result).toMatchObject({ success: false, failureType: 'not_night' });
    expect(result.result).toContain('activate-block');
  });
});

describe('the dragon breath reflex', () => {
  const registry = minecraftData('1.21.11');
  it('reads the cloud particle at the index minecraft-data gives for the server version (10 on 1.21.11)', () => {
    expect(registry.entitiesByName.area_effect_cloud.metadataKeys?.indexOf('particle')).toBe(10);
  });

  function endBot() {
    const runFromEntities = vi.fn(async () => {});
    const bot: any = { version: '1.21.11', registry, game: { dimension: 'the_end' }, entity: { position: new Vec3(0, 64, 0) },
      entities: {}, toldVelocities: new Map(), utils: { runFromEntities },
      nearestEntity: (match: (entity: any) => boolean) => Object.values(bot.entities).find(match) ?? null };
    return { bot, runFromEntities };
  }

  it('flees a breath cloud, and passes over a potion cloud and a cloud whose particle is not known yet', async () => {
    const { bot, runFromEntities } = endBot();
    const cloud = (id: number, particle?: unknown) => { const metadata: unknown[] = []; if (particle) metadata[10] = particle;
      return { id, name: 'area_effect_cloud', position: new Vec3(2, 64, 0), metadata }; };
    bot.entities = { 1: cloud(1), 2: cloud(2, { type: 'entity_effect' }) };
    await new AutoAvoidDragonBreath(bot).runImpl();
    expect(runFromEntities).not.toHaveBeenCalled();
    bot.entities[3] = cloud(3, { type: 'dragon_breath' });
    await new AutoAvoidDragonBreath(bot).runImpl();
    expect(runFromEntities).toHaveBeenCalledWith(bot, [bot.entities[3]], 12);
  });

  it('moves away from where a fireball high overhead will land, by the speed the server told of', async () => {
    const { bot, runFromEntities } = endBot();
    // Thirty blocks up, coming down at a slant: the library's own velocity is 0 (never set for a spawned ball).
    bot.entities = { 9: { id: 9, name: 'dragon_fireball', position: new Vec3(-30, 94, 0), velocity: new Vec3(0, 0, 0) } };
    bot.toldVelocities.set(9, new Vec3(0.1, -0.1, 0));
    await new AutoAvoidDragonBreath(bot).runImpl();
    expect(runFromEntities).toHaveBeenCalledOnce();
    const [, [target]] = runFromEntities.mock.calls[0] as any;
    expect(target.position.x).toBeCloseTo(0); expect(target.position.y).toBeCloseTo(64);
  });

  it('does nothing outside the End', async () => {
    const { bot, runFromEntities } = endBot();
    bot.game.dimension = 'overworld';
    bot.entities = { 9: { id: 9, name: 'dragon_fireball', position: new Vec3(0, 70, 0), velocity: new Vec3(0, -1, 0) } };
    await new AutoAvoidDragonBreath(bot).runImpl();
    expect(runFromEntities).not.toHaveBeenCalled();
  });

  it('takes the body from a task only while a danger is near, and takes no action at all when none is', async () => {
    const { bot } = endBot();
    const reflex: any = new AutoAvoidDragonBreath(bot);
    const runImpl = vi.spyOn(reflex, 'runImpl');
    expect(reflex.wantsPreemption()).toBe(false);
    await reflex.run();
    expect(runImpl).not.toHaveBeenCalled();
    const metadata: unknown[] = []; metadata[8] = 3; metadata[10] = { type: 'dragon_breath' };
    bot.entities = { 4: { id: 4, name: 'area_effect_cloud', position: new Vec3(4, 64, 0), metadata } };
    expect(reflex.wantsPreemption()).toBe(true);
    // A small cloud further off than its radius and a step: not yet.
    bot.entities[4].position = new Vec3(7, 64, 0);
    expect(reflex.wantsPreemption()).toBe(false);
  });
});

describe('the catalog offered to the planner', () => {
  const skill = (name: string, params: any[] = []) => ({ skillName: name, description: 'test', isToolForLLM: true, maxDurationMs: 1000, params,
    run: vi.fn(async () => ({ success: true, result: 'ok' })) });

  it('leaves out what the observation says and the toggles the body undoes, and the life tools only while the task is the dragon', () => {
    const names = ['move-to', 'get-position', 'set-sneak', 'fish', 'brew-potion', 'harvest-crop'];
    const catalog = bodySkillCatalog(names.map(name => skill(name)), {});
    expect(catalog.definitions.map(d => d.name)).toEqual(['move-to', 'fish', 'brew-potion', 'harvest-crop']);
    // Brewing (fire resistance for a fortress) stays on the way to the dragon; fishing does not.
    expect(catalog.dragonDefinitions.map(d => d.name)).toEqual(['move-to', 'brew-potion', 'harvest-crop']);
    expect(catalog.runnable.map(d => d.name)).toEqual(names);
    // Still carried out when asked for.
    expect(catalog.resolve('get-position', {}).skill.skillName).toBe('get-position');
    expect([...OFFERED_ELSEWHERE].some(name => HIDDEN_FOR_DRAGON.has(name))).toBe(false);
  });

  it('knows the dragon by the same closed set of requests the API binds to the evidence', () => {
    expect(isDragonGoal('エンドラを討伐して')).toBe(true);
    expect(isDragonGoal('エンダードラゴンを倒してください。')).toBe(true);
    expect(isDragonGoal('Kill the Ender Dragon!')).toBe(true);
    expect(isDragonGoal('エンドラを倒す前に畑を作って')).toBe(false);
    expect(isDragonGoal(undefined)).toBe(false);
  });

  it.skipIf(!process.env.FCA_API_WIRE_ROOT)('agrees with the API on every dragon request (FCA_API_WIRE_ROOT set)', async () => {
    const binding = await import(`${process.env.FCA_API_WIRE_ROOT}/src/wiring/fcaMinecraftGoalBinding.ts`);
    for (const goal of DRAGON_GOALS) expect(binding.isNativeDragonGoal(goal)).toBe(true);
    for (const goal of ['エンドラを倒す前に畑を作って', '木を集めて']) expect(binding.isNativeDragonGoal(goal)).toBe(isDragonGoal(goal));
  });

  it('shows an optional value by its own type: null and leaving it out are read alike', () => {
    const catalog = bodySkillCatalog([skill('use-item', [{ name: 'itemName', type: 'string', default: null, description: 'name' },
      { name: 'count', type: 'number', default: 2, description: 'how many' }, { name: 'target', type: 'string', required: true, description: 't' }])], {});
    const schema: any = catalog.definitions[0].inputSchema;
    expect(schema.properties.itemName).toEqual({ type: 'string', description: 'name' });
    expect(schema.properties.count).toMatchObject({ type: 'number', default: 2 });
    expect(schema.properties.target).toMatchObject({ type: 'string' });
    expect(schema.required).toEqual(['target']);
    expect(catalog.resolve('use-item', { itemName: null, target: 'x' }).args).toEqual([null, 2, 'x']);
    expect(offeredSchema({ type: 'object', properties: { a: { anyOf: [{ type: 'string' }, { type: 'number' }] } } }).properties.a.anyOf).toHaveLength(2);
  });
});

describe('the native body offers the catalog of the latest task', () => {
  it('switches to the dragon catalog when a command carries the dragon request, and back for any other task', async () => {
    const { NativeCommonFcaBody } = await import('../../src/services/minebot/integration/commonFca/nativeBody.js');
    const skill = (name: string) => ({ skillName: name, description: 'test', isToolForLLM: true, maxDurationMs: 1000, params: [],
      run: vi.fn(async () => ({ success: true, result: 'ok' })) });
    const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, position: new Vec3(0, 65, 0), yaw: 0, pitch: 0, onGround: true },
      health: 20, food: 20, game: { dimension: 'overworld' }, entities: {}, inventory: { items: () => [] }, controlState: {},
      instantSkills: { getSkills: () => [skill('wait-time'), skill('fish')] }, clearControlStates: vi.fn(), attack: vi.fn() });
    let clock = Date.now();
    const body = new NativeCommonFcaBody(bot, { serverId: 'home', now: () => clock, capture: async () => ({ dataUrl: 'data:image/jpeg;base64,YQ==', capturedAt: new Date().toISOString() }) });
    const run = (goal: string) => body.execute({ schemaVersion: 1, id: `c-${goal}`, serverId: 'home', connectionId: 'connection1', kind: 'skill',
      context: { scopeKey: 'owner', taskId: 't', taskRevision: 1, bodyId: 'minecraft:home', sessionId: 's', generation: 1, goal, completionCondition: 'done' },
      lease: { id: 'l', generation: 1, holder: 't' }, deadlineAt: new Date(Date.now() + 2000).toISOString(), skill: 'wait-time', arguments: {} } as any,
    new AbortController().signal);
    const ordinary = body.skills;
    expect(ordinary.map(s => s.name)).toEqual(['wait-time', 'fish', 'goal-evidence']);
    await run('エンドラを討伐して');
    expect(body.skills.map(s => s.name)).toEqual(['wait-time', 'goal-evidence']);
    const dragon = body.skills; await run('エンドラを討伐して'); expect(body.skills).toBe(dragon);
    await run('木を集めて');
    expect(body.skills).toBe(ordinary);
    // No command for a minute and a half after the dragon: the next request, whatever it is, sees every tool.
    await run('エンドラを討伐して'); clock += 60_000; expect(body.skills).toBe(dragon);
    clock += 31_000; expect(body.skills).toBe(ordinary);
    await body.dispose();
  });
});

describe('the observation says what is worn', () => {
  it('names the armour and the off hand with their wear (the pack lists slots 9-44 only)', () => {
    const slots: any[] = []; slots[5] = { name: 'iron_helmet', maxDurability: 165, durabilityUsed: 15 }; slots[45] = { name: 'shield', maxDurability: 336, durabilityUsed: 0 };
    const world = captureWorldObservation({ entity: { position: new Vec3(0, 64, 0) }, inventory: { items: () => [], slots } } as any);
    expect(world.worn).toBe('頭: iron_helmet(残り150/165)、胴: なし、脚: なし、足: なし、左手: shield(残り336/336)');
  });
  it('tells a thunderstorm from rain (sleep is allowed in one by day)', () => {
    const at = (isRaining: boolean, thunderState: number) => captureWorldObservation({ entity: { position: new Vec3(0, 64, 0) }, isRaining, thunderState } as any).weather;
    expect([at(true, 1), at(true, 0), at(false, 0)]).toEqual(['thunder', 'rain', 'clear']);
  });
});
