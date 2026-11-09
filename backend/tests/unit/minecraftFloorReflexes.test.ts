import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { executeAction, physicalActionBusy } from '../../src/services/minebot/execution/ActionExecution.js';
import { coverChoice, supportCells, creeperLit, floorEatChoice, floorRetreatTick, retreatThreat, shootersInReach, shootersSeeing, flyingShooterAbove, burningInSight, lastStandChoice, fleeThreat, fleeStart, unseenHeadingPlan, weaklyArmoured, type FloorBody, type FloorState, type RetreatState } from '../../src/services/minebot/utils/floorReflexes.js';
import { markHeadCombat } from '../../src/services/minebot/utils/combatOwner.js';

function body(patch: Partial<FloorBody> & { items?: { name: string }[]; slots?: ({ name: string } | null)[] } = {}) {
  const keys: Record<string, boolean> = {}, looks: number[] = [];
  const self = { id: 1, name: 'player', position: new Vec3(0, 64, 0) };
  const bot: FloorBody & { keys: Record<string, boolean>; looks: number[] } = {
    entity: self, entities: { 1: self }, health: 20, food: 20, heldItem: null,
    inventory: { items: () => patch.items ?? [], slots: patch.slots ?? new Array(46).fill(null) },
    setControlState: (key, value) => { keys[key] = value; }, look: yaw => { looks.push(yaw); },
    on: () => undefined, keys, looks, ...patch,
  };
  return bot;
}
const retreat = (): RetreatState => ({ engaged: false, ticks: 0, cooldown: 0, engagements: 0 });
const add = (bot: FloorBody, id: number, entity: Record<string, unknown>) => { bot.entities![id] = { id, ...entity } as any; };

describe('戦う印の間の食事はcover/fleeと同じ境で待つ', () => {
  it.each([true, false])('wide=%s: 5より上は飢えても待ち、5以下では床が食べる', wide => {
    const bot = body({ health: 5.21, food: 2, items: [{ name: 'cooked_beef' }] });
    expect(floorEatChoice(bot, wide)?.name).toBe('cooked_beef');
    const end = markHeadCombat(bot, 'fight', ['blaze']);
    expect(floorEatChoice(bot, wide)).toBeNull();
    for (const hp of [5, 4.7]) {
      bot.health = hp;
      expect(floorEatChoice(bot, wide)?.name).toBe('cooked_beef');
    }
    bot.health = 6; end();
    // 相手が居ない時は猶予も解け、既存の食事に戻る。
    expect(floorEatChoice(bot, wide)?.name).toBe('cooked_beef');
  });
});

