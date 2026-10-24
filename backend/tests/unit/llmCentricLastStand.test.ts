import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { describe, expect, it, vi } from 'vitest';

// Run 27: at 3.6 health with a spider at the body and no safe way to run, the LLM-centric body (whose automatic shelter is off) stood for
// 4 s and was killed. The last stand (floorReflexes.lastStandChoice): a blow, a step down, or one block up; told in the ledger so the act
// that was running stops as a reflex. A fake body on a one-block pillar (every heading is a drop), the server-confirmed dig replaced.
vi.mock('../../src/services/minebot/utils/digBlockVerified.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/services/minebot/utils/digBlockVerified.js')>();
  return { ...actual, digBlockVerified: vi.fn(async (bot: any, block: any) => {
    bot.__dug.push(`${block.position.x},${block.position.y},${block.position.z}`);
    bot.__blocks.set(`${block.position.x},${block.position.y},${block.position.z}`, { name: 'air', boundingBox: 'empty' });
    return { stateId: 0, blockName: 'air' };
  }) };
});

const { executeAction } = await import('../../src/services/minebot/execution/ActionExecution.js');
const { floorConfig } = await import('../../src/services/minebot/utils/floorConfig.js');
const { bestMeleeWeapon, fleeStart, installFloorReflexes, lastStandChoice } = await import('../../src/services/minebot/utils/floorReflexes.js');
const { ensureReflexLedger } = await import('../../src/services/minebot/utils/reflexLedger.js');
const { runAct, ACT_HANDS } = await import('../../src/services/minebot/instantSkills/act.js');

type Cell = { name: string; boundingBox: string; diggable?: boolean; hardness?: number };
const STONE: Cell = { name: 'stone', boundingBox: 'block', diggable: true, hardness: 1.5 }, AIR: Cell = { name: 'air', boundingBox: 'empty' };
const SWORD = { name: 'iron_sword', type: 20, count: 1 }, AXE = { name: 'stone_axe', type: 21, count: 1 }, STICK = { name: 'stick', type: 22, count: 4 };
const COBBLE = { name: 'cobblestone', type: 1, count: 5 };

/**
 * A pillar: stone at x 0, z 0 up to y 64 only, air everywhere else; `__blocks` overrides single cells. The body stands on it at y 65.
 * `floor` (r8): stone at and under that y everywhere, so a pillar with a drop of two round it (no rim: a drop of three or more is one,
 * utils/voidFooting), where the last stand's pillar is still made.
 */
function fixture(options: { health?: number; items?: any[]; mobs?: Record<string, any>; blocks?: Record<string, Cell>; now?: () => number; floor?: number } = {}) {
  const blocks = new Map<string, Cell>(Object.entries(options.blocks ?? {}));
  const calls: Array<[string, unknown]> = [];
  const bot: any = Object.assign(new EventEmitter(), {
    __blocks: blocks, __dug: [] as string[],
    entity: { id: 1, name: 'player', position: new Vec3(0.5, 65, 0.5), yaw: 0, pitch: 0, onGround: true },
    health: options.health ?? 3, food: 20, game: { dimension: 'overworld' },
    entities: options.mobs ?? { 2: { id: 2, name: 'zombie', position: new Vec3(2.5, 65, 0.5), height: 1.95 } } as Record<string, any>,
    registry: { blocksByName: { cobblestone: { id: 1 } } }, heldItem: null,
    inventory: { items: () => options.items ?? [], slots: new Array(46).fill(null) }, controlState: {} as Record<string, boolean>,
    executingSkill: false, interruptExecution: false, clearControlStates: vi.fn(), look: vi.fn(async () => undefined), lookAt: vi.fn(async () => undefined),
    equip: vi.fn(async (item: any) => { bot.heldItem = item; }), consume: vi.fn(async () => undefined), attack: vi.fn(),
    placeBlock: vi.fn(async (reference: any, face: Vec3) => { const at = reference.position.plus(face); blocks.set(`${at.x},${at.y},${at.z}`, { name: 'cobblestone', boundingBox: 'block' }); }),
    setControlState: vi.fn((key: string, value: boolean) => {
      calls.push([key, value]);
      // A jump: the body is a block and a third up, at rest, when the pillar laid its block.
      if (key === 'jump' && value && options.items?.some(item => item.name === 'cobblestone')) bot.entity.position = new Vec3(0.5, 66.3, 0.5);
    }),
    blockAt: (position: Vec3) => {
      const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z);
      const made = blocks.get(`${x},${y},${z}`) ?? ((y <= 64 && x === 0 && z === 0) || y <= (options.floor ?? -Infinity) ? STONE : AIR);
      return { ...made, position: new Vec3(x, y, z) };
    },
  });
  const ledger = ensureReflexLedger(bot);
  installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1, now: options.now });
  return { bot, ledger, calls };
}
const tick = (bot: EventEmitter) => bot.emit('physicsTick');
const settle = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));
const stands = (ledger: ReturnType<typeof ensureReflexLedger>) => ledger.entriesSince(-1).filter(entry => entry.detail.startsWith('低体力で逃げ道なし:'));

