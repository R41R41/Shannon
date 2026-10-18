import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { actionSignal, executeAction } from '../../src/services/minebot/execution/ActionExecution.js';
import { describe, expect, it, vi } from 'vitest';
import { NativeCommonFcaBody } from '../../src/services/minebot/integration/commonFca/nativeBody.js';
import { floorConfig } from '../../src/services/minebot/utils/floorConfig.js';
import { ARROW_GAP_LOW_HEALTH_MS, ARROW_GAP_MS, BUDGET_ALLOWANCE_MS, BUDGET_WINDOW_MS, CRITICAL_EAT_RETRY_MS, eatIsCritical, FloorBudget, LATCH_AFTER, LATCH_MS, RETRY_BASE_MS, RETRY_MAX_MS } from '../../src/services/minebot/utils/floorBudget.js';
import { floorActive, floorSilenced, installFloorReflexes } from '../../src/services/minebot/utils/floorReflexes.js';
import { ensureReflexLedger } from '../../src/services/minebot/utils/reflexLedger.js';

// A turn of the event loop, not a timer: a timer of 0 ms takes 15 ms on Windows, and these loops are a thousand ticks long.
const settle = (ms = 0) => ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : new Promise(resolve => setImmediate(resolve));

describe('FloorBudget (P8 design R1, review M3)', () => {
  const clock = () => { let at = 1_000_000; return { now: () => at, advance: (ms: number) => { at += ms; } }; };
  it('lets an arrow step-aside come again only after its gap: two seconds, one at 6 health or less', () => {
    const time = clock(), budget = new FloorBudget(time.now);
    expect(budget.allow('arrow', 20)).toBe(true);
    budget.end('arrow', time.now() - 1000, 'done');
    time.advance(ARROW_GAP_MS - 1); expect(budget.allow('arrow', 20)).toBe(false);
    time.advance(1); expect(budget.allow('arrow', 20)).toBe(true);
    expect(budget.allow('arrow', 5)).toBe(true);
    budget.end('arrow', time.now() - 1000, 'done');
    time.advance(ARROW_GAP_LOW_HEALTH_MS - 1); expect(budget.allow('arrow', 5)).toBe(false);
    time.advance(1); expect(budget.allow('arrow', 5)).toBe(true);
  });
  it('allows 15 seconds of reflex time in 60, says so once when it runs out, and has room again as the window moves on', () => {
    const time = clock(), said: string[] = [], budget = new FloorBudget(time.now, detail => said.push(detail));
    for (let i = 0; i < 15; i++) { expect(budget.allow('eat', 20)).toBe(true); time.advance(1000); budget.end('eat', time.now() - 1000, 'done'); }
    expect(budget.spent()).toBe(BUDGET_ALLOWANCE_MS);
    expect(budget.allow('eat', 20)).toBe(false); expect(budget.allow('armor', 20)).toBe(false); expect(budget.allow('arrow', 20)).toBe(false);
    expect(said).toHaveLength(1);
    expect(budget.silenced()).toEqual(['budget']);
    // At 6 health or less it does not apply.
    expect(budget.allow('eat', 6)).toBe(true);
    // The window moves on.
    time.advance(BUDGET_WINDOW_MS); expect(budget.allow('eat', 20)).toBe(true); expect(budget.silenced()).toEqual([]);
  });
  it('backs a failed meal off (3 s, 6 s), latches it after three in a row for a minute, and says so', () => {
    const time = clock(), said: string[] = [], budget = new FloorBudget(time.now, detail => said.push(detail));
    const fail = () => { expect(budget.allow('eat', 10)).toBe(true); time.advance(100); budget.end('eat', time.now() - 100, 'failed'); };
    fail(); expect(budget.allow('eat', 10)).toBe(false);
    time.advance(RETRY_BASE_MS); fail(); time.advance(RETRY_BASE_MS * 2 - 1); expect(budget.allow('eat', 10)).toBe(false);
    time.advance(1); fail();
    expect(said).toHaveLength(1); expect(said[0]).toContain(`${LATCH_AFTER}回続けて失敗`);
    expect(budget.silenced()).toEqual(['eat']);
    time.advance(LATCH_MS - 1); expect(budget.allow('eat', 10)).toBe(false);
    time.advance(1); expect(budget.allow('eat', 10)).toBe(true);
    // One more failure closes it again, for twice as long; the other reflexes were never held.
    budget.end('eat', time.now() - 100, 'failed'); expect(said).toHaveLength(2); expect(said[1]).toContain(`${LATCH_MS * 2 / 1000}秒`);
    expect(budget.allow('armor', 20)).toBe(true);
  });
  it('a success clears the failures and the latch rounds; a cut-off meal is only retried in three seconds and is not a failure', () => {
    const time = clock(), budget = new FloorBudget(time.now);
    for (let i = 0; i < LATCH_AFTER - 1; i++) { time.advance(30_000); budget.end('armor', time.now() - 10, 'failed'); }
    time.advance(30_000); budget.end('armor', time.now() - 10, 'done');
    for (let i = 0; i < LATCH_AFTER - 1; i++) { time.advance(30_000); budget.end('armor', time.now() - 10, 'failed'); }
    expect(budget.silenced()).toEqual([]);
    const cut = new FloorBudget(time.now);
    for (let i = 0; i < 10; i++) { time.advance(RETRY_BASE_MS); cut.end('eat', time.now() - 10, 'cut'); }
    expect(cut.silenced()).toEqual([]);
    expect(cut.allow('eat', 20)).toBe(false); time.advance(RETRY_BASE_MS); expect(cut.allow('eat', 20)).toBe(true);
  });
  it('does not meter the meal at 6 health or less, or starving (food 6 or less): no allowance, no latch, only a 3 s wait after one that failed (P8 third review, M2)', () => {
    for (const [label, health, food] of [['low health', 5, 17], ['starving', 20, 4], ['both', 3, 1], ['edge: 6 health', 6, 17], ['edge: food 6', 20, 6]] as const) {
      const time = clock(), said: string[] = [], budget = new FloorBudget(time.now, detail => said.push(detail));
      // The allowance is spent on other things, and the arrow's own cooldown runs: the meal is outside both.
      budget.end('armor', time.now() - BUDGET_ALLOWANCE_MS, 'done');
      expect(budget.allow('armor', 20), label).toBe(false);
      said.length = 0; // (the armour's own refusal said the allowance had run out)
      for (let attempt = 0; attempt < 10; attempt++) {
        expect(budget.allow('eat', health, food), `${label} #${attempt}`).toBe(true);
        time.advance(200); budget.end('eat', time.now() - 200, 'failed');
        // The short wait: closed for 3 s, open again at 3 s.
        time.advance(CRITICAL_EAT_RETRY_MS - 1); expect(budget.allow('eat', health, food), label).toBe(false);
        time.advance(1);
      }
      expect(said, label).toEqual([]); expect(budget.silenced().includes('eat'), label).toBe(false);
      // Its time is not the allowance's: only the armour's span is in it.
      expect(budget.spent(), label).toBe(BUDGET_ALLOWANCE_MS);
      // A cut meal waits the same 3 s; a meal that worked clears the wait.
      budget.end('eat', time.now() - 10, 'cut'); expect(budget.allow('eat', health, food), label).toBe(false);
      time.advance(CRITICAL_EAT_RETRY_MS); expect(budget.allow('eat', health, food), label).toBe(true);
      budget.end('eat', time.now() - 10, 'failed'); budget.end('eat', time.now() - 10, 'done'); expect(budget.allow('eat', health, food), label).toBe(true);
    }
  });
  it('one definition of "critical" for the floor\'s choice, its tick and the budget (P8 sixth review, L5): at health 6 or less with food 18 or 19 a meal is a top-up, and the budget latches it like any other', () => {
    expect(eatIsCritical(6, 17)).toBe(true); expect(eatIsCritical(6, 18)).toBe(false); expect(eatIsCritical(1, 19)).toBe(false);
    expect(eatIsCritical(7, 6)).toBe(true); expect(eatIsCritical(7, 7)).toBe(false); expect(eatIsCritical(20, 0)).toBe(true);
    // The budget's behaviour is the definition's, over every health and food: three failures in a row latch a metered meal for a minute, and a critical one never.
    for (let health = 1; health <= 20; health++) for (let food = 0; food <= 20; food++) {
      const time = clock(), budget = new FloorBudget(time.now);
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(budget.allow('eat', health, food), `${health}/${food} #${attempt}`).toBe(true);
        time.advance(100); budget.end('eat', time.now() - 100, 'failed'); time.advance(RETRY_MAX_MS);
      }
      expect(budget.allow('eat', health, food), `${health}/${food} after three failures`).toBe(eatIsCritical(health, food));
    }
  });  it('still meters the meal when it is not critical (7 health or more and food above 6), and a critical meal that failed leaves no failure behind for it', () => {
    const time = clock(), budget = new FloorBudget(time.now);
    expect(budget.allow('eat', 5, 17)).toBe(true); budget.end('eat', time.now() - 10, 'failed'); budget.end('eat', time.now() - 10, 'failed'); budget.end('eat', time.now() - 10, 'failed');
    // Health came back: the last three failures were not counted against the metered meal.
    time.advance(CRITICAL_EAT_RETRY_MS);
    expect(budget.allow('eat', 7, 7)).toBe(true); budget.end('eat', time.now() - 10, 'failed');
    expect(budget.allow('eat', 7, 7)).toBe(false);
    expect(budget.silenced()).toEqual([]);
  });
});

