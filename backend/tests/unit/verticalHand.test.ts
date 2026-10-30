import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeHandsSim, type Ground, type HandsSim, type Stack } from '../helpers/handsSim.js';
import { vertical, verticalProblem, PILLAR_MARGIN, VERTICAL_EVIDENCE_EVENT, type VerticalArgs, type VerticalEvidence } from '../../src/services/minebot/utils/primitives/vertical.js';
import { StepStopped, type StepContext, type StepOutcome } from '../../src/services/minebot/utils/primitives/common.js';
import { handProblem } from '../../src/services/minebot/utils/actHandRules.js';
import { stepLabel } from '../../src/services/minebot/utils/actLabel.js';
import { closedWord } from '../../src/services/minebot/utils/actReport.js';
import { ACT_HANDS, HAND_KINDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import { feetCell } from '../../src/services/minebot/utils/localMap.js';
import { readFileSync } from 'node:fs';
import { ThreatExposedError } from '../../src/services/minebot/utils/exposureGuard.js';
import { fileURLToPath } from 'node:url';

// The hand `vertical` (continue contracts, chapter 6; fixtures continue/vertical/*.json): a long way down or up, one level at a time, against the real
// client physics (prismarine-physics) in small worlds (tests/helpers/handsSim): digging is told by the server's packet, a block laid is told by a
// block update, a pushed body is moved by the test. The fixtures' scenes are run on a smaller scale where the real height would only cost time; the
// numbers they name (12 levels then lava, the four counts, the stop codes) are the ones asserted. No server and no API.
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] }); });
afterEach(() => { vi.useRealTimers(); });

const fixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../fixtures/continue/vertical/${name}.json`, import.meta.url)), 'utf8'));

type Layer = (x: number, y: number, z: number) => string | null | undefined;
const R = 60;
/** Rock below `top` (air over it), `null` (not loaded) beyond R of (cx, cz); the layers first. */
const world = (rock: string, top: number, layers: Layer[] = [], cx = 0, cz = 0): Ground => (x, y, z) => {
  for (const layer of layers) { const name = layer(x, y, z); if (name !== undefined) return name; }
  if (Math.abs(x - cx) > R || Math.abs(z - cz) > R) return null;
  return y < top ? rock : 'air';
};
const cell = (name: string | null, x: number, y: number, z: number): Layer => (a, b, c) => (a === x && b === y && c === z ? name : undefined);
const column = (name: string | null, x: number, y0: number, y1: number, z: number): Layer => (a, b, c) => (a === x && c === z && b >= y0 && b <= y1 ? name : undefined);
const at = (x: number, y: number, z: number) => ({ x, y, z });
const PICK: Stack = { name: 'iron_pickaxe', count: 1 };
const DIG = ['stone', 'andesite', 'dirt', 'gravel'];

const ctxOf = (sim: HandsSim, options: { controller?: AbortController; ms?: number; progress?: (detail: string) => void } = {}): StepContext => {
  const feet = feetCell(sim.bot)!;
  return { bot: sim.bot, stop: (options.controller ?? new AbortController()).signal, deadline: Date.now() + (options.ms ?? 600_000), facing: 'north', base: feet,
    ...(options.progress ? { progress: options.progress } : {}) };
};
async function drive<T>(sim: HandsSim, promise: Promise<T>, each?: (elapsedMs: number) => void, maxMs = 300_000): Promise<T> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) { sim.tick(); each?.(elapsed); await vi.advanceTimersByTimeAsync(50); }
  return promise;
}
const hand = (args: Partial<VerticalArgs> & Pick<VerticalArgs, 'dir' | 'shape' | 'toY'>): VerticalArgs => ({ canDig: DIG, liquid: 'stop', ...args });
const evidenceOf = (sim: HandsSim) => { const list: VerticalEvidence[] = []; sim.bot.on(VERTICAL_EVIDENCE_EVENT, (event: VerticalEvidence) => list.push(event)); return list; };
const run = (sim: HandsSim, args: VerticalArgs, options: Parameters<typeof ctxOf>[1] = {}) => vertical(ctxOf(sim, options), args);
const sim0 = (ground: Ground, start: [number, number, number] = [0, 64, 0], items: Stack[] = [PICK]) =>
  makeHandsSim(ground, { start: [start[0] + 0.5, start[1], start[2] + 0.5], items });
const workOf = (outcome: StepOutcome) => outcome.progress!.work!;

describe('run 48: stairs up leave the support under gravel above the body intact', () => {
  it.each(['gravel', 'sand', 'red_sand', 'white_concrete_powder'])('returns %s to the planner before digging the roof', async falling => {
    const ground = world('andesite', 72, [cell('air', 0, 64, 0), cell('air', 0, 65, 0), cell(falling, 0, 67, 0)]);
    const sim = sim0(ground);
    const outcome = await drive(sim, run(sim, hand({ dir: 'up', shape: 'stairs', toward: 'east', toY: 65 })));
    expect(outcome).toMatchObject({ ok: false, code: 'falling_above', progress: { done: 0 } });
    expect(outcome.text).toContain('頭へ落ちる');
    expect(outcome.text).toContain('toward');
    expect(sim.bot.dugBlocks).toEqual([]);
    expect(feetCell(sim.bot)).toEqual(at(0, 64, 0));
  });
});

describe('vertical: the hand\'s fields and the refusals before the body moves', () => {
  it('is a kind of hand and takes the fixtures\' short-hand hands (dependsOn is the act\'s own, not this hand\'s)', () => {
    expect(HAND_KINDS).toContain('vertical');
    const { hands } = fixture('short-hands').expected;
    for (const one of hands.slice(0, 3)) {
      const parsed = ACT_HANDS.parse([one]);
      expect(parsed[0]).toMatchObject(one);
      expect(handProblem(parsed[0] as never)).toBeNull();
    }
    expect(stepLabel({ do: 'vertical', dir: 'down', shape: 'stairs', toward: 'south', toY: 10 } as never)).toBe('vertical down stairs south y=10');
    expect(stepLabel({ do: 'vertical', dir: 'up', shape: 'pillar', toY: 63 } as never)).toBe('vertical up pillar y=63');
  });

  it('refuses a shape that does not fit its direction, a stairs without toward, no canDig and no dir, before it moves', () => {
    const problem = (extra: Record<string, unknown>) => handProblem({ do: 'vertical', toY: 10, liquid: 'stop', canDig: ['stone'], ...extra } as never);
    expect(problem({ dir: 'down', shape: 'stairs' })).toContain('toward');
    expect(problem({ dir: 'up', shape: 'shaft' })).toContain('shaft は down だけ');
    expect(problem({ dir: 'down', shape: 'pillar' })).toContain('pillar は up だけ');
    expect(problem({ dir: 'down', shape: 'shaft', canDig: undefined })).toContain('canDig');
    expect(problem({ shape: 'stairs', toward: 'south' })).toContain('dir');
    expect(problem({ dir: 'down', shape: 'shaft', seconds: 3 })).toContain('seconds');
    expect(problem({ dir: 'down', shape: 'shaft', range: 3 })).toContain('range');
    expect(problem({ dir: 'down', shape: 'shaft', canPlace: ['Cobble'] })).toContain('canPlace');
    expect(problem({ dir: 'down', shape: 'shaft', dependsOnNothing: 1 })).toContain('使えない');
    expect(problem({ dir: 'down', shape: 'shaft' })).toBeNull();
    expect(verticalProblem({ dir: 'up', shape: 'stairs', toward: 'north', toY: 70, canDig: ['stone'], liquid: 'seal' })).toBeNull();
    // And the closed words for its codes.
    for (const code of ['world_limit', 'displaced', 'cannot_dig', 'no_place', 'seal_failed', 'place_unconfirmed', 'lava', 'water', 'no_floor', 'limit_dig', 'limit_place', 'limit_time', 'unloaded']) {
      expect(closedWord(code)).not.toBe('無い');
    }
  });

  it('through the act: a refused vertical is a line "vertical 止まった invalid_input" and nothing is dug', async () => {
    const sim = sim0(world('stone', 64));
    const result = await runAct(sim.bot, ACT_HANDS.parse([{ do: 'vertical', dir: 'up', shape: 'shaft', toY: 70, canDig: ['stone'], liquid: 'stop' }]));
    expect(result.success).toBe(false);
    expect(JSON.parse(result.result).lines[0].line).toContain('shaft は down だけ');
    expect(sim.bot.dugBlocks).toEqual([]);
  });
});

describe('vertical: stairs down (run 45 hold 1, scaled to what the fixture names)', () => {
  it('stops at the lava after 12 levels with the progress of the fixture: done 12, left 11, at (161,21,226); the digs are counted apart', async () => {
    const fx = fixture('r45-hold1-stairs-down');
    expect(fx.input.hand.toY).toBe(10);
    const ground = world('andesite', 90, [column('air', 161, 33, 36, 214), cell('lava', 161, 20, 228)], 161, 214);
    const sim = sim0(ground, [161, 33, 214]);
    const events = evidenceOf(sim);
    const outcome = await drive(sim, run(sim, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 10, maxDig: 80, seconds: 120 }), { ms: 600_000 }));
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('lava');
    expect(outcome.reason).toBe('lava');
    expect(outcome.at).toEqual(fx.expected.line.where);
    expect(outcome.progress).toMatchObject({ unit: 'step', done: 12, left: 11, at: fx.expected.line.progress.at });
    expect(outcome.progress!.msPerUnit).toBeGreaterThan(0);
    expect(workOf(outcome)).toEqual({ dug: 36, placeAttempts: 0, stockUsed: 0, placedConfirmed: 0 });
    expect(sim.bot.dugBlocks.length).toBe(36);
    expect(outcome.text.startsWith('vertical 止まった lava: ')).toBe(true);
    expect(outcome.text.length).toBeLessThanOrEqual(160);
    // The body itself stands where it says and has not turned aside, changed shape or gone down further.
    expect(feetCell(sim.bot)).toEqual(at(161, 21, 226));
    expect(events.filter(event => event.kind === 'block_update')).toEqual([]);
  });

  it('reaches the height asked: ok, no code, done = left 0, the levels still there', async () => {
    const sim = sim0(world('andesite', 64));
    const outcome = await drive(sim, run(sim, hand({ dir: 'down', shape: 'stairs', toward: 'east', toY: 60 })));
    expect(outcome.ok).toBe(true);
    expect(outcome.goal).toBeUndefined();
    expect(outcome.text.startsWith('vertical 着いた ')).toBe(true);
    expect(outcome.progress).toMatchObject({ unit: 'step', done: 4, left: 0, at: at(4, 60, 0) });
    // The first levels are cut in the open air over the rock: 1 + 2 + 3 + 3 cells of stone.
    expect(workOf(outcome).dug).toBe(9);
    expect(sim.bot.dugBlocks.length).toBe(9);
    expect(feetCell(sim.bot)).toEqual(at(4, 60, 0));
  });

  it('is already there when the feet are at or under toY (down) or at or over it (up): nothing is dug or laid', async () => {
    const sim = sim0(world('andesite', 64));
    const down = await run(sim, hand({ dir: 'down', shape: 'stairs', toward: 'east', toY: 64 }));
    expect(down).toMatchObject({ ok: true, goal: 'already' });
    expect(down.progress).toMatchObject({ unit: 'step', done: 0, left: 0 });
    const up = await run(sim, hand({ dir: 'up', shape: 'pillar', toY: 60 }));
    expect(up).toMatchObject({ ok: true, goal: 'already' });
    expect(sim.bot.dugBlocks).toEqual([]);
    expect(sim.bot.placedBlocks).toEqual([]);
  });
});

describe('vertical: shaft down (run 45 hold 5) and the clock', () => {
  it('stops at the time limit with the progress to continue from: done N, left = y - toY, at (183, 63-N, 195)', async () => {
    const fx = fixture('r45-hold5-shaft-down');
    expect(fx.input.hand.shape).toBe('shaft');
    const sim = sim0(world('stone', 63, [], 183, 195), [183, 63, 195], [PICK, { name: 'cobblestone', count: 8 }]);
    const outcome = await drive(sim, run(sim, hand({ dir: 'down', shape: 'shaft', toY: -50, canPlace: ['cobblestone'], maxPlace: 30, liquid: 'seal', range: 1, seconds: 8 })));
    expect(outcome.ok).toBe(false);
    expect(outcome.code).toBe('limit_time');
    const done = outcome.progress!.done;
    expect(done).toBeGreaterThanOrEqual(3);
    expect(outcome.progress).toMatchObject({ unit: 'step', done, left: 63 - done + 50, at: at(183, 63 - done, 195) });
    expect(workOf(outcome)).toMatchObject({ dug: done, placeAttempts: 0 });
    expect(outcome.progress!.msPerUnit).toBeGreaterThan(0);
    // The next hand starts at progress.at and digs nothing above it again.
    expect(sim.bot.dugBlocks.every((entry: string) => Number(entry.split(',')[1]) < 63)).toBe(true);
  });

  it('stops at the end of the world: world_limit under y=-64, with the levels it did take', async () => {
    const sim = sim0(world('stone', -60, [column('air', 0, -61, -58, 0)]), [0, -61, 0]);
    const outcome = await drive(sim, run(sim, hand({ dir: 'down', shape: 'shaft', toY: -70 })));
    expect(outcome).toMatchObject({ ok: false, code: 'world_limit' });
    expect(outcome.progress).toMatchObject({ done: 2, left: 7, at: at(0, -63, 0) });
  });

  it('stops where a cave opens under the next rock: no_floor (a fall of more than one)', async () => {
    const sim = sim0(world('stone', 64, [column('air', 0, 56, 61, 0)]), [0, 64, 0]);
    const outcome = await drive(sim, run(sim, hand({ dir: 'down', shape: 'shaft', toY: 40 })));
    expect(outcome).toMatchObject({ ok: false, code: 'no_floor' });
    expect(outcome.progress).toMatchObject({ done: 1, at: at(0, 63, 0) });
  });
});

describe('vertical: a cave under the next rock is a fall of three at most (run 47: no_floor in 3 of 11)', () => {
  it('a shaft drops through one cell of air onto the rock under it, counts the cell fallen through as a level, and goes on', async () => {
    const sim = sim0(world('stone', 64, [cell('air', 0, 62, 0)]), [0, 64, 0]);
    const outcome = await drive(sim, run(sim, hand({ dir: 'down', shape: 'shaft', toY: 58 })));
    expect(outcome.ok).toBe(true);
    expect(outcome.progress).toMatchObject({ done: 6, left: 0 });
    expect(feetCell(sim.bot)!.y).toBe(58);
  });
  it('a stair steps off a ledge into a cave of two cells and goes on from the rock it lands on', async () => {
    const sim = sim0(world('andesite', 64, [column('air', 0, 60, 61, 2)]));
    const outcome = await drive(sim, run(sim, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 54 })));
    expect(outcome.code).not.toBe('no_floor');
    expect(outcome.ok).toBe(true);
    expect(feetCell(sim.bot)!.y).toBeLessThanOrEqual(54);
  });
  it('lava beside the landing is still a stop, and a cave deeper than three is no_floor', async () => {
    const lavaBeside = sim0(world('stone', 64, [cell('air', 0, 62, 0), cell('lava', 1, 61, 0)]), [0, 64, 0]);
    const stopped = await drive(lavaBeside, run(lavaBeside, hand({ dir: 'down', shape: 'shaft', toY: 58 })));
    expect(stopped.ok).toBe(false);
    expect(['lava', 'no_floor']).toContain(stopped.code);
    const deep = sim0(world('stone', 64, [column('air', 0, 57, 62, 0)]), [0, 64, 0]);
    const refused = await drive(deep, run(deep, hand({ dir: 'down', shape: 'shaft', toY: 50 })));
    expect(refused).toMatchObject({ ok: false, code: 'no_floor' });
  });
});

describe('vertical: a pillar sends no block while the body is falling into its cell (run 48, hold 4)', () => {
  it('every place goes out with the feet still over the top of the cell two ticks on', async () => {
    const sim = sim0(world('stone', 64, []), [0, 64, 0], [PICK, { name: 'cobblestone', count: 16 }]);
    const original = (sim.bot as any).placeBlock.bind(sim.bot);
    const sent: Array<{ over: number; ahead: number }> = [];
    let base = 64;
    (sim.bot as any).placeBlock = async (...rest: unknown[]) => {
      const y = sim.bot.entity.position.y, vy = sim.bot.entity.velocity.y;
      sent.push({ over: y - base, ahead: y + 2 * Math.min(vy, 0) - base });
      return original(...rest);
    };
    sim.bot.on('physicsTick', () => { if (sim.bot.entity.onGround) base = Math.floor(sim.bot.entity.position.y + 1e-3); });
    const outcome = await drive(sim, run(sim, hand({ dir: 'up', shape: 'pillar', toY: 68, canPlace: ['cobblestone'] })));
    expect(outcome.ok).toBe(true);
    expect(sent.length).toBeGreaterThanOrEqual(4);
    for (const one of sent) expect(one.ahead).toBeGreaterThanOrEqual(1.03 - 1e-6);
  });
});

describe('vertical: an ore the planner names in canDig (run 48, hold 1)', () => {
  const ore = (name: string) => world('andesite', 64, [cell(name, 0, 63, 1)]);
  it('stops at copper_ore when canDig lacks it, saying to add it; with copper_ore in canDig the stair digs it and goes on', async () => {
    const refused = sim0(ore('copper_ore'));
    const stopped = await drive(refused, run(refused, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 56 })));
    expect(stopped).toMatchObject({ ok: false, code: 'cannot_dig' });
    expect(stopped.text).toContain('copper_ore(0,63,1) は canDig に無い');
    expect(stopped.text).toContain('canDig に copper_ore を足せば進む');
    const allowed = sim0(ore('copper_ore'));
    const through = await drive(allowed, run(allowed, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 56, canDig: [...DIG, 'copper_ore'] })));
    expect(through.ok).toBe(true);
    expect(allowed.bot.dugBlocks.some((entry: string) => entry.startsWith('copper_ore@0,63,1'))).toBe(true);
  });
  it('a category word never includes an ore (stone stays stone), and a block the body never breaks named in canDig is told as such, with no "add it" hint', async () => {
    const category = sim0(ore('iron_ore'));
    const stopped = await drive(category, run(category, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 56, canDig: ['stone', 'dirt', 'andesite'] })));
    expect(stopped).toMatchObject({ ok: false, code: 'cannot_dig' });
    const spawner = sim0(ore('spawner'));
    const refused = await drive(spawner, run(spawner, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 56, canDig: [...DIG, 'spawner'] })));
    expect(refused).toMatchObject({ ok: false, code: 'cannot_dig' });
    expect(refused.text).toContain('canDig に書かれているが体は壊さない決まりのブロック');
    expect(refused.text).not.toContain('を足せば進む');
  });
});

describe('vertical: pillar up (run 45 hold 7, scaled) and the four numbers', () => {
  it('lays a block under the feet at each level: attempts, stock used, confirmed and valid levels are all the same here, and the pack holds the rest', async () => {
    const sim = sim0(world('stone', 64), [0, 64, 0], [PICK, { name: 'cobblestone', count: 20 }]);
    const sentAt: Array<{ feet: number; cell: number }> = [];
    const send = sim.bot.placeBlock;
    sim.bot.placeBlock = async (reference: any, face: any) => { sentAt.push({ feet: sim.bot.entity.position.y, cell: reference.position.y + face.y }); return send(reference, face); };
    const outcome = await drive(sim, run(sim, hand({ dir: 'up', shape: 'pillar', toY: 70, canPlace: ['cobbled_deepslate', 'cobblestone', 'dirt'], maxPlace: 60, liquid: 'seal_water' })));
    expect(outcome.ok).toBe(true);
    // Every place was sent with the feet over the top of its cell by the margin (the cell's top is cell + 1).
    expect(sentAt.length).toBe(6);
    for (const sent of sentAt) expect(sent.feet).toBeGreaterThanOrEqual(sent.cell + 1 + PILLAR_MARGIN - 1e-9);
    expect(outcome.progress).toMatchObject({ unit: 'step', done: 6, left: 0, at: at(0, 70, 0) });
    expect(workOf(outcome)).toEqual({ dug: 0, placeAttempts: 6, stockUsed: 6, placedConfirmed: 6 });
    expect(sim.count('cobblestone')).toBe(14);
    expect(sim.bot.placedBlocks.length).toBe(6);
    expect(PILLAR_MARGIN).toBe(0.2);
  });

  it('digs the roof it needs (the two cells over the head) with what canDig allows, and counts those digs', async () => {
    const sim = sim0(world('stone', 64, [column('stone', 0, 66, 67, 0)]), [0, 64, 0], [PICK, { name: 'cobblestone', count: 20 }]);
    const outcome = await drive(sim, run(sim, hand({ dir: 'up', shape: 'pillar', toY: 66, canPlace: ['cobblestone'] })));
    expect(outcome.ok).toBe(true);
    expect(workOf(outcome).dug).toBe(sim.bot.dugBlocks.length);
    expect(workOf(outcome).dug).toBeGreaterThanOrEqual(2);
    expect(outcome.progress!.done).toBe(2);
  });

  it('A-6 (3): the hand is a laying hand while it lays a block, and not while it digs the cells over the head', async () => {
    const sim = sim0(world('stone', 64, [column('stone', 0, 66, 67, 0)]), [0, 64, 0], [PICK, { name: 'cobblestone', count: 20 }]);
    const host = sim.bot as { actHandNow?: string };
    const whileDigging: Array<string | undefined> = [], whilePlacing: Array<string | undefined> = [];
    const dig = sim.bot.dig, place = sim.bot.placeBlock;
    sim.bot.dig = async (...args: any[]) => { whileDigging.push(host.actHandNow); return dig(...args); };
    sim.bot.placeBlock = async (...args: any[]) => { whilePlacing.push(host.actHandNow); return place(...args); };
    const outcome = await drive(sim, run(sim, hand({ dir: 'up', shape: 'pillar', toY: 66, canPlace: ['cobblestone'] })));
    expect(outcome.ok).toBe(true);
    expect(whileDigging.length).toBeGreaterThanOrEqual(2);
    expect(new Set(whileDigging)).toEqual(new Set(['vertical']));
    expect(whilePlacing.length).toBeGreaterThanOrEqual(1);
    expect(new Set(whilePlacing)).toEqual(new Set(['vertical-place']));
  });

  it('stops at a roof canDig does not allow (cannot_dig) before it digs the cell beside it', async () => {
    const sim = sim0(world('stone', 64, [column('obsidian', 0, 66, 67, 0)]), [0, 64, 0], [PICK, { name: 'cobblestone', count: 20 }]);
    const outcome = await drive(sim, run(sim, hand({ dir: 'up', shape: 'pillar', toY: 70, canPlace: ['cobblestone'] })));
    expect(outcome).toMatchObject({ ok: false, code: 'cannot_dig', at: at(0, 66, 0) });
    expect(sim.bot.dugBlocks).toEqual([]);
  });

  it('stops at the top of the world: world_limit under y=320', async () => {
    const sim = sim0(world('stone', 316), [0, 316, 0], [PICK, { name: 'cobblestone', count: 20 }]);
    const outcome = await drive(sim, run(sim, hand({ dir: 'up', shape: 'pillar', toY: 330, canPlace: ['cobblestone'] })));
    expect(outcome).toMatchObject({ ok: false, code: 'world_limit' });
    expect(outcome.progress).toMatchObject({ done: 1, left: 13, at: at(0, 317, 0) });
  });

  it('a place the world does not show is attempted, not confirmed and not a level; two in a row stop it with place_unconfirmed', async () => {
    const sim = sim0(world('stone', 64), [0, 64, 0], [PICK, { name: 'cobblestone', count: 20 }]);
    sim.bot.placeBlock = async () => { await new Promise(resolve => setTimeout(resolve, 80)); };   // taken, never shown
    const outcome = await drive(sim, run(sim, hand({ dir: 'up', shape: 'pillar', toY: 70, canPlace: ['cobblestone'] })));
    expect(outcome).toMatchObject({ ok: false, code: 'place_unconfirmed' });
    expect(outcome.progress).toMatchObject({ done: 0 });
    expect(workOf(outcome)).toEqual({ dug: 0, placeAttempts: 2, stockUsed: 0, placedConfirmed: 0 });
  });

  it('keeps the budget apart from the result (counts-and-budget): one place made, the block gone later: valid levels 0, attempts still 1, no refund, limit_place', async () => {
    const fx = fixture('counts-and-budget');
    expect(fx.expected.code).toBe('limit_place');
    const sim = sim0(world('stone', 64), [0, 64, 0], [PICK, { name: 'cobblestone', count: 20 }]);
    const events = evidenceOf(sim);
    const progress = (detail: string) => {
      if (detail !== '1段') return;
      const old = sim.world.getBlock({ x: 0, y: 64, z: 0 } as never);
      sim.world.set(0, 64, 0, 'air');
      sim.bot.emit('blockUpdate', old, sim.world.getBlock({ x: 0, y: 64, z: 0 } as never));
    };
    const outcome = await drive(sim, run(sim, hand({ dir: 'up', shape: 'pillar', toY: 70, canPlace: ['cobblestone'], maxPlace: 1 }), { progress }));
    expect(outcome).toMatchObject({ ok: false, code: 'limit_place' });
    expect(outcome.progress!.done).toBe(fx.expected.stepsValid);
    expect(workOf(outcome)).toEqual({ dug: 0, ...fx.expected.work });
    expect(events.find(event => event.usedFor === 'steps_valid')).toMatchObject({ kind: 'block_update', at: at(0, 64, 0), to: 'air', step: 1 });
  });
});

describe('vertical: what happened to the levels afterwards (stepsValid) and the evidence', () => {
  it('10 levels taken and one gone later: 9 valid, moved 10 is not valid 10; the update that corrected it goes out as evidence', async () => {
    const fx = fixture('boundary2-evidence');
    expect(fx.expected.movedEqualsValid).toBe(false);
    const sim = sim0(world('andesite', 64));
    const events = evidenceOf(sim);
    const progress = (detail: string) => {
      if (detail !== '6段') return;
      // The floor of level 3: (0, 60, 3) with the levels going south from (0,64,0).
      const old = sim.world.getBlock({ x: 0, y: 60, z: 3 } as never);
      sim.world.set(0, 60, 3, 'air');
      sim.bot.emit('blockUpdate', old, sim.world.getBlock({ x: 0, y: 60, z: 3 } as never));
    };
    const outcome = await drive(sim, run(sim, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 54 }), { progress }));
    expect(outcome.ok).toBe(true);
    expect(feetCell(sim.bot)).toEqual(at(0, 54, 10));
    expect(outcome.progress!.done).toBe(9);
    // Amendment A-5: the step that was found gone is named in the structure and in the line; the counts of what was sent and confirmed are not lowered.
    expect(outcome.progress!.corrected).toEqual([{ at: at(0, 60, 3), was: 'andesite', now: 'air', step: 3 }]);
    expect(outcome.text).toContain('が無くなった');
    expect(workOf(outcome).dug).toBe(sim.bot.dugBlocks.length);
    expect(workOf(outcome).placeAttempts).toBe(0);
    expect(events.filter(event => event.usedFor === 'steps_valid')).toEqual([expect.objectContaining({ kind: 'block_update', at: at(0, 60, 3), from: 'andesite', to: 'air', step: 3 })]);
  });

  it('a change nobody told about is found by looking again at the end; a cell that is not loaded any more is not "gone"', async () => {
    const sim = sim0(world('andesite', 64));
    const progress = (detail: string) => {
      if (detail === '2段') sim.world.set(0, 62, 1, 'air');   // level 1's floor, silently
      if (detail === '3段') sim.world.set(0, 61, 2, null);    // level 2's floor: not loaded now
    };
    const outcome = await drive(sim, run(sim, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 61 }), { progress }));
    expect(outcome.ok).toBe(true);
    expect(outcome.progress!.done).toBe(2);
  });

  it('reports the push-back as evidence and stops with displaced where the body is now (knocked back 2)', async () => {
    const sim = sim0(world('andesite', 64));
    const events = evidenceOf(sim);
    const progress = (detail: string) => {
      if (detail !== '3段') return;
      sim.bot.entity.position.set(0.5, 62, 1.5);
      sim.bot.entity.velocity.set(0, 0, 0);
      sim.bot.emit('forcedMove');
    };
    const outcome = await drive(sim, run(sim, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 50 }), { progress }));
    expect(outcome).toMatchObject({ ok: false, code: 'displaced' });
    expect(outcome.at).toEqual(at(0, 62, 1));
    expect(outcome.progress).toMatchObject({ done: 3, at: at(0, 62, 1), left: 12 });
    expect(events.find(event => event.kind === 'forced_move')).toMatchObject({ step: 3 });
  });
});

describe('vertical: stops of the stairs (stop-cases)', () => {
  it('unloaded: the next cell is not loaded', async () => {
    const sim = sim0(world('andesite', 64, [column(null, 0, 40, 70, 3)]));
    const outcome = await drive(sim, run(sim, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 50 })));
    expect(outcome).toMatchObject({ ok: false, code: 'unloaded' });
    expect(outcome.progress!.done).toBeGreaterThanOrEqual(1);
    expect(outcome.at!.z).toBe(3);
  });

  it('cannot_dig: bedrock, and a block canDig does not name; the cells of the level before it are not dug', async () => {
    const bed = sim0(world('andesite', 64, [cell('bedrock', 0, 62, 2)]));
    const first = await drive(bed, run(bed, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 50 })));
    expect(first).toMatchObject({ ok: false, code: 'cannot_dig', at: at(0, 62, 2) });
    expect(first.progress).toMatchObject({ done: 1 });
    expect(workOf(first).dug).toBe(1);
    const other = sim0(world('andesite', 64, [cell('diamond_block', 0, 63, 1)]));
    const second = await drive(other, run(other, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 50 })));
    expect(second).toMatchObject({ ok: false, code: 'cannot_dig', at: at(0, 63, 1) });
    expect(workOf(second).dug).toBe(0);
  });

  it('no_floor: the cell the next level stands on is air', async () => {
    const sim = sim0(world('andesite', 64, [column('air', 0, 55, 62, 2)]));
    const outcome = await drive(sim, run(sim, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 50 })));
    expect(outcome).toMatchObject({ ok: false, code: 'no_floor' });
    expect(outcome.progress).toMatchObject({ done: 1 });
  });

  it('limit_dig: gravel that falls back into a cell is dug again and every dig counts', async () => {
    const stack = (sim: HandsSim) => {
      const original = sim.bot.dig;
      sim.bot.dig = async (block: any) => {
        await original(block);
        const { x, y, z } = block.position;
        let top = y + 1;
        while (sim.world.nameAt(x, top, z) === 'gravel') top++;
        for (let level = y; level < top - 1; level++) sim.world.set(x, level, z, 'gravel');
        if (top > y + 1) { sim.world.set(x, top - 1, z, 'air'); }
      };
    };
    const ground = world('andesite', 64, [cell('andesite', 0, 65, 1), column('gravel', 0, 66, 70, 1)]);
    const limited = sim0(ground);
    stack(limited);
    const stopped = await drive(limited, run(limited, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 63, maxDig: 4 })));
    expect(stopped).toMatchObject({ ok: false, code: 'limit_dig', at: at(0, 65, 1) });
    expect(workOf(stopped).dug).toBe(4);
    expect(limited.bot.dugBlocks.length).toBe(4);
    const free = sim0(ground);
    stack(free);
    const done = await drive(free, run(free, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 63, maxDig: 100 })));
    expect(done.ok).toBe(true);
    expect(workOf(done).dug).toBe(free.bot.dugBlocks.length);
    expect(free.bot.dugBlocks.filter((entry: string) => entry.startsWith('gravel')).length).toBe(5);
  });

  it('no_place: an upward stair with a gap for its step and no canPlace; with canPlace it lays the first step and stops where nothing is beside the next', async () => {
    const gap = world('andesite', 64, [cell('air', 0, 64, -1), column('air', 0, 64, 70, -2)]);
    const none = sim0(gap);
    const first = await drive(none, run(none, hand({ dir: 'up', shape: 'stairs', toward: 'north', toY: 68 })));
    expect(first).toMatchObject({ ok: false, code: 'no_place' });
    expect(first.progress).toMatchObject({ done: 0 });
    const some = sim0(gap, [0, 64, 0], [PICK, { name: 'cobblestone', count: 10 }]);
    const second = await drive(some, run(some, hand({ dir: 'up', shape: 'stairs', toward: 'north', toY: 68, canPlace: ['cobblestone'] })));
    expect(second).toMatchObject({ ok: false, code: 'no_place' });
    expect(second.progress).toMatchObject({ done: 1 });
    expect(workOf(second)).toMatchObject({ placeAttempts: 1, placedConfirmed: 1 });
    const spent = sim0(gap, [0, 64, 0], [PICK, { name: 'cobblestone', count: 10 }]);
    const third = await drive(spent, run(spent, hand({ dir: 'up', shape: 'stairs', toward: 'north', toY: 68, canPlace: ['cobblestone'], maxPlace: 0 })));
    expect(third).toMatchObject({ ok: false, code: 'limit_place' });
  });

  it('a scaffold the world did not show in a block update is attempted and used, but the level it holds is walked, not counted', async () => {
    const sim = sim0(world('andesite', 64, [cell('air', 0, 64, -1), column('air', 0, 64, 70, -2)]), [0, 64, 0], [PICK, { name: 'cobblestone', count: 10 }]);
    const emit = sim.bot.emit.bind(sim.bot);
    const place = sim.bot.placeBlock;
    sim.bot.placeBlock = async (reference: any, face: any) => { sim.bot.emit = (event: string, ...rest: unknown[]) => (event.startsWith('blockUpdate') ? false : emit(event, ...rest)); try { await place(reference, face); } finally { sim.bot.emit = emit; } };
    const outcome = await drive(sim, run(sim, hand({ dir: 'up', shape: 'stairs', toward: 'north', toY: 65, canPlace: ['cobblestone'] })));
    expect(outcome.ok).toBe(true);
    expect(feetCell(sim.bot)).toEqual(at(0, 65, -1));
    expect(outcome.progress).toMatchObject({ done: 0, left: 0 });
    expect(workOf(outcome)).toEqual({ dug: 0, placeAttempts: 1, stockUsed: 1, placedConfirmed: 0 });
  });

  it('climbs a stair up through rock, digging the three cells of each level', async () => {
    const sim = sim0(world('andesite', 70, [column('air', 0, 64, 66, 0)]));
    const outcome = await drive(sim, run(sim, hand({ dir: 'up', shape: 'stairs', toward: 'east', toY: 67 })));
    expect(outcome.ok).toBe(true);
    expect(outcome.progress).toMatchObject({ done: 3, left: 0, at: at(3, 67, 0) });
  });

  it('shows an ore that is in view and does not go for it', async () => {
    const sim = sim0(world('andesite', 64, [cell('iron_ore', 1, 62, 2)]));
    const outcome = await drive(sim, run(sim, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 60 })));
    expect(outcome.ok).toBe(true);
    expect(outcome.progress?.seen).toEqual([{ block: 'iron_ore', at: at(1, 62, 2) }]);
    expect(outcome.text).toContain('iron_ore(1,62,2)');
    expect(sim.bot.dugBlocks.some((entry: string) => entry.startsWith('iron_ore'))).toBe(false);
  });
});

describe('vertical: liquids beside a shaft', () => {
  it('lava beside the cell a shaft would drop into stops it before it digs, or is covered with seal', async () => {
    const lava = sim0(world('stone', 64, [cell('lava', 1, 63, 0)]));
    const stopped = await drive(lava, run(lava, hand({ dir: 'down', shape: 'shaft', toY: 55 })));
    expect(stopped).toMatchObject({ ok: false, code: 'lava', at: at(1, 63, 0), progress: expect.objectContaining({ done: 0 }) });
    expect(lava.bot.dugBlocks).toEqual([]);
    const sealed = sim0(world('stone', 64, [cell('lava', 1, 63, 0)]), [0, 64, 0], [PICK, { name: 'cobblestone', count: 4 }]);
    const done = await drive(sealed, run(sealed, hand({ dir: 'down', shape: 'shaft', toY: 62, liquid: 'seal', canPlace: ['cobblestone'] })));
    expect(done.ok).toBe(true);
    expect(workOf(done)).toMatchObject({ placeAttempts: 1, placedConfirmed: 1 });
    expect(sealed.nameAt(1, 63, 0)).toBe('cobblestone');
  });
});

describe('vertical: liquids (lava-seal-and-stop)', () => {
  // Four levels go first; the liquids lie beside the fifth level's cell (0,59,5): east and west (and south).
  const beside = (name: string, count: number): Layer[] => [cell(name, 1, 59, 5), cell(name, -1, 59, 5), cell(name, 0, 59, 6)].slice(0, count);
  const stairs = (liquid: VerticalArgs['liquid'], extra: Partial<VerticalArgs> = {}) => hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 57, liquid, ...extra });

  it('stop: lava stops it at once (code lava, where the lava cell) with the 4 levels done', async () => {
    const sim = sim0(world('andesite', 64, beside('lava', 2)));
    const outcome = await drive(sim, run(sim, stairs('stop')));
    expect(outcome).toMatchObject({ ok: false, code: 'lava' });
    expect([at(1, 59, 5), at(-1, 59, 5)]).toContainEqual(outcome.at);
    expect(outcome.progress).toMatchObject({ done: 4 });
    expect(sim.bot.placedBlocks).toEqual([]);
  });

  it('stop: water stops it too (code water)', async () => {
    const sim = sim0(world('andesite', 64, beside('water', 1)));
    const outcome = await drive(sim, run(sim, stairs('stop')));
    expect(outcome).toMatchObject({ ok: false, code: 'water', progress: expect.objectContaining({ done: 4 }) });
  });

  it('seal: lava in two cells is covered with the blocks of canPlace in the order written (the cobblestone, then the dirt) and the hand goes on', async () => {
    const sim = sim0(world('andesite', 64, beside('lava', 2)), [0, 64, 0], [PICK, { name: 'cobblestone', count: 1 }, { name: 'dirt', count: 5 }]);
    const outcome = await drive(sim, run(sim, stairs('seal', { canPlace: ['cobblestone', 'dirt'], maxPlace: 5 })));
    expect(outcome.ok).toBe(true);
    expect(sim.bot.placedBlocks.map((entry: string) => entry.split('@')[0])).toEqual(['cobblestone', 'dirt']);
    expect(workOf(outcome)).toMatchObject({ placeAttempts: 2, stockUsed: 2, placedConfirmed: 2 });
    expect(outcome.progress).toMatchObject({ done: 7, left: 0 });
  });

  it('seal: water in three cells and one block: one is covered, then seal_failed (no_block) with the place and the count', async () => {
    const sim = sim0(world('andesite', 64, beside('water', 3)), [0, 64, 0], [PICK, { name: 'cobblestone', count: 1 }]);
    const outcome = await drive(sim, run(sim, stairs('seal', { canPlace: ['cobblestone'] })));
    expect(outcome).toMatchObject({ ok: false, code: 'seal_failed' });
    expect(outcome.text).toContain('no_block');
    expect(outcome.progress).toMatchObject({ done: 4 });
    expect(workOf(outcome)).toMatchObject({ placeAttempts: 1, placedConfirmed: 1 });
    expect([at(1, 59, 5), at(-1, 59, 5), at(0, 59, 6)]).toContainEqual(outcome.at);
  });

  it('seal: the budget is maxPlace (seal_failed, budget); seal_water: water is covered, lava stops', async () => {
    const spent = sim0(world('andesite', 64, beside('water', 2)), [0, 64, 0], [PICK, { name: 'cobblestone', count: 9 }]);
    const budget = await drive(spent, run(spent, stairs('seal', { canPlace: ['cobblestone'], maxPlace: 1 })));
    expect(budget).toMatchObject({ ok: false, code: 'seal_failed' });
    expect(budget.text).toContain('budget');
    expect(workOf(budget).placeAttempts).toBe(1);
    const water = sim0(world('andesite', 64, beside('water', 2)), [0, 64, 0], [PICK, { name: 'cobblestone', count: 9 }]);
    const covered = await drive(water, run(water, stairs('seal_water', { canPlace: ['cobblestone'] })));
    expect(covered.ok).toBe(true);
    const lava = sim0(world('andesite', 64, beside('lava', 1)), [0, 64, 0], [PICK, { name: 'cobblestone', count: 9 }]);
    const stopped = await drive(lava, run(lava, stairs('seal_water', { canPlace: ['cobblestone'] })));
    expect(stopped).toMatchObject({ ok: false, code: 'lava', progress: expect.objectContaining({ done: 4 }) });
    expect(lava.bot.placedBlocks).toEqual([]);
  });

  it('range: a liquid one cell off (an open cell between) is ignored by stop and covered by seal with range 2', async () => {
    const layers: Layer[] = [cell('air', 1, 59, 5), cell('lava', 2, 59, 5)];
    const stop = sim0(world('andesite', 64, layers));
    const ignored = await drive(stop, run(stop, stairs('stop')));
    expect(ignored.code).not.toBe('lava');
    const sealed = sim0(world('andesite', 64, layers), [0, 64, 0], [PICK, { name: 'cobblestone', count: 9 }]);
    const outcome = await drive(sealed, run(sealed, stairs('seal', { canPlace: ['cobblestone'], range: 2 })));
    expect(outcome.ok).toBe(true);
    expect(sealed.bot.placedBlocks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('vertical: a liquid that cannot be reached is shut off from the level instead (range 2)', () => {
  it('lava one cell off in a pocket with nothing to set a block against: the open cell between it and the level is covered, the lava stays', async () => {
    const pocket: Layer[] = [cell('air', 1, 59, 5), cell('lava', 2, 59, 5), cell('air', 3, 59, 5), cell('air', 2, 60, 5), cell('air', 2, 58, 5), cell('air', 2, 59, 4), cell('air', 2, 59, 6)];
    const sim = sim0(world('andesite', 64, pocket), [0, 64, 0], [PICK, { name: 'cobblestone', count: 9 }]);
    const outcome = await drive(sim, run(sim, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 57, liquid: 'seal', canPlace: ['cobblestone'], range: 2 })));
    expect(outcome.ok).toBe(true);
    expect(sim.nameAt(1, 59, 5)).toBe('cobblestone');
    expect(sim.nameAt(2, 59, 5)).toBe('lava');
    expect(workOf(outcome)).toMatchObject({ placeAttempts: 1, placedConfirmed: 1 });
  });
});

describe('vertical: the act\'s line and a cut from outside', () => {
  it('runs through the act: the line is "vertical 着いた …" and a stop is "vertical 止まった <code>" with the cell', async () => {
    const sim = sim0(world('andesite', 64));
    const done = await drive(sim, runAct(sim.bot, ACT_HANDS.parse([{ do: 'vertical', dir: 'down', shape: 'shaft', toY: 62, canDig: ['andesite'], liquid: 'stop' }])));
    expect(done.success).toBe(true);
    expect(JSON.parse(done.result).lines[0].line).toMatch(/^vertical 着いた \(0,62,0\) 段 2・掘 2・置 0（\d+\.\d秒）$/u);
    const lava = sim0(world('andesite', 64, [cell('lava', 0, 61, 0)]));
    const stopped = await drive(lava, runAct(lava.bot, ACT_HANDS.parse([{ do: 'vertical', dir: 'down', shape: 'shaft', toY: 55, canDig: ['andesite'], liquid: 'stop' }, { do: 'wait', seconds: 1 }])));
    expect(stopped.success).toBe(false);
    const json = JSON.parse(stopped.result);
    expect(json.lines[0]).toMatchObject({ status: 'stopped', where: at(0, 61, 0) });
    expect(json.lines[0].line.startsWith('vertical 止まった lava: ')).toBe(true);
    expect(json.lines[1].status).toBe('skipped');
  });

  it('a cut from outside (the act\'s stop) is the act\'s to answer: the error carries the progress made', async () => {
    const sim = sim0(world('andesite', 64));
    const controller = new AbortController();
    const promise = run(sim, hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 40 }), { controller });
    let caught: unknown;
    promise.catch(error => { caught = error; });
    await drive(sim, promise.catch(() => undefined), elapsed => { if (elapsed === 8000) controller.abort('reflex'); });
    expect(caught).toBeInstanceOf(StepStopped);
    const progress = (caught as { verticalProgress?: { done: number } }).verticalProgress;
    expect(progress?.done).toBeGreaterThanOrEqual(1);
  });
});

describe('vertical: the stops of run 46 (15 verticals, none done)', () => {
  const stairsDown = (extra: Partial<VerticalArgs> = {}) => hand({ dir: 'down', shape: 'stairs', toward: 'south', toY: 63, ...extra });
  it('digs a fence (a mineshaft\'s, in the way) without being told, and says so; planks it will not dig unless told, and says what to add', async () => {
    const fence = sim0(world('andesite', 64, [cell('oak_fence', 0, 64, 1)]));
    const done = await drive(fence, run(fence, stairsDown()));
    expect(done.ok).toBe(true);
    expect(fence.bot.dugBlocks).toContain('oak_fence@0,64,1');
    expect(done.text).toContain('邪魔な物を壊した oak_fence×1');
    const planks = sim0(world('andesite', 64, [cell('oak_planks', 0, 64, 1)]));
    const stopped = await drive(planks, run(planks, stairsDown()));
    expect(stopped).toMatchObject({ ok: false, code: 'cannot_dig' });
    expect(stopped.text).toContain('canDig に oak_planks を足せば進む');
    expect(stopped.text.length).toBeLessThanOrEqual(160);
    expect(planks.world.nameAt(0, 64, 1)).toBe('oak_planks');
    const told = sim0(world('andesite', 64, [cell('oak_planks', 0, 64, 1)]));
    expect((await drive(told, run(told, stairsDown({ canDig: [...DIG, 'oak_planks'] })))).ok).toBe(true);
  });
  it('a dig the exposure guard refused is threat_exposed with who and which cell, not a cannot_dig', async () => {
    const sim = sim0(world('andesite', 64));
    const dig = sim.bot.dig;
    sim.bot.dig = async (block: any, ...rest: any[]) => {
      if (block.position.y === 63) throw new ThreatExposedError(block, { name: 'zombie', distance: 9 });
      return dig.call(sim.bot, block, ...rest);
    };
    const outcome = await drive(sim, run(sim, stairsDown()));
    expect(outcome).toMatchObject({ ok: false, code: 'threat_exposed' });
    expect(outcome.text).toMatch(/^vertical 止まった threat_exposed: andesite\(0,63,1\) を開けると zombie（約9m）から身体が見える/u);
    expect(outcome.text).toContain('敵が離れるのを待つか、toward を変える');
    expect(outcome.text.length).toBeLessThanOrEqual(160);
  });
  it('lays a footing from cobblestone, cobbled deepslate or dirt held when canPlace is left out of a stair, and not when it says none', async () => {
    const gap = world('andesite', 64, [cell('air', 0, 64, -1), column('air', 0, 64, 70, -2)]);
    const some = sim0(gap, [0, 64, 0], [PICK, { name: 'cobblestone', count: 10 }]);
    const laid = await drive(some, run(some, hand({ dir: 'up', shape: 'stairs', toward: 'north', toY: 68 })));
    expect(workOf(laid)).toMatchObject({ placeAttempts: 1, placedConfirmed: 1 });
    expect(laid.progress).toMatchObject({ done: 1 });
    const refused = sim0(gap, [0, 64, 0], [PICK, { name: 'cobblestone', count: 10 }]);
    const none = await drive(refused, run(refused, hand({ dir: 'up', shape: 'stairs', toward: 'north', toY: 68, canPlace: ['none'] })));
    expect(none).toMatchObject({ ok: false, code: 'no_place' });
    expect(workOf(none).placeAttempts).toBe(0);
    // a pillar has no default: nothing named, nothing laid
    const pillar = sim0(world('andesite', 64), [0, 64, 0], [PICK, { name: 'cobblestone', count: 10 }]);
    const stopped = await drive(pillar, run(pillar, hand({ dir: 'up', shape: 'pillar', toY: 66 })));
    expect(stopped).toMatchObject({ ok: false, code: 'no_place' });
  });
});