describe('cover digging preserves footing and a way back', () => {
  const field = () => {
    const blocks = new Map<string, string | null>();
    const bot = body({
      blockAt: (p: Vec3) => {
        const at = p.floored(), key = `${at.x},${at.y},${at.z}`;
        const name = blocks.has(key) ? blocks.get(key) : at.y < 64 ? 'stone' : 'air';
        if (name === null) return null;
        return { name, boundingBox: ['stone', 'magma_block', 'oak_fence', 'cobblestone'].includes(name!) ? 'block' : 'empty', position: at };
      },
    } as Partial<FloorBody>);
    bot.entity!.position = new Vec3(0.5, 64, 0.5);
    add(bot, 2, { name: 'blaze', position: new Vec3(20.5, 64, 0.5), height: 1.8 });
    const choose = (options = {}) => coverChoice(bot, shootersInReach(bot, bot.entity!.position), 0, options);
    return { bot, blocks, choose };
  };

  it.each(['air', 'lava', 'magma_block', 'oak_fence', null])('does not dig onto an unsupported or unsafe landing: %s', name => {
    const f = field(); f.blocks.set('0,62,0', name);
    const choice = f.choose();
    expect(choice.cover).toBeNull(); expect(choice.why).toContain('立てない');
  });
  it('does not dig when the lowered feet would be beside fire', () => {
    const f = field(); f.blocks.set('-1,63,0', 'fire');
    const choice = f.choose();
    expect(choice.cover).toBeNull(); expect(choice.why).toContain('fire_near');
  });
  it('does not dig into a pit with no one-step return to safe ground at the original height', () => {
    const f = field(); f.bot.entities![2].position = new Vec3(10.5, 66, 0.5);
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) f.blocks.set(`${x},64,${z}`, 'stone');
    const choice = f.choose();
    expect(choice.cover).toBeNull(); expect(choice.why).toContain('戻れない');
  });
  it('does not dig if descending leaves both sight lines open', () => {
    const f = field(); f.bot.entities![2].position = new Vec3(4.5, 64, 0.5);
    const choice = f.choose();
    expect(choice.cover).toBeNull(); expect(choice.why).toContain('見える線が減らない（2→2）');
  });
  it('uses a carried block on the line when the landing cannot hold the body', () => {
    const f = field(); f.blocks.set('0,62,0', 'air');
    f.bot.inventory!.items = () => [{ name: 'cobblestone', count: 8 }] as any;
    expect(f.choose({ line: true }).cover).toMatchObject({ kind: 'line', block: 'cobblestone' });
  });
  it('S2 raid2: standing across two cells, the line never picks the other cell the body is in (the place hand refuses it)', () => {
    const f = field(); f.blocks.set('0,62,0', 'air');
    f.bot.inventory!.items = () => [{ name: 'cobblestone', count: 8 }] as any;
    f.bot.entity!.position = new Vec3(0.95, 64, 0.5);
    const choice = f.choose({ line: true });
    expect(choice.cover, choice.why).toMatchObject({ kind: 'line', cell: { x: 2, y: 64, z: 0 } });
  });
  it('e01 S11: never digs down into, or steps into, a lying breath cloud', () => {
    const f = field();
    const cloud = { centre: { x: 0.5, y: 63, z: 0.5 }, radius: 7 };
    const choice = f.choose({ clouds: [cloud] });
    expect(choice.cover?.kind, choice.why).not.toBe('dig');
    expect(choice.why).toContain('竜の息の雲');
    // A cloud at the feet's own height takes every step around too; one far off changes nothing.
    f.bot.entities![2].position = new Vec3(4.5, 64, 0.5);
    const free = f.choose({ clouds: [] });
    const near = f.choose({ clouds: [{ centre: { x: 0.5, y: 64, z: 0.5 }, radius: 7 }] });
    if (free.cover?.kind === 'step') expect(near.cover?.kind).not.toBe('step');
    expect(f.choose({ clouds: [{ centre: { x: 40.5, y: 63, z: 0.5 }, radius: 7 }] }).cover?.kind).toBe(free.cover?.kind);
  });
  it('still digs one step when it can land, climb back and reduce exposure', () => {
    const f = field(), choice = f.choose();
    expect(choice.cover, choice.why).toMatchObject({ kind: 'dig', cell: { x: 0, y: 63, z: 0 } });
    expect(choice.cover?.detail).toContain('見える線 2→1');
    expect(coverChoice(f.bot, shootersInReach(f.bot, f.bot.entity!.position), 3).cover).toBeNull();
  });
  it('S2: burning with the shooter far, still the dig; within 6 m, a run first; after a dig that did not lower the body, never the dig', () => {
    const f = field();
    expect(f.choose({ burning: true }).cover).toMatchObject({ kind: 'dig' });
    f.bot.entities![2].position = new Vec3(4.5, 64, 0.5);
    expect(f.choose({ burning: true }).cover).toMatchObject({ kind: 'run', ids: [2] });
    f.bot.entities![2].position = new Vec3(20.5, 64, 0.5);
    expect(f.choose({ noDig: true }).cover).toMatchObject({ kind: 'run', detail: expect.stringContaining('掘っても下がれなかった') });
    // No safe heading (lava all round the floor): no dig either, and why.
    for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) if (x !== 0 || z !== 0) f.blocks.set(`${x},63,${z}`, 'lava');
    const none = f.choose({ noDig: true });
    expect(none.cover).toBeNull();
    expect(none.why).toContain('もう掘らない');
  });
  it('end1108c S9: a step hides the body at first; after two steps of the episode, a block on the line or a run, never a third step', () => {
    const f = field();
    // A wall east of the body hides the cell south of it from the blaze (the line to it crosses x=1 at z≈1.2).
    for (let y = 64; y <= 66; y++) for (let z = 1; z <= 3; z++) f.blocks.set(`1,${y},${z}`, 'stone');
    const first = f.choose();
    expect(first.cover, first.why).toMatchObject({ kind: 'step', to: { x: 0, y: 64, z: 1 } });
    expect(f.choose({ steps: 1 }).cover).toMatchObject({ kind: 'step' });
    const spent = f.choose({ steps: 2 });
    expect(spent.cover, spent.why).toMatchObject({ kind: 'run', detail: expect.stringContaining('横に 2 回動いてもまた撃たれた') });
    f.bot.inventory!.items = () => [{ name: 'cobblestone', count: 8 }] as any;
    const lined = f.choose({ steps: 2, line: true });
    expect(['line', 'run']).toContain(lined.cover?.kind);
  });
  it('S2: counts the cells under the body that hold it up', () => {
    const f = field();
    expect(supportCells(f.bot, 64)).toEqual([{ x: 0, y: 63, z: 0 }]);
    f.bot.entity!.position = new Vec3(0.9, 64, 0.5);
    expect(supportCells(f.bot, 64)).toEqual([{ x: 0, y: 63, z: 0 }, { x: 1, y: 63, z: 0 }]);
  });
});