function fixture(patch: Record<string, unknown> = {}) {
  const bot: any = Object.assign(new EventEmitter(), { entity: { id: 1, name: 'player', position: new Vec3(0, 65, 0), yaw: 0, pitch: 0, onGround: true },
    health: 20, food: 20, game: { dimension: 'overworld' }, entities: {} as Record<string, any>,
    inventory: { items: () => [] as any[], slots: new Array(46).fill(null) }, controlState: {} as Record<string, boolean>, executingSkill: false, interruptExecution: false,
    clearControlStates: vi.fn(), setControlState: vi.fn(), look: vi.fn(async () => {}), equip: vi.fn(async () => {}), consume: vi.fn(async () => {}), ...patch });
  return { bot, ledger: ensureReflexLedger(bot) };
}
function clock() { let at = 5_000_000; return { now: () => at, advance: (ms: number) => { at += ms; } }; }

describe('arrow spam cannot keep the body in reflex for good', () => {
  /** A skeleton's arrows without end: an arrow that moves each tick toward the chest. */
  async function volley(config: ReturnType<typeof floorConfig>, health: number, seconds: number) {
    const time = clock();
    const { bot, ledger } = fixture({ health });
    bot.entities[7] = { id: 7, name: 'arrow', position: new Vec3(8, 66, 0), velocity: new Vec3(-2, 0, 0) };
    installFloorReflexes(bot, config, { now: time.now });
    let activeTicks = 0, silencedSeen = false;
    for (let tick = 0; tick < seconds * 20; tick++) {
      time.advance(50);
      bot.entities[7].position = new Vec3(tick % 2 ? 7.9 : 8, 66, 0);
      bot.emit('physicsTick'); await settle(0);
      if (floorActive(bot)) activeTicks++;
      if (floorSilenced(bot)) silencedSeen = true;
    }
    return { bot, ledger, activeSeconds: activeTicks / 20, silencedSeen };
  }
  it('without the budget the step-aside comes every second and a half (the old behaviour, denied by `budget`)', async () => {
    const { bot } = await volley(floorConfig({ MINEBOT_FCA_REFLEX_OFF: 'budget' }), 20, 60);
    expect(bot.floorReflexes.retreat.engagements).toBeGreaterThanOrEqual(30);
    expect(bot.floorReflexes.budget).toBeUndefined();
  }, 20_000);
  it('with it the step-aside has a gap and an allowance: at most 15 s of reflex in 60, said once, and silenced after', async () => {
    const { bot, ledger, activeSeconds, silencedSeen } = await volley(floorConfig({}), 20, 60);
    expect(bot.floorReflexes.retreat.engagements).toBeLessThanOrEqual(17);
    expect(activeSeconds).toBeLessThanOrEqual(17);
    expect(silencedSeen).toBe(true);
    expect(ledger.entriesSince(-1).filter(entry => entry.kind === 'budget')).toHaveLength(1);
    expect(ledger.summary()!.recent.some(entry => entry.kind === 'budget')).toBe(true);
  }, 20_000);
  it('at 6 health or less the allowance does not apply (it still keeps its gap), so the body is not left to the arrows', async () => {
    const { bot, silencedSeen } = await volley(floorConfig({}), 5, 60);
    expect(bot.floorReflexes.retreat.engagements).toBeGreaterThan(17);
    expect(silencedSeen).toBe(false);
  }, 20_000);
  it('a lit creeper is never held back by it, whatever the allowance', async () => {
    const time = clock(), { bot } = fixture();
    installFloorReflexes(bot, floorConfig({}), { now: time.now });
    // Spend the whole allowance first, on arrows.
    bot.floorReflexes.budget!.end('eat', time.now() - BUDGET_ALLOWANCE_MS, 'done');
    expect(bot.floorReflexes.budget!.allow('arrow', 20)).toBe(false);
    const lit: unknown[] = []; lit[16] = 1;
    bot.entities[3] = { id: 3, name: 'creeper', position: new Vec3(3, 65, 0), metadata: lit };
    bot.emit('physicsTick'); await settle(2);
    expect(bot.floorReflexes.retreat.engaged).toBe(true);
    expect(bot.setControlState).toHaveBeenCalledWith('forward', true);
  });
});

