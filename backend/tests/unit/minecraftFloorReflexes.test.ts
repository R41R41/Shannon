import { describe, expect, it } from 'vitest';
import { Vec3 } from 'vec3';
import { executeAction, physicalActionBusy } from '../../src/services/minebot/execution/ActionExecution.js';
import { creeperLit, floorEatChoice, floorRetreatTick, retreatThreat, type FloorBody, type RetreatState } from '../../src/services/minebot/utils/floorReflexes.js';

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

describe('floor reflexes (ADR-0010 D8, defence only)', () => {
  it('reads a lit creeper from its fuse state or its ignited flag', () => {
    const meta = (index: number, value: unknown) => { const m: unknown[] = []; m[index] = value; return m; };
    expect(creeperLit({ position: new Vec3(0, 0, 0), metadata: meta(16, 1) })).toBe(true);
    expect(creeperLit({ position: new Vec3(0, 0, 0), metadata: meta(18, true) })).toBe(true);
    expect(creeperLit({ position: new Vec3(0, 0, 0), metadata: meta(16, -1) })).toBe(false);
    expect(creeperLit({ position: new Vec3(0, 0, 0) })).toBe(false);
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