describe('floor reflexes (ADR-0010 D8, defence only)', () => {
  it('reads a lit creeper from its fuse state or its ignited flag', () => {
    const meta = (index: number, value: unknown) => { const m: unknown[] = []; m[index] = value; return m; };
    expect(creeperLit({ metadata: meta(16, 1) })).toBe(true);
    expect(creeperLit({ metadata: meta(18, true) })).toBe(true);
    expect(creeperLit({ metadata: meta(16, -1) })).toBe(false);
    expect(creeperLit({})).toBe(false);
  });

  // Run 27 (LLM-centric): the step back from a lit creeper lasted about a second and three blocks, and the blast still took 16.4.
  describe('a lit creeper is run from out of its blast (7 m), along a safe heading, and a body that cannot get away is cornered', () => {
    const llm = () => body({} as Partial<FloorBody>);
    /** One tick with the body moved `step` blocks along -x first (a body that runs). */
    const run = (bot: FloorBody, state: RetreatState, step = 0.3) => { bot.entity!.position = bot.entity!.position.offset(-step, 0, 0); return floorRetreatTick(bot, state); };
    it('runs until it is 7 m from the creeper (the old 20 ticks / 3 blocks are long past), or the creeper is gone or no longer lit', () => {
      const bot = llm(), state = retreat(), lit: unknown[] = []; lit[16] = 1;
      add(bot, 2, { name: 'creeper', position: new Vec3(3, 64, 0), metadata: lit });
      expect(floorRetreatTick(bot, state)).toBe('engaged');
      expect(Math.abs(Math.sin(bot.looks[0]) - 1)).toBeLessThan(1e-9);
      // 3.9 blocks run (the creeper is then 6.9 m off): still on, past the old three blocks.
      for (let tick = 0; tick < 13; tick++) expect(run(bot, state)).toBeNull();
      expect(state.engaged).toBe(true);
      expect(bot.keys.forward && bot.keys.sprint).toBe(true);
      // 7 m and more: released, the keys let go.
      expect(run(bot, state)).toBe('released');
      expect(bot.keys.forward || bot.keys.sprint).toBe(false);
      for (const end of ['gone', 'unlit']) {
        const other = llm(), go = retreat(), fuse: unknown[] = []; fuse[16] = 1;
        add(other, 2, { name: 'creeper', position: new Vec3(3, 64, 0), metadata: fuse });
        expect(floorRetreatTick(other, go)).toBe('engaged');
        if (end === 'gone') delete other.entities![2]; else other.entities![2].metadata = [];
        expect(run(other, go), end).toBe('released');
      }
    });
    it('lets go after 40 ticks (2 s) when the creeper keeps up', () => {
      const bot = llm(), state = retreat(), lit: unknown[] = []; lit[16] = 1;
      add(bot, 2, { name: 'creeper', position: new Vec3(3, 64, 0), metadata: lit });
      expect(floorRetreatTick(bot, state)).toBe('engaged');
      let outcome: string | null = null, ticks = 0;
      for (; ticks < 60 && outcome === null; ticks++) { outcome = run(bot, state); bot.entities![2].position = bot.entity!.position.offset(3, 0, 0); }
      expect(outcome).toBe('released');
      expect(ticks).toBe(40);
    });
    it('a body that makes no headway (a wall, a mob in the way) is cornered after 8 ticks; the keys are let go', () => {
      const bot = llm(), state = retreat(), lit: unknown[] = []; lit[16] = 1;
      add(bot, 2, { name: 'creeper', position: new Vec3(3, 64, 0), metadata: lit });
      expect(floorRetreatTick(bot, state)).toBe('engaged');
      let outcome: string | null = null, ticks = 0;
      for (; ticks < 40 && outcome === null; ticks++) outcome = run(bot, state, 0.02);
      expect(outcome).toBe('cornered');
      expect(ticks).toBe(8);
      expect(state.engaged).toBe(false);
      expect(bot.keys.forward || bot.keys.sprint).toBe(false);
    });
    it('no safe heading at all (lava round the feet): cornered at once, the body not run into it; the default mode still steps straight back', () => {
      const lava = (p: Vec3) => {
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        return { name: y < 64 ? 'stone' : y === 64 && !(x === 0 && z === 0) ? 'lava' : 'air', boundingBox: y < 64 ? 'block' : 'empty', position: new Vec3(x, y, z) };
      };
      const bot = body({ blockAt: lava } as Partial<FloorBody>), state = retreat(), lit: unknown[] = []; lit[16] = 1;
      add(bot, 2, { name: 'creeper', position: new Vec3(3, 64, 0), metadata: lit });
      expect(floorRetreatTick(bot, state)).toBe('cornered');
      expect(state.engaged).toBe(false);
      expect(bot.keys.forward).toBeFalsy();
      // Not asked again every tick: the cooldown.
      expect(floorRetreatTick(bot, state)).toBeNull();
    });
    it('turns from a heading that is not safe: a drop straight behind is not run into', () => {
      // A cliff on the -x side (no ground west of x = -1): straight away from a creeper on +x is the cliff, a turn is taken.
      const cliff = (p: Vec3) => {
        const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
        const solid = x >= -1 ? y < 64 : y < 50;
        return { name: solid ? 'stone' : 'air', boundingBox: solid ? 'block' : 'empty', position: new Vec3(x, y, z) };
      };
      const bot = body({ blockAt: cliff } as Partial<FloorBody>), state = retreat(), lit: unknown[] = []; lit[16] = 1;
      add(bot, 2, { name: 'creeper', position: new Vec3(3, 64, 0), metadata: lit });
      expect(floorRetreatTick(bot, state)).toBe('engaged');
      // Not straight to -x (yaw PI/2): the heading has a north or south part.
      expect(Math.abs(Math.cos(state.heading!))).toBeGreaterThan(0.3);
    });
  });
  it('the arrow\'s side-step keeps its 20 ticks / 3 blocks', () => {
    const bot = body(), state = retreat();
    add(bot, 2, { name: 'arrow', position: new Vec3(8, 65, 0), velocity: new Vec3(-2, 0, 0) });
    expect(floorRetreatTick(bot, state)).toBeNull();
    bot.entities![2].position = new Vec3(6, 65, 0);
    expect(floorRetreatTick(bot, state)).toBe('engaged');
    // The arrow keeps coming at the chest for 20 ticks: the side-step is over at the 20th, not the 40th.
    let outcome: string | null = null, ticks = 0;
    for (; ticks < 60 && outcome !== 'released'; ticks++) {
      bot.entities![2].position = new Vec3(6 - 0.1 * (ticks + 1), 65, 0);
      outcome = floorRetreatTick(bot, state);
    }
    expect(outcome).toBe('released');
    expect(ticks).toBe(20);
  });
  it('ends the retreat from an arrow after three blocks', () => {
    const bot = body(), state = retreat();
    add(bot, 2, { name: 'arrow', position: new Vec3(8, 65, 0), velocity: new Vec3(-2, 0, 0) });
    expect(floorRetreatTick(bot, state)).toBeNull();
    bot.entities![2].position = new Vec3(6, 65, 0);
    expect(floorRetreatTick(bot, state)).toBe('engaged');
    bot.entity!.position = new Vec3(-3.1, 64, 0);
    bot.entities![2].position = new Vec3(5.8, 65, 0);
    expect(floorRetreatTick(bot, state)).toBe('released');
  });
  it('ignores an unlit creeper and anything further than its reach', () => {
    const bot = body();
    add(bot, 2, { name: 'creeper', position: new Vec3(2, 64, 0), metadata: [] });
    const far: unknown[] = []; far[16] = 1;
    add(bot, 3, { name: 'creeper', position: new Vec3(8, 64, 0), metadata: far });
    expect(retreatThreat(bot)).toBeNull();
  });
  it('sidesteps an arrow flying at the chest, unless a shield is held (the shield reflex takes it)', () => {
    const bot = body();
    add(bot, 2, { name: 'arrow', position: new Vec3(8, 65, 0), velocity: new Vec3(-2, 0, 0) });
    expect(retreatThreat(bot)?.kind).toBe('arrow');
    // The tick follows each arrow: it engages once the arrow is seen moving (one physics tick, 50 ms, after it appears).
    const state = retreat();
    expect(floorRetreatTick(bot, state)).toBeNull();
    bot.entities![2].position = new Vec3(6, 65, 0);
    expect(floorRetreatTick(bot, state)).toBe('engaged');
    expect(bot.keys.left).toBe(true);
    const shielded = body({ slots: Object.assign(new Array(46).fill(null), { 45: { name: 'shield' } }) });
    add(shielded, 2, { name: 'arrow', position: new Vec3(8, 65, 0), velocity: new Vec3(-2, 0, 0) });
    expect(retreatThreat(shielded)).toBeNull();
    const away = body();
    add(away, 2, { name: 'arrow', position: new Vec3(8, 65, 0), velocity: new Vec3(2, 0, 0) });
    expect(retreatThreat(away)).toBeNull();
  });
  it('leaves the keys to the lava and breathing reflexes while either holds them', () => {
    const bot = body(), state = retreat(), lit: unknown[] = []; lit[16] = 1;
    add(bot, 2, { name: 'creeper', position: new Vec3(3, 64, 0), metadata: lit });
    bot.breathingReflex = { engaged: true };
    expect(floorRetreatTick(bot, state)).toBeNull();
    expect(bot.keys.forward).toBeUndefined();
    bot.breathingReflex = { engaged: false }; bot.lavaReflex = { engaged: true };
    expect(floorRetreatTick(bot, state)).toBeNull();
    bot.lavaReflex = { engaged: false };
    expect(floorRetreatTick(bot, state)).toBe('engaged');
    bot.lavaReflex = { engaged: true };
    expect(floorRetreatTick(bot, state)).toBe('released');
  });
  it('ignores an arrow that has stopped moving, whatever velocity it last reported', () => {
    const bot = body(), arrows = new Map();
    add(bot, 2, { name: 'arrow', position: new Vec3(8, 65, 0), velocity: new Vec3(-2, 0, 0) });
    expect(retreatThreat(bot, arrows)).toBeNull();
    expect(retreatThreat(bot, arrows)).toBeNull();
    bot.entities![2].position = new Vec3(6, 65, 0);
    expect(retreatThreat(bot, arrows)?.kind).toBe('arrow');
  });
});