describe('the LLM-centric last stand at low health with no way out', () => {
  it('hits the threat at arm\'s reach with the best melee weapon (sword before axe), twice, and tells the ledger what, where and at what health', async () => {
    const { bot, ledger } = fixture({ items: [STICK, AXE, SWORD] });
    tick(bot);
    expect(bot.floorReflexes.busy).toBe('flee');
    await vi.waitFor(() => expect(bot.attack).toHaveBeenCalledTimes(2), { timeout: 3000, interval: 5 });
    expect(bot.attack).toHaveBeenCalledWith(bot.entities[2]);
    expect(bot.equip).toHaveBeenCalledWith(SWORD, 'hand');
    await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 3000, interval: 5 });
    expect(stands(ledger)).toMatchObject([{ kind: 'flee', outcome: 'done', detail: '低体力で逃げ道なし: zombie #2 を打ち返した (0,65,0) 体力3' }]);
    // The refusal is still told (the existing note), and nothing was walled or run: no key written but through the stand.
    expect(ledger.entriesSince(-1).some(entry => entry.detail.includes('安全な逃げ道が無く'))).toBe(true);
    expect(bot.floorReflexes.engagements.flee).toBe(0);
  });

  it('an act running at the time stops as a reflex, and is told what the body did', async () => {
    const { bot, ledger } = fixture({ items: [SWORD] });
    // The refusal's own note is held back (as in its 10 s window), so that only the stand can stop the act.
    bot.floorReflexes.fleeRefusedNotedAt = Date.now();
    const acting = runAct(bot, ACT_HANDS.parse([{ do: 'wait', seconds: 5 }, { do: 'jump' }]), undefined, undefined, { tickMs: 20 });
    await settle(60);
    tick(bot);
    const result = await acting;
    const json = JSON.parse(result.result);
    expect(json).toMatchObject({ ok: false, stoppedBy: 'reflex' });
    expect(json.stoppedWhy).toContain('低体力で逃げ道なし: zombie #2 を打ち返した (0,65,0) 体力3');
    expect(json.lines[0].status).toBe('stopped');
    expect(json.lines[1].status).toBe('skipped');
    expect(stands(ledger)).toHaveLength(1);
  });

  it('without a threat in reach it digs the cell under the feet (a step down onto solid ground), saying so', async () => {
    const far = { 2: { id: 2, name: 'zombie', position: new Vec3(6.5, 65, 0.5), height: 1.95 } };
    const { bot, ledger } = fixture({ mobs: far });
    tick(bot);
    await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 4000, interval: 5 });
    expect(bot.__dug).toEqual(['0,64,0']);
    expect(bot.attack).not.toHaveBeenCalled();
    // r6: the threat that reached the body is said with it.
    expect(stands(ledger)).toMatchObject([{ kind: 'flee', outcome: 'done', detail: '低体力で逃げ道なし: 足元を掘って下がった (0,65,0) 体力3。届く: zombie #2 6.0m 見える' }]);
  });

  it('r8: at the rim of a drop (a pillar with air round it) no block is laid and no jump is made: a jump there is a body a blow throws (run 32)', async () => {
    const far = { 2: { id: 2, name: 'zombie', position: new Vec3(6.5, 65, 0.5), height: 1.95 } };
    // Bedrock under the feet: nothing to dig. (Before r8 this laid a block and jumped: "1段積んで上がった".)
    const { bot, ledger, calls } = fixture({ mobs: far, items: [COBBLE], blocks: { '0,64,0': { name: 'bedrock', boundingBox: 'block', diggable: false } } });
    for (let i = 0; i < 4; i++) { tick(bot); await settle(15); }
    expect(bot.__dug).toEqual([]);
    expect(bot.placeBlock).not.toHaveBeenCalled();
    expect(calls.some(([key, value]) => key === 'jump' && value)).toBe(false);
    expect(stands(ledger)).toHaveLength(0);
  });

  it('else, with a full block carried and two free cells over the head, on a floor with no rim, it puts one block under the feet and goes up', () => {
    const far = { 2: { id: 2, name: 'zombie', position: new Vec3(6.5, 65, 0.5), height: 1.95 } };
    // A pillar two high over a floor (a drop of two round it: no rim). Bedrock under the feet: nothing to dig.
    const { bot } = fixture({ mobs: far, items: [COBBLE], floor: 62, blocks: { '0,64,0': { name: 'bedrock', boundingBox: 'block', diggable: false } } });
    expect(lastStandChoice(bot)).toMatchObject({ kind: 'pillar', block: 'cobblestone' });
  });

  it('chooses in order and by the rules: a lit creeper is never hit, an unlit one may be; the dig needs a solid cell under the dug one; the pillar needs air over the head', () => {
    const lit: unknown[] = []; lit[16] = 1;
    const mob = (id: number, name: string, at: Vec3, extra: Record<string, unknown> = {}) => ({ id, name, position: at, height: 1.8, ...extra });
    // r8: the world is a pillar over a floor two down (no rim): where the pillar is still made. The rim's own case is the test above and llmcR8Body.
    const pick = (mobs: Record<string, any>, items: any[] = [], blocks: Record<string, Cell> = {}) => lastStandChoice(fixture({ mobs, items, blocks, floor: 62 }).bot);
    // A zombie at 2 m beside a lit creeper at 1 m: the zombie.
    expect(pick({ 2: mob(2, 'zombie', new Vec3(2.5, 65, 0.5)), 3: mob(3, 'creeper', new Vec3(1.5, 65, 0.5), { metadata: lit }) })).toMatchObject({ kind: 'hit', target: { id: 2 } });
    // The lit creeper alone: not hit, the step down.
    expect(pick({ 3: mob(3, 'creeper', new Vec3(1.5, 65, 0.5), { metadata: lit }) })?.kind).toBe('dig');
    // An unlit one in reach is hit.
    expect(pick({ 3: mob(3, 'creeper', new Vec3(1.5, 65, 0.5), { metadata: [] }) })).toMatchObject({ kind: 'hit', target: { id: 3 } });
    // Out of reach (3.2 m): the step down; no weapon carried is a blow with what is held.
    expect(pick({ 2: mob(2, 'zombie', new Vec3(4.0, 65, 0.5)) })?.kind).toBe('dig');
    expect(pick({ 2: mob(2, 'zombie', new Vec3(2.5, 65, 0.5)) })).toMatchObject({ kind: 'hit', weapon: null });
    // The cell under the dug one must hold the body: air, water or lava there is a drop, not a step.
    const near = { 2: mob(2, 'zombie', new Vec3(6.5, 65, 0.5)) };
    for (const [label, below] of [['air', AIR], ['water', { name: 'water', boundingBox: 'empty' }], ['lava', { name: 'lava', boundingBox: 'empty' }], ['magma', { name: 'magma_block', boundingBox: 'block' }]] as const) {
      expect(pick(near, [], { '0,63,0': below }), label).toBeNull();
      expect(pick(near, [COBBLE], { '0,63,0': below })?.kind, label).toBe('pillar');
    }
    // The cell under the feet cannot be dug (bedrock) or is water: no dig either.
    expect(pick(near, [], { '0,64,0': { name: 'bedrock', boundingBox: 'block', diggable: false } })).toBeNull();
    // A roof two over the head: no pillar; planks and dirt count as full blocks, a slab or a stick do not.
    const bedrock = { '0,64,0': { name: 'bedrock', boundingBox: 'block', diggable: false } as Cell };
    expect(pick(near, [COBBLE], { ...bedrock, '0,68,0': STONE })).toBeNull();
    expect(pick(near, [COBBLE], { ...bedrock, '0,67,0': { name: 'water', boundingBox: 'empty' } })).toBeNull();
    expect(pick(near, [{ name: 'oak_planks', type: 30, count: 2 }], bedrock)).toMatchObject({ kind: 'pillar', block: 'oak_planks' });
    expect(pick(near, [{ name: 'dirt', type: 31, count: 2 }, { name: 'stone_slab', type: 32, count: 9 }, STICK], bedrock)).toMatchObject({ kind: 'pillar', block: 'dirt' });
    expect(pick(near, [{ name: 'stone_slab', type: 32, count: 9 }, STICK], bedrock)).toBeNull();
    // A kind that failed last time is skipped.
    const { bot } = fixture({ mobs: { 2: mob(2, 'zombie', new Vec3(2.5, 65, 0.5)) }, items: [COBBLE] });
    expect(lastStandChoice(bot, 'hit')?.kind).toBe('dig');
    expect(lastStandChoice(bot, 'dig')?.kind).toBe('hit');
  });

  it('the best melee weapon: a sword, then an axe, then another tool; the better material within a kind; nothing for a stick', () => {
    const names = (...list: string[]) => bestMeleeWeapon(list.map((name, index) => ({ name, type: index })))?.name ?? null;
    expect(names('stone_axe', 'wooden_sword', 'diamond_pickaxe')).toBe('wooden_sword');
    expect(names('iron_sword', 'netherite_sword', 'diamond_sword')).toBe('netherite_sword');
    expect(names('stone_axe', 'diamond_pickaxe', 'iron_axe')).toBe('iron_axe');
    expect(names('stick', 'iron_shovel', 'wooden_pickaxe')).toBe('iron_shovel');
    expect(names('stick', 'cobblestone')).toBeNull();
  });

  it('at most once in 1.5 s, and never over another safety lease', async () => {
    const clock = { at: 5_000_000 };
    const { bot } = fixture({ items: [SWORD], now: () => clock.at });
    tick(bot);
    await vi.waitFor(() => expect(bot.attack).toHaveBeenCalledTimes(2), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 3000, interval: 5 });
    // Half a second on: the flee is refused again, the stand is not made again.
    clock.at += 500; tick(bot); await settle(40);
    expect(bot.attack).toHaveBeenCalledTimes(2);
    // 1.5 s after the first: the second.
    clock.at += 1000; tick(bot);
    await vi.waitFor(() => expect(bot.attack).toHaveBeenCalledTimes(4), { timeout: 3000, interval: 5 });
    await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 3000, interval: 5 });
    // Another safety lease holds the body (the lava escape, breathing): nothing is started over it.
    let release!: () => void;
    const lease = executeAction(bot, 'auto-swim', 0, () => new Promise(resolve => { release = () => resolve({ success: true, result: 'up' }); }) as never,
      { priority: 500, safetyLease: true, waitForQuiescence: false, legacyExecutingSkill: true });
    await settle(20);
    clock.at += 5000; tick(bot); await settle(40);
    expect(bot.attack).toHaveBeenCalledTimes(4);
    release(); await lease;
  }, 20_000);

  it('a flee that makes no headway twice in a row is a way out that is not there: the last stand is wanted ', () => {
    {
      const { bot } = fixture({ health: 5 });
      const state = bot.floorReflexes;
      state.fleeEpisode = { startedAt: Date.now(), origin: bot.entity.position.clone(), segments: 2, stalls: 2, outcome: 'done' };
      expect(fleeStart(bot, state, Date.now())).toBeNull();
      expect(state.fleeEpisode).toBeUndefined();
      expect(state.lastStandWanted).toBe(true);
    }
  });

  // Run 27: "火の付いたクリーパーから離れる" lasted a second, the blast took 16.4. A lit creeper and no safe way away is the same case as a
  // flee with no way out (whatever the health): a hole when it is dug in time, else a blow that knocks the creeper off, else a block up.
  describe('a lit creeper and no way away (cornered)', () => {
    const lit: unknown[] = []; lit[16] = 1;
    const creeper = { 3: { id: 3, name: 'creeper', position: new Vec3(2.5, 65, 0.5), height: 1.7, metadata: lit } };
    const creeperStands = (ledger: ReturnType<typeof ensureReflexLedger>) => ledger.entriesSince(-1).filter(entry => entry.detail.startsWith('点火したクリーパーから逃げ道なし:'));

    it('at full health, on a pillar (every heading a drop): digs the cell under the feet at once, told in the ledger as a retreat', async () => {
      const { bot, ledger } = fixture({ health: 20, mobs: creeper });
      tick(bot);
      await vi.waitFor(() => expect(bot.__dug).toEqual(['0,64,0']), { timeout: 4000, interval: 5 });
      await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 4000, interval: 5 });
      expect(creeperStands(ledger)).toMatchObject([{ kind: 'retreat', outcome: 'done', detail: '点火したクリーパーから逃げ道なし: 足元を掘って下がった (0,65,0) 体力20' }]);
      // Nothing was run at (the retreat never took the keys).
      expect(bot.floorReflexes.retreat.engagements).toBe(0);
    });

    it('a cell too slow to dig before the blast (digTime over a second): the lit creeper itself is hit, with the best weapon', async () => {
      const { bot, ledger } = fixture({ health: 20, mobs: creeper, items: [SWORD] });
      bot.digTime = () => 5000;
      tick(bot);
      await vi.waitFor(() => expect(bot.attack).toHaveBeenCalledTimes(2), { timeout: 3000, interval: 5 });
      expect(bot.attack).toHaveBeenCalledWith(bot.entities[3]);
      expect(bot.__dug).toEqual([]);
      await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 3000, interval: 5 });
      expect(creeperStands(ledger)).toMatchObject([{ kind: 'retreat', detail: '点火したクリーパーから逃げ道なし: creeper #3 を打って離した (0,65,0) 体力20' }]);
    });

    it('an act running stops as a reflex and says what the body did', async () => {
      const { bot } = fixture({ health: 20, mobs: creeper });
      const acting = runAct(bot, ACT_HANDS.parse([{ do: 'wait', seconds: 5 }, { do: 'jump' }]), undefined, undefined, { tickMs: 20 });
      await settle(60);
      tick(bot);
      const json = JSON.parse((await acting).result);
      expect(json).toMatchObject({ ok: false, stoppedBy: 'reflex' });
      expect(json.stoppedWhy).toContain('点火したクリーパーから逃げ道なし: 足元を掘って下がった');
    });
  });

});
