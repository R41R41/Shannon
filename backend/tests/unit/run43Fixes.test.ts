import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Vec3 } from 'vec3';
import { createGround, stepContext, type Ground } from '../helpers/practiceGround.js';
import { furnace } from '../../src/services/minebot/utils/primitives/furnace.js';
import { furnaceDoneWords, furnacesDueByNow } from '../../src/services/minebot/utils/furnaceDone.js';
import { isHeadCombatActive, isHeadCombatRunning, markHeadCombat } from '../../src/services/minebot/utils/combatOwner.js';
import { bodyOverlap, placeFacts } from '../../src/services/minebot/utils/placeFacts.js';
import { installFloorReflexes } from '../../src/services/minebot/utils/floorReflexes.js';
import { floorConfig } from '../../src/services/minebot/utils/floorConfig.js';
import { ensureReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';

// Run 43 (2026-10-27): what the body said or did wrong in the run, as unit cases.
let ground: Ground | null = null;
afterEach(() => { ground?.stop(); ground = null; });
const open = () => { ground?.stop(); ground = createGround({ pathfinder: false }); ground.bot.activeFurnaces = []; ground.start(); return ground; };
const cell = (x: number, y: number, z: number) => ({ x, y, z });

describe('run 43: the furnace says what its fuel smelts', () => {
  it('+720 q69: raw_iron ×15 with one plank smelts one or so, says the fuel the rest needs, and the time it stops (not 150 s)', async () => {
    const g = open();
    g.set(10, 64, 8, 'furnace');
    g.give('raw_iron', 15); g.give('spruce_planks', 1); g.give('crafting_table', 1);
    const outcome = await furnace(stepContext(g.bot), { at: cell(10, 64, 8), put: { item: 'raw_iron', count: 15 }, fuel: { item: 'spruce_planks', count: 1 } });
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toMatch(/燃料で焼けるのは約 [12] 個まで（材料 15）。あと 1[34] 個分の燃料が要る（石炭か木炭 2 か板 (9|10)）。約\d+秒で止まる/u);
    expect(outcome.text).not.toContain('焼き上がり 約150秒後');
    const batch = (g.bot.activeFurnaces as Array<{ count: number; unfueledCount?: number; readyAt: number }>)[0];
    expect(batch.count + (batch.unfueledCount ?? 0)).toBe(15);
    expect(batch.unfueledCount).toBeGreaterThanOrEqual(13);
    expect(batch.readyAt - Date.now()).toBeLessThan(25_000);
  }, 30_000);

  it('says the last planks burnt with no table carried', async () => {
    const g = open();
    g.set(10, 64, 8, 'furnace');
    g.give('raw_iron', 4); g.give('oak_planks', 3);
    const outcome = await furnace(stepContext(g.bot), { at: cell(10, 64, 8), put: { item: 'raw_iron', count: 4 }, fuel: { item: 'oak_planks', count: 3 } });
    expect(outcome.text).toContain('作業台を持たず、板は残り 0（作業台は板 4。地下で作業台が要る時に作れない。燃料は石炭・木炭を先に）');
  }, 30_000);

  it('a batch out of fuel is said as stopped with how many smelted, at its time and after a wait', () => {
    const batch = { pos: { x: 10, y: 64, z: 8 }, item: 'raw_iron', count: 1, unfueledCount: 14, readyAt: 1_010, startedAt: 1_000 };
    expect(furnaceDoneWords(batch)).toBe('かまど (10,64,8) は燃料切れで止まった（焼けたのは約 1 個。raw_iron 14 個は燃料が要る）');
    expect(furnaceDoneWords({ ...batch, unfueledCount: undefined, count: 8 })).toBe('かまど (10,64,8) の焼きが終わった');
    const body = { activeFurnaces: [{ ...batch }], game: { dimension: 'overworld' } };
    expect(furnacesDueByNow(body, 1_005)).toEqual([]);
    expect(furnacesDueByNow(body, 60_000)).toEqual(['かまど (10,64,8) は燃料切れで止まった（焼けたのは約 1 個。raw_iron 14 個は燃料が要る）']);
    expect(furnacesDueByNow(body, 90_000)).toEqual([]);
  });
});

describe('run 43: the grace after a fight hand holds the floor for its own target, and never the melee hand', () => {
  // 18:36:38: fight #5502 (drowned) ended at once, lost; drowned #5493 at 0.8 m hit her from health 12.7 to 4.4 while nothing struck back.
  const body = (health: number) => ({ health, entity: { id: 1, position: new Vec3(193, 63, 204) },
    entities: { 5493: { id: 5493, name: 'drowned', type: 'hostile', position: new Vec3(193, 63, 205) } } as Record<string, any>, registry: null });
  it('ends with the fight: another drowned near does not hold the grace, and the melee hand is free once the hand has ended', () => {
    const bot = body(11.3);
    const end = markHeadCombat(bot, 'fight', ['drowned'], Date.now(), 5502);
    expect(isHeadCombatRunning(bot)).toBe(true);
    expect(isHeadCombatActive(bot)).toBe(true);
    end();
    expect(isHeadCombatRunning(bot)).toBe(false);
    expect(isHeadCombatActive(bot)).toBe(false);
  });
  it('still holds the floor (not the melee hand) for the fight\'s own target within the grace', () => {
    const bot = body(11.3);
    bot.entities[5502] = { id: 5502, name: 'drowned', type: 'hostile', position: new Vec3(195, 63, 207) };
    markHeadCombat(bot, 'fight', ['drowned'], Date.now(), 5502)();
    expect(isHeadCombatActive(bot)).toBe(true);
    expect(isHeadCombatRunning(bot)).toBe(false);
  });
});

describe('run 43: a refused place says what it met', () => {
  it('the overlap of the body with the cell, the top of the jump and the cell over the head', () => {
    expect(bodyOverlap({ x: 196.5, y: 40, z: 209.5 }, cell(196, 40, 209))).toBeCloseTo(1, 5);
    expect(bodyOverlap({ x: 196.5, y: 41.1, z: 209.5 }, cell(196, 40, 209))).toBe(0);
    expect(bodyOverlap({ x: 196.5, y: 40.9, z: 209.5 }, cell(196, 40, 209))).toBeCloseTo(0.1, 5);
    const bot = { entity: { position: new Vec3(196.5, 40.9, 209.5) }, blockAt: (p: Vec3) => ({ name: p.y === 42 ? 'stone' : 'air' }) };
    expect(placeFacts(bot, cell(196, 40, 209), 41.15)).toBe('置こうとしたマス (196,40,209)・足 y=40.90・跳びの最高 y=41.15・体との重なり 高さ 0.10・頭の上 (196,42,209) は stone');
  });
});

describe('run 43, 18:36:46 to 18:36:51: a drowned hits her after her fight hand at another drowned has ended', () => {
  // The floor of llmcR9Body's scenes: a fake body on stone, the floor installed, a swing hurts the creature 20 ms later.
  type Cell = { name: string; boundingBox: string };
  const field = (_x: number, y: number, _z: number): Cell => (y < 63 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' });
  const IRON_SWORD = { name: 'iron_sword', type: 20, count: 1 };
  function scene(health: number, mobs: Record<string, any>, now: () => number) {
    const bot: any = Object.assign(new EventEmitter(), {
      __swings: [] as number[],
      entity: { id: 1, name: 'player', position: new Vec3(193.5, 63, 204.5), yaw: 0, pitch: 0, onGround: true, metadata: [0] },
      health, food: 16, game: { dimension: 'overworld' }, entities: mobs,
      registry: { blocksByName: { cobblestone: { id: 1 } }, entitiesByName: { drowned: { type: 'hostile' } }, itemsByName: {}, items: {} },
      heldItem: null, inventory: { items: () => [IRON_SWORD], slots: new Array(46).fill(null) }, controlState: {} as Record<string, boolean>,
      executingSkill: false, interruptExecution: false, clearControlStates: vi.fn(), look: vi.fn(async () => undefined), lookAt: vi.fn(async () => undefined),
      equip: vi.fn(async (item: any) => { bot.heldItem = item; }), consume: vi.fn(async () => undefined), stopDigging: () => undefined,
      attack: vi.fn((entity: any) => { bot.__swings.push(entity.id); setTimeout(() => { entity.health -= 6; bot.emit('entityHurt', entity); }, 20); }),
      setControlState: vi.fn(), placeBlock: vi.fn(async () => undefined),
      blockAt: (position: Vec3) => { const x = Math.floor(position.x), y = Math.floor(position.y), z = Math.floor(position.z); return { diggable: true, hardness: 1.5, ...field(x, y, z), position: new Vec3(x, y, z) }; },
    });
    bot.pathfinder = { movements: null, setMovements(m: unknown) { this.movements = m; }, stop: () => undefined, setGoal: () => undefined, goto: vi.fn(async () => undefined) };
    const ledger = ensureReflexLedger(bot);
    installFloorReflexes(bot, floorConfig({}), { fleeTickMs: 1, now });
    return { bot, ledger };
  }
  it('strikes back: the ended fight\'s grace is #5502\'s, not every drowned\'s (the melee reflex stood still for 5 s, health 12.7 to 4.4)', async () => {
    const clock = { at: 60_000_000 };
    const drowned = { id: 5493, name: 'drowned', type: 'hostile', height: 1.95, width: 0.6, position: new Vec3(194.6, 63, 204.5), health: 20 };
    const { bot, ledger } = scene(12.7, { 5493: drowned }, () => clock.at);
    // q131 at 18:36:38: fight #5502, lost at once (out of sight).
    markHeadCombat(bot, 'fight', ['drowned'], Date.now(), 5502)();
    clock.at += 300; bot.emit('physicsTick');
    bot.health = 11.3;
    for (let i = 0; i < 4 && !bot.__swings.length; i++) {
      clock.at += 300; bot.emit('physicsTick');
      await vi.waitFor(() => expect(bot.floorReflexes.busy).toBeNull(), { timeout: 8000, interval: 5 });
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    expect(bot.__swings[0]).toBe(5493);
    expect(ledger.entriesSince(-1).some(entry => entry.kind === 'melee')).toBe(true);
  });
});