describe('run62 #14 #17 #11: the floor among shooters', () => {
  /** Stone floor under y 64, air above, with optional walls. */
  const field = (walls: Array<[number, number, number]> = []) => {
    const solid = new Set(walls.map(([x, y, z]) => `${x},${y},${z}`));
    const bot = body({
      health: 6, food: 10, items: [{ name: 'golden_carrot', count: 4 }, { name: 'cobblestone', count: 32 }] as any,
      blockAt: (p: Vec3) => {
        const at = p.floored(), name = at.y < 64 || solid.has(`${at.x},${at.y},${at.z}`) ? 'stone' : 'air';
        return { name, boundingBox: name === 'stone' ? 'block' : 'empty', position: at };
      },
    } as Partial<FloorBody>);
    bot.entity!.position = new Vec3(0.5, 64, 0.5);
    (bot.entity as any).metadata = [0];
    return bot;
  };
  const burn = (bot: FloorBody) => { (bot.entity as any).metadata = [1]; };

  it('#14: a blaze 2.5 above and in sight stops the pillar of the last stand; level with the body, or out of sight, it does not', () => {
    const bot = field();
    bot.entities![9] = { id: 9, name: 'zombie', type: 'hostile', position: new Vec3(5.5, 64, 0.5), height: 1.95 } as any;
    expect(lastStandChoice(bot, 'dig')?.kind).toBe('pillar');
    add(bot, 20475, { name: 'blaze', position: new Vec3(3.5, 66.5, 0.5), height: 1.8 });
    expect(flyingShooterAbove(bot)).toBe('blaze #20475');
    expect(lastStandChoice(bot, 'dig')).toBeNull();
    bot.entities![20475].position = new Vec3(0.5, 64, 5.5);
    expect(flyingShooterAbove(bot)).toBeNull();
    expect(lastStandChoice(bot, 'dig')?.kind).toBe('pillar');
    const walled = field([[2, 64, 0], [2, 65, 0], [2, 66, 0], [2, 67, 0], [2, 68, 0], [2, 69, 0]]);
    add(walled, 20475, { name: 'blaze', position: new Vec3(3.5, 66.5, 0.5), height: 1.8 });
    expect(flyingShooterAbove(walled)).toBeNull();
  });

  it('#14: burning in sight of a blaze the floor does not eat above 5; at 5 or less it does; not burning it does', () => {
    const bot = field();
    add(bot, 20475, { name: 'blaze', position: new Vec3(5.5, 66, 0.5), height: 1.8 });
    expect(floorEatChoice(bot)?.name).toBe('golden_carrot');
    burn(bot);
    expect(burningInSight(bot)).toBe(true);
    expect(floorEatChoice(bot)).toBeNull();
    bot.health = 4.95;
    expect(floorEatChoice(bot)?.name).toBe('golden_carrot');
  });

  it('#11: armour 4 or less and no shield is a body the first arrow moves; a shield in the off hand or iron on the chest is not', () => {
    expect(weaklyArmoured(field())).toBe(true);
    const shielded = field(); shielded.inventory!.slots![45] = { name: 'shield' } as any;
    expect(weaklyArmoured(shielded)).toBe(false);
    const iron = field(); iron.inventory!.slots![6] = { name: 'iron_chestplate' } as any;
    expect(weaklyArmoured(iron)).toBe(false);
    const leather = field(); leather.inventory!.slots![6] = { name: 'leather_chestplate' } as any; leather.inventory!.slots![5] = { name: 'leather_helmet' } as any;
    expect(weaklyArmoured(leather)).toBe(true);
  });

  it('#17: a skeleton that cannot see the body is no threat to run from; one that sees it is', () => {
    const bot = field([[2, 64, 0], [2, 65, 0], [2, 66, 0]]);
    bot.health = 4;
    add(bot, 9727, { name: 'skeleton', type: 'hostile', position: new Vec3(5.5, 64, 0.5), height: 1.99 });
    expect(fleeThreat(bot)).toBeNull();
    delete bot.entities![9727];
    add(bot, 9728, { name: 'skeleton', type: 'hostile', position: new Vec3(0.5, 64, 6.5), height: 1.99 });
    expect(fleeThreat(bot)?.threats).toHaveLength(1);
  });

  it('#17: for 4 s after the cover cut the line, the low-health flee does not start (unless a melee enemy is within 4 m)', () => {
    const bot = field();
    bot.health = 4;
    add(bot, 9727, { name: 'skeleton', type: 'hostile', position: new Vec3(0.5, 64, 6.5), height: 1.99 });
    const now = 1_000_000;
    const state = { retreat: { engaged: false, ticks: 0, cooldown: 0, engagements: 0 }, busy: null, retryAt: 0, engagements: { eat: 0, armor: 0, flee: 0 }, fleeStarts: [] } as FloorState;
    state.coverCutAt = now - 1000;
    expect(fleeStart(bot, state, now)).toBeNull();
    add(bot, 5, { name: 'zombie', type: 'hostile', position: new Vec3(-2.5, 64, 0.5), height: 1.95 });
    expect(fleeStart(bot, state, now)).not.toBeNull();
    delete bot.entities![5];
    expect(fleeStart(bot, { ...state, fleeEpisode: undefined, coverCutAt: now - 4500 }, now)).not.toBeNull();
  });

  it('#17: the flee takes a heading whose next cells the shooter cannot see, when there is one', () => {
    // A wall along x = 2 from z = -6 to z = 1: the skeleton at (6.5, 64, 0.5) sees the body; north (z < 0) behind the wall is out of its sight.
    const wall: Array<[number, number, number]> = [];
    for (let z = -6; z <= 0; z++) for (const y of [64, 65, 66]) wall.push([2, y, z]);
    const bot = field(wall);
    bot.entity!.position = new Vec3(0.5, 64, 2.5);
    add(bot, 9727, { name: 'skeleton', type: 'hostile', position: new Vec3(6.5, 64, 3.5), height: 1.99 });
    const seeing = shootersSeeing(bot, shootersInReach(bot, bot.entity!.position), bot.entity!.position);
    expect(seeing).toHaveLength(1);
    const plan = unseenHeadingPlan(bot, [bot.entities![9727].position], undefined, seeing);
    expect(plan).not.toBeNull();
    const ahead = new Vec3(Math.floor(0.5 - Math.sin(plan!.yaw) * 3) + 0.5, 64, Math.floor(2.5 - Math.cos(plan!.yaw) * 3) + 0.5);
    expect(ahead.z).toBeLessThan(2);
  });
});