describe('a meal that keeps failing is tried a few times and then reported, not looped (not critical: 7 to 12 health, food above 6)', () => {
  async function hungry(config: ReturnType<typeof floorConfig>, seconds: number, health = 10, food = 15) {
    const time = clock();
    const { bot, ledger } = fixture({ health, food, inventory: { items: () => [{ name: 'bread' }], slots: new Array(46).fill(null) },
      consume: vi.fn(async () => { throw new Error('the server never answered'); }) });
    installFloorReflexes(bot, config, { now: time.now });
    let activeWhileLatched = false;
    for (let tick = 0; tick < seconds * 10; tick++) {
      time.advance(100);
      bot.emit('physicsTick'); await settle(0);
      if (floorSilenced(bot) && floorActive(bot)) activeWhileLatched = true;
    }
    return { bot, ledger, time, activeWhileLatched };
  }
  it('tries 3 times in the first 9 s, closes the latch, tells the mind, and the API\'s fast judgment is no longer held off', async () => {
    const { bot, ledger, activeWhileLatched } = await hungry(floorConfig({}), 40);
    expect(bot.consume).toHaveBeenCalledTimes(3);
    expect(floorSilenced(bot)).toBe('eat');
    expect(floorActive(bot)).toBe(false); expect(activeWhileLatched).toBe(false);
    const notes = ledger.entriesSince(-1).filter(entry => entry.kind === 'budget');
    expect(notes).toHaveLength(1); expect(notes[0].detail).toContain('食事');
    expect(ledger.summary()!.recent.some(entry => entry.kind === 'budget')).toBe(true);
    // Each failed attempt is in the ledger as the failure it was.
    expect(ledger.entriesSince(-1).filter(entry => entry.kind === 'eat' && entry.outcome === 'failed')).toHaveLength(3);
  }, 20_000);
  it('tries again when the latch has run out, once, and then closes it for longer', async () => {
    const { bot } = await hungry(floorConfig({}), 100);
    expect(bot.consume.mock.calls.length).toBe(4);
    expect(floorSilenced(bot)).toBe('eat');
  }, 20_000);
  it('a meal that works clears it all, and the floor eats again as soon as it is short of food', async () => {
    const time = clock();
    const items = [{ name: 'bread' }];
    const { bot } = fixture({ health: 5, food: 2, inventory: { items: () => items, slots: new Array(46).fill(null) } });
    installFloorReflexes(bot, floorConfig({}), { now: time.now });
    for (let round = 0; round < 3; round++) { bot.emit('physicsTick'); await settle(2); time.advance(100); }
    expect(bot.consume.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(floorSilenced(bot)).toBeNull();
  });
  it('the facts say nothing when nothing is held, and the budget can be denied (the old fixed 3 s retry then applies)', async () => {
    const { bot } = fixture(); installFloorReflexes(bot, floorConfig({ MINEBOT_FCA_REFLEX_OFF: 'budget' }));
    expect(floorSilenced(bot)).toBeNull(); expect(floorSilenced({})).toBeNull();
  });
});

describe('a meal that is critical (6 health or less, or starving) is never latched: it keeps trying every 3 s (P8 third review, M2)', () => {
  async function critical(health: number, food: number, seconds: number, consume: () => Promise<void>) {
    const time = clock();
    const { bot, ledger } = fixture({ health, food, inventory: { items: () => [{ name: 'bread' }], slots: new Array(46).fill(null) }, consume: vi.fn(consume) });
    installFloorReflexes(bot, floorConfig({}), { now: time.now });
    let silenced = false;
    for (let tick = 0; tick < seconds * 10; tick++) { time.advance(100); bot.emit('physicsTick'); await settle(0); if (floorSilenced(bot)) silenced = true; }
    return { bot, ledger, silenced };
  }
  const broken = async () => { throw new Error('the server never answered'); };
  it.each([['5 health', 5, 10], ['starving', 20, 3], ['both', 4, 2], ['6 health', 6, 10], ['food 6', 20, 6]] as const)('%s: a meal that keeps failing is tried about every 3 s for a minute, never latched, and said in the ledger as it was', async (_label, health, food) => {
    const { bot, ledger, silenced } = await critical(health, food, 60, broken);
    // Every 3 s and a little (the attempt itself): 60 s holds 15 to 20 tries, where the metered meal would have had 3 and a latch.
    expect(bot.consume.mock.calls.length).toBeGreaterThanOrEqual(15); expect(bot.consume.mock.calls.length).toBeLessThanOrEqual(21);
    expect(silenced).toBe(false); expect(floorSilenced(bot)).toBeNull();
    expect(ledger.entriesSince(-1).filter(entry => entry.kind === 'budget')).toHaveLength(0);
    expect(ledger.entriesSince(-1).filter(entry => entry.kind === 'eat' && entry.outcome === 'failed').length).toBeGreaterThanOrEqual(15);
    // It does not spin: at most about one try per 3 s, and none of the time is counted against the allowance.
    expect(bot.floorReflexes.budget!.spent()).toBe(0);
  }, 20_000);
});

describe('the observation says what the budget holds back (facts.floorSilenced)', () => {
  it('is null when nothing is held, and names the held reflex while a latch is closed', async () => {
    const time = clock();
    const { bot } = fixture({ health: 10, food: 15, inventory: { items: () => [{ name: 'bread' }], slots: new Array(46).fill(null) },
      consume: vi.fn(async () => { throw new Error('the server never answered'); }), instantSkills: { getSkills: () => [] } });
    installFloorReflexes(bot, floorConfig({}), { now: time.now });
    const body = new NativeCommonFcaBody(bot, { serverId: 'home', capture: async () => { throw Error('unused'); } });
    expect(body.observe().facts.floorSilenced).toBeNull();
    for (let tick = 0; tick < 150; tick++) { time.advance(100); bot.emit('physicsTick'); await settle(0); }
    expect(body.observe().facts).toMatchObject({ floorSilenced: 'eat', floorActive: false });
    await body.dispose();
  });
});

describe('the default-mode top-up meal (owner criterion: better than before; the legacy auto-eat trigger)', () => {
  const bread = { items: () => [{ name: 'bread' }], slots: new Array(46).fill(null) };
  async function run(env: Record<string, string>, patch: Record<string, unknown>, command = false) {
    const time = clock(), { bot } = fixture({ inventory: bread, ...patch });
    bot.consume = vi.fn(async () => { bot.food = 20; });
    installFloorReflexes(bot, floorConfig(env), { now: time.now });
    let finish: (() => void) | undefined, work: Promise<unknown> | undefined;
    if (command) {
      work = executeAction(bot, 'mine-block', 0, async () => { await new Promise<void>(resolve => { finish = resolve; actionSignal(bot)?.addEventListener('abort', () => resolve()); }); return { success: true, result: 'done' }; }, {});
      await settle(0);
    }
    for (let tick = 0; tick < 10; tick++) { time.advance(100); bot.emit('physicsTick'); await settle(0); }
    const eaten = bot.consume.mock.calls.length;
    finish?.(); await work;
    return eaten;
  }
  it('food 17 with an idle body: eats (default), but not in floor mode', async () => {
    expect(await run({}, { food: 17 })).toBe(1);
    expect(await run({ MINEBOT_FCA_REFLEXES: 'floor' }, { food: 17 })).toBe(0);
  });
  it('food 17 while an API command runs: does not eat, and the command is not cut', async () => {
    expect(await run({}, { food: 17 }, true)).toBe(0);
  });
  it('food 6 while a command runs is critical but does not cut it (as in the production floor); food 3 does', async () => {
    expect(await run({}, { food: 6 }, true)).toBe(0);
    expect(await run({}, { food: 3 }, true)).toBe(1);
    expect(await run({ MINEBOT_FCA_REFLEXES: 'floor' }, { food: 3 }, true)).toBe(1);
  });
  it('food 6 while the pathfinder walks: eats; food 17 while it walks: waits', async () => {
    expect(await run({}, { food: 6, pathfinder: { isMoving: () => true } })).toBe(1);
    expect(await run({}, { food: 17, pathfinder: { isMoving: () => true } })).toBe(0);
  });
  it('an enemy 4 m away and food 10: does not eat (default and floor); the same at critical food too', async () => {
    const zombie = { entities: { 2: { id: 2, name: 'zombie', position: new Vec3(4, 65, 0) } } };
    expect(await run({}, { food: 10, ...zombie })).toBe(0);
    expect(await run({ MINEBOT_FCA_REFLEXES: 'floor' }, { food: 10, ...zombie })).toBe(0);
    expect(await run({}, { food: 4, ...zombie })).toBe(0);
  });
  it('a top-up still obeys the budget (a failing one backs off and latches) while a critical meal is exempt', async () => {
    const time = clock(), { bot } = fixture({ inventory: bread, food: 17, consume: vi.fn(async () => { throw new Error('the server never answered'); }) });
    installFloorReflexes(bot, floorConfig({}), { now: time.now });
    for (let tick = 0; tick < 100; tick++) { time.advance(100); bot.emit('physicsTick'); await settle(0); }
    expect(bot.consume.mock.calls.length).toBeLessThanOrEqual(LATCH_AFTER + 1);
    expect(floorSilenced(bot)).toBe('eat');
    const starving = fixture({ inventory: bread, food: 5, consume: vi.fn(async () => { throw new Error('the server never answered'); }) }).bot;
    installFloorReflexes(starving, floorConfig({}), { now: time.now });
    for (let tick = 0; tick < 100; tick++) { time.advance(100); starving.emit('physicsTick'); await settle(0); }
    expect(starving.consume.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(floorSilenced(starving)).toBeNull();
  });
});