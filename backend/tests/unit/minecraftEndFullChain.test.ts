import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as plan from '../../src/services/minebot/utils/endFullChainPlan.js';
import { cageGuardCells, cageGuardWork, cageRecoveryFootings, cageRoots, cageWall, cageWaterLandings, cageWaterSource, cageWaterExit, cageDryFooting, cagePoolExits, cageShadowFootings, crystalShelterCells, crystalShelterWork, islandFootings } from '../../src/services/minebot/utils/endFightGeometry.js';
import { ACT_HANDS } from '../../src/services/minebot/instantSkills/act.js';
import { handProblem } from '../../src/services/minebot/utils/actHandRules.js';
import { go, goProblem } from '../../src/services/minebot/utils/primitives/go.js';
import { use } from '../../src/services/minebot/utils/primitives/use.js';
import { dig } from '../../src/services/minebot/utils/primitives/dig.js';
import { feetCentre } from '../../src/services/minebot/utils/dragonWalk.js';
import { vertical } from '../../src/services/minebot/utils/primitives/vertical.js';
import { place } from '../../src/services/minebot/utils/primitives/place.js';
import { makeSim } from '../helpers/physicsBody.js';
import { makeHandsSim } from '../helpers/handsSim.js';

const source = fs.readFileSync(new URL('../../scripts/minecraft-end-fight-probe.ts', import.meta.url), 'utf8');
const section = source.split('// ===== end_full_chain:')[1].split('// ===== end end_full_chain =====')[0];
const result = ts.transpileModule('// ' + section, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
const p = (x: number, y = 70, z = 30) => ({ x, y, z });
const crystal = (id = 21, caged: boolean | null = false, distance = 30) => ({ id, caged, distance, position: p(40, 90) });
const opening = (id = 21) => ({ id, caged: false, positions: [p(10.5), p(12.5)], afterCageRemoved: [p(14.5)], blockedBy: { ...p(38, 90), name: 'iron_bars' } });
function view(): any {
  return { position: p(5.5), health: 20, food: 20, inventory: [{ name: 'arrow', count: 64 }],
    perch: p(2.5, 74), dragonBreath: [], dragonFireballs: 0,
    dragon: { id: 77, phase: 0, health: 200, position: p(200, 100), yaw: Math.PI / 2, distance: 100, approach: { wait: [p(14.5)], basin: [p(4.5)] } },
    crystals: { remaining: 1, gone: 0, list: [crystal()], unseen: [], openings: [opening()], shootSets: [] } };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function accepted(hand: any) {
  expect(ACT_HANDS.safeParse([hand]).success).toBe(true);
  expect(handProblem(hand)).toBeNull();
  if (hand.do === 'go') expect(goProblem(hand)).toBeNull();
}

describe('end_full_chain stand-in HEAD choices', () => {
  it('uses shared shootSets by observed walk length, filtering cages, unknown ids and blast/arrow reach', () => {
    const v = view(); v.crystals.list.push(crystal(22), crystal(23, true));
    v.crystals.shootSets = [
      { at: p(6.5), crystals: [21, 22], walkMeters: 20 },
      { at: p(7.5), crystals: [21, 22, 23, 999], walkMeters: 9 },
      { at: p(40, 90), crystals: [21, 22], walkMeters: 1 },
    ];
    const before = structuredClone(v);
    expect(plan.chainShootSet(v)).toMatchObject({ at: p(7.5), crystals: [21, 22], walkMeters: 9 });
    expect(plan.chainShootSet(v, 23)).toBeNull(); expect(plan.chainShootSet(null)).toBeNull(); expect(v).toEqual(before);
    expect(plan.chainShot(v, v.crystals.list[0])).toEqual(p(7.5));
  });
  it.each([0, 10, NaN, 20])('retries only a reflex cut, at most twice, and above ten health: %s', health => {
    expect(plan.chainWalkRetry({ lines: ['反射: melee'] }, 0, health)).toBe(health > 10);
    expect(plan.chainWalkRetry({ lines: [], parsed: { outcome: { cutBy: 'interrupted_by_reflex' } } }, 1, health)).toBe(health > 10);
    expect(plan.chainWalkRetry({ lines: ['反射: melee'] }, 2, health)).toBe(false);
    expect(plan.chainWalkRetry({ lines: ['search_timeout'] }, 0, health)).toBe(false);
  });
  it.each([
    [3, true, true, 'water_drop'], [23, true, true, 'water_drop'], [2, true, true, 'shaft_down'],
    [30, false, true, 'shaft_down'], [30, true, false, 'shaft_down'], [NaN, true, true, 'shaft_down'],
  ])('selects a prepared water descent only for height %s, bucket %s, landing %s', (height, bucket, known, mode) => {
    expect(plan.chainDescent('water_drop', height as number, bucket as boolean, known as boolean).mode).toBe(mode);
    expect(plan.chainDescent('shaft_down', height as number, bucket as boolean, known as boolean).mode).toBe('shaft_down');
  });
  it('estimates velocity and pauses for a closing charge, allowing receding, slow and passing flight', () => {
    const sample = (x: number, z = 0, at = 1000) => ({ at, id: 77, position: p(x, 90, z) });
    const feet = p(0, 90, 0), before = sample(40);
    expect(plan.chainDragonRush(before, sample(30, 0, 1500), feet)).toMatchObject({ ok: false, reason: 'dragon_rush', speed: 20, closing: 20, miss: 0 });
    expect(plan.chainDragonRush(before, sample(50, 0, 1500), feet).ok).toBe(true);
    expect(plan.chainDragonRush(before, sample(39, 0, 1500), feet).ok).toBe(true);
    expect(plan.chainDragonRush(sample(40, 30), sample(30, 30, 1500), feet).ok).toBe(true);
    expect(plan.chainDragonRush(sample(140), sample(130, 0, 1500), feet).ok).toBe(true);
    for (const previous of [null, sample(40, 0, 1450), sample(40, 0, -1000), { ...before, id: 76 }])
      expect(plan.chainDragonRush(previous, sample(30, 0, 1500), feet).reason).toBe('motion_unknown');
    expect(plan.chainDragonSample(null, 1000)).toBeNull();
    const v = view(); v.dragon.position.x = NaN; expect(plan.chainDragonSample(v, 1000)).toBeNull();
  });
  it('parses the entire probe, including code outside the extracted scene', () => {
    const checked = ts.transpileModule(source, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } });
    expect(checked.diagnostics).toEqual([]);
  });
  it('orders only observed crystals, stably, without altering the observation', () => {
    const v = view(); v.crystals.list = [crystal(25, true, 42), crystal(23, false, 18), crystal(22, false, 18)];
    const before = structuredClone(v);
    expect(plan.chainCrystal(v)?.id).toBe(22); expect(plan.chainCrystal(v, 'far')?.id).toBe(25);
    expect(v).toEqual(before); expect(plan.chainCrystal(null)).toBeNull();
  });
  it('takes the first matching shootSet, then a real opening, and hypothetical openings only after cage work', () => {
    const v = view(), c = v.crystals.list[0];
    v.crystals.shootSets = [{ at: p(3.5), crystals: [99] }, { at: p(6.5), crystals: [21] }, { at: p(8.5), crystals: [21] }];
    expect(plan.chainShot(v, c)).toEqual(p(6.5));
    v.crystals.shootSets = []; expect(plan.chainShot(v, c)).toEqual(p(10.5));
    c.caged = true; expect(plan.chainShot(v, c)).toBeNull();
    expect(plan.chainShot(v, c, true)).toEqual(p(14.5));
    expect(plan.chainShot(v, c, true, [p(14.5)])).toEqual(p(10.5));
    c.caged = null; expect(plan.chainShot(v, c)).toBeNull();
  });
  it('rejects a candidate inside blast reach and never invents wait or basin positions from yaw/perch', () => {
    const v = view(); v.crystals.openings[0].positions = [p(40, 90)];
    expect(plan.chainShot(v, v.crystals.list[0])).toBeNull();
    expect(plan.chainWait(v)).toEqual(v.dragon.approach.wait[0]);
    expect(plan.chainBasin(v)).toBeNull(); v.dragon.phase = 6;
    expect(plan.chainBasin(v)).toEqual(v.dragon.approach.basin[0]);
    delete v.dragon.approach; expect(plan.chainWait(v)).toBeNull(); expect(plan.chainBasin(v)).toBeNull();
  });
  it('latches a phase-6 pause through 7/5 and missing phase, resuming only on a known flying phase', () => {
    const v = view(); expect(plan.chainPause(v, false)).toBe(false);
    v.dragon.phase = 6; expect(plan.chainPause(v, false)).toBe(true);
    for (const phase of [5, 7, null]) { v.dragon.phase = phase; expect(plan.chainPause(v, true)).toBe(true); }
    v.dragon.phase = 4; expect(plan.chainPause(v, true)).toBe(false);
  });
  it('requires confirmed zero remaining and no unknown/loaded crystal before changing to dragon', () => {
    const v = view(); v.crystals.list = []; expect(plan.chainClear(v)).toBe(false);
    v.crystals.remaining = 0; v.crystals.unseen = [{ x: 13, z: 17 }]; expect(plan.chainClear(v)).toBe(false);
    v.crystals.unseen = []; expect(plan.chainClear(v)).toBe(true); expect(plan.chainClear(null)).toBe(false);
  });
  it('moves only on distant holding-pattern flight facing away, with no flying ball or cloud corridor', () => {
    const v = view(), from = p(5), to = p(40);
    expect(plan.chainTravel(v, from, to)).toMatchObject({ ok: true, reason: 'flight_away' });
    v.dragon.distance = 30; expect(plan.chainTravel(v, from, to).reason).toBe('dragon_near');
    v.dragon.distance = 100; v.dragon.yaw = -Math.PI / 2;
    expect(plan.chainTravel(v, from, to).reason).toBe('dragon_facing');
    v.dragon.yaw = Math.PI / 2; v.dragonFireballs = 1;
    expect(plan.chainTravel(v, from, to).reason).toBe('fireball');
    v.dragonFireballs = 0; v.dragonBreath = [{ ...p(22), radius: 7, dangerRadius: 7 }];
    expect(plan.chainTravel(v, from, to).reason).toBe('breath');
    v.dragonBreath[0].y = 90; expect(plan.chainTravel(v, from, to).ok).toBe(true);
    v.dragonBreath = []; v.dragon.phase = 1; expect(plan.chainTravel(v, from, to).ok).toBe(false);
    v.dragon.phase = null; expect(plan.chainTravel(v, from, to).ok).toBe(false);
    delete v.dragon; expect(plan.chainTravel(v, from, to).reason).toBe('dragon_unknown');
  });
  it('also checks facing and distance at the destination and rejects missing hazard data', () => {
    const v = view();
    expect(plan.chainTravel(v, p(5), p(230)).reason).toBe('dragon_near');
    expect(plan.chainTravel(v, p(5), p(280)).reason).toBe('dragon_facing');
    delete v.dragonBreath; expect(plan.chainTravel(v, p(5), p(40)).ok).toBe(false);
  });
  it('preselects previous safe ground or observed wait and rejects clouded/portal fallback ground', () => {
    const v = view();
    expect(plan.chainRetreat(v, [p(5), p(32), p(55)])).toEqual(p(32));
    expect(plan.chainRetreat(v, [p(5), p(14.5)])).toEqual(p(14.5));
    v.dragonBreath = [{ ...p(32), radius: 7, dangerRadius: 7 }];
    expect(plan.chainRetreat(v, [p(32), p(55)])).toEqual(p(55));
    expect(plan.chainOnShaft(p(36.9), p(36))).toBe(true);
    expect(plan.chainOnShaft(p(35.9), p(36))).toBe(false);
  });
  it('accepts every generated go/shoot/vertical/dig/place argument through the real act schema and range checks', () => {
    const h = plan.chainHands, guard = cageGuardCells(p(36.5, 90), [p(38, 90)]);
    for (const hand of [h.crossing(p(90)), h.go(p(10)), h.go(p(10), 12, 0), h.up(90), h.down(70), h.dig([p(38, 90)]),
      h.place(guard.ring), h.place(guard.close), h.shoot(21), h.attack(), h.water(p(37, 69)), h.scoop(p(37, 69)), h.down(70, p(37, 69)),
      h.shield(), h.place(crystalShelterCells(p(36.5, 70))), { do: 'eat' }]) accepted(hand);
    expect(goProblem(h.go(p(10), 4))).toMatch(/5〜120/u);
    for (const seconds of [5, 120]) accepted(h.go(p(10), seconds));
  });
});

async function runSelection(wanted: string[], ok = true, writeFails = false) {
  const report: any = { scenes: {}, errors: [] }, calls: string[] = [], writes: string[] = [];
  const scenes = Object.fromEntries(['enter', 'parts', 'end_full_chain', 'dragon_kill_basin_walk', 'cage_descent_compare',
    'cage_descent_compare_water_fast', 'cage_descent_compare_water_guard', 'cage_descent_compare_shaft_fast', 'cage_descent_compare_shaft_guard'].map(name => [name, async () => { calls.push(name); return { ok }; }]));
  const killEntries = new Function(`${source.match(/^const killEntries =.*$/m)![0]} return killEntries;`)();
  const javascript = (s: string) => ts.transpileModule(s, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  const include = new Function('wanted', javascript(`${source.match(/^const include =.*$/m)![0]} return include;`))(wanted);
  const restoreDragon = vi.fn();
  const deps: Record<string, any> = { wanted, report, scenes, killEntries, include, g: 70, disconnected: null,
    restoreDragon, stopTimers: vi.fn(), releaseReflex: vi.fn(), log: vi.fn(),
    process: { env: {}, exit: vi.fn() }, path: { join: (...s: string[]) => s.join('/') }, worldDirectory: '/isolated',
    fs: { writeFileSync: (name: string) => { if (writeFails) throw new Error('disk full'); writes.push(name); } },
    body: { dispose: vi.fn() }, actor: { quit: vi.fn() }, operator: { quit: vi.fn() }, console: { log: vi.fn() }, setTimeout: vi.fn() };
  await new Function(...Object.keys(deps), javascript(`return (async () => { ${source.split('// ===== run =====')[1]} })();`))(...Object.values(deps));
  return { report, calls, writes, restoreDragon, exitCode: deps.setTimeout.mock.calls[0][0] && (() => {
    deps.setTimeout.mock.calls[0][0](); return deps.process.exit.mock.calls[0][0];
  })() };
}

describe('standalone scene dispatch and durable report', () => {
  it.each(['cage_descent_compare', 'cage_descent_compare_water_guard', 'cage_descent_compare_shaft_fast', 'cage_descent_compare_shaft_guard'])('runs only the exact comparison entry %s after enter', async name => {
    const r = await runSelection(['enter', name]);
    expect(r.calls).toEqual(['enter', name]); expect(r.exitCode).toBe(0);
    expect(r.writes).toEqual(['/isolated/report.json']); expect(r.restoreDragon).not.toHaveBeenCalled();
    expect((await runSelection(['enter', name, 'parts'])).calls).toEqual([]);
  });
  it.each([['end_full_chain'], ['enter', 'end_full_chain']])('runs %j alone, saves report.json and never restores or respawns the dragon', async (...names) => {
    const r = await runSelection(names as string[]);
    expect(r.calls).toEqual(names); expect(r.writes).toEqual(['/isolated/report.json']);
    expect(r.exitCode).toBe(0); expect(r.restoreDragon).not.toHaveBeenCalled();
  });
  it('rejects mixed scenes before enter or any command-producing scene is run', async () => {
    const r = await runSelection(['enter', 'end_full_chain', 'parts']);
    expect(r.calls).toEqual([]); expect(r.exitCode).toBe(1); expect(r.report.errors).toHaveLength(1);
  });
  it('does not start the chain in the default all-scenes selection, and fails the process for an unsuccessful chain or report write', async () => {
    expect((await runSelection([])).calls).not.toContain('end_full_chain');
    expect((await runSelection(['end_full_chain'], false)).exitCode).toBe(1);
    const failed = await runSelection(['end_full_chain'], true, true);
    expect(failed.exitCode).toBe(1); expect(failed.report.errors[0]).toMatch(/report write failed/u);
  });
});

function rig(options: { caged?: boolean; empty?: boolean; missingProof?: boolean; miss?: boolean; misses?: number; arrows?: number; blocks?: number;
  policy?: plan.CagePolicy; scene?: string; bucket?: boolean } = {}) {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const actor: any = new EventEmitter(); actor.health = 20; actor.game = { dimension: 'the_end' }; actor.floorReflexes = {};
  actor.entity = { id: 10, position: new Vec3(120.5, 70, 30.5), onGround: true }; actor._client = new EventEmitter();
  const v = view(); if (options.caged) v.crystals.list[0].caged = true;
  if (options.empty) { v.crystals.list = []; v.crystals.remaining = 0; v.dragon.phase = 3; }
  let arrows = options.arrows ?? 64, minHealth = 20, missed = 0;
  let fullBucket = options.bucket === true, emptyBucket = false;
  const water = new Set<string>(), key = (at: any) => `${at.x},${at.y},${at.z}`;
  const blocks = new Set<string>();
  actor.blockAt = (at: any) => ({ name: blocks.has(key(at)) ? 'cobblestone' : water.has(key(at)) ? 'water' : at.y < 70 ? 'end_stone' : 'air' });
  const calls: any[] = [], commands: string[] = [], totals: Record<string, number> = {};
  actor.reflexLedger = { counts: () => ({ ...totals }) };
  const read = () => ({ ...v, position: { ...actor.entity.position }, health: actor.health,
    inventory: [{ name: 'arrow', count: arrows }, { name: 'cobblestone', count: options.blocks ?? 64 },
      ...(fullBucket ? [{ name: 'water_bucket', count: 1 }] : []), ...(emptyBucket ? [{ name: 'bucket', count: 1 }] : [])] });
  let handler: ((h: any, signal?: AbortSignal) => Promise<any>) | undefined;
  const act = async (hands: any[], _seconds: number, _extra: any, signal?: AbortSignal) => {
    hands.forEach(accepted); calls.push({ hands, signal, at: Date.now() });
    if (handler) { const r = await handler(hands[0], signal); if (r) return r; }
    let line = 'ok';
    for (const h of hands) {
      if (h.do === 'go') {
        actor.entity.position = new Vec3(h.to.x + 0.5, h.to.y, h.to.z + 0.5);
        if (h.to.x === 14 && v.crystals.remaining === 0) v.dragon.phase = 6;
      }
      if (h.do === 'use' && h.item === 'water_bucket') { water.add(key(h.at[0])); fullBucket = false; emptyBucket = true; }
      if (h.do === 'use' && h.item === 'bucket') { water.delete(key(h.at[0])); fullBucket = true; emptyBucket = false; }
      if (h.do === 'vertical') actor.entity.position.y = h.toY;
      if (h.do === 'place') h.at.forEach((p: any) => blocks.add(key(p)));
      if (h.do === 'dig') h.at.forEach((p: any) => blocks.delete(key(p)));
      if (h.do === 'shoot') {
        arrows--;
        if (missed++ < (options.misses ?? (options.miss ? 1 : 0))) { line = '外れた（クリスタルは残っている）'; }
        else { v.crystals.list = v.crystals.list.filter((c: any) => c.id !== h.target); v.crystals.remaining = v.crystals.list.length;
          v.dragon.phase = 3; if (v.crystals.remaining === 0) setTimeout(() => { v.dragon.phase = 6; }, 600);
          line = 'クリスタルを壊した（爆発した）'; }
      }
      if (h.do === 'attack') { v.dragon.health = 0; v.dragon.phase = 9; actor.emit('entityDead', { id: 77 }); }
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    return { ok: true, lines: [line], parsed: { ok: true }, ms: 10 };
  };
  const deps: Record<string, any> = { ...plan, Vec3, actor, wanted: ['enter', options.scene ?? 'end_full_chain'], report: { scenes: { enter: {} } },
    scenes: {}, chainArrivalAt: Date.now(), chainArrivalMinHealth: 20, chainArrivalCounts: null, chainArrivalTimeline: [], disconnected: null, body: { observe: () => ({ state: { world: read() } }) },
    trackMinHealth: () => ({ stop: () => minHealth }), feetCentre, act,
    islandFootings: vi.fn((_bot, to) => [to.x === 120.5 ? p(91.5) : p(60.5)]),
    cageRoots: vi.fn(() => [p(36, 70, 30)]), cageWall: vi.fn(() => [p(38, 90, 30)]), cageGuardCells,
    cageGuardWork: vi.fn((_bot, cells) => cells),
    cageWaterLandings: vi.fn(() => [p(37, 69, 30)]), cageWaterSource: vi.fn((_bot, at) => water.has(key(at))),
    cageWaterExit: vi.fn((_bot, _root, at) => water.has(key(at)) ? [] : null),
    cageDryFooting: vi.fn(() => actor.entity.onGround === true), cageShadowFootings: vi.fn(() => []),
    crystalShelterWork: vi.fn(() => crystalShelterCells(actor.entity.position).filter(p => actor.blockAt(p).name === 'air')),
    safetyLeaseCapabilities: vi.fn(() => actor.floorReflexes?.busy ? ['floor-dragon'] : []),
    activeActionCapabilities: vi.fn(() => []),
    cagePoolExits: vi.fn(() => [p(38, 70, 30)]),
    cageRecoveryFootings: vi.fn(() => actor.entity.onGround ? [{ at: { ...actor.entity.position },
      ground: { ...actor.entity.position, y: 70 }, kind: actor.entity.position.y <= 70 ? 'ground' : 'shaft' }] : []),
    ask: async (s: string) => { commands.push(s); }, gear: vi.fn(), wearIron: vi.fn(), protect: vi.fn(), releaseReflex: vi.fn(), ACTOR: 'MinebotTrial',
    evidence: vi.fn(async () => ({ boss: { verified: true, witness: { entityId: options.missingProof ? 76 : 77 } } })),
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) };
  const factory = new Function(...Object.keys(deps), `let actorDeaths = 0; ${result.outputText}\nreturn { run: (policy, cageOnly) => runEndChain(policy, cageOnly), entry: scenes.end_full_chain, scenes, die: () => { actorDeaths++; } };`);
  const api = factory(...Object.values(deps)) as { run: (policy?: plan.CagePolicy, cageOnly?: boolean) => Promise<Record<string, any>>; entry: () => Promise<Record<string, any>>; scenes: Record<string, () => Promise<any>>; die: () => void };
  const run = () => api.run(options.policy ?? { descent: 'shaft_down', guard: true, ascentGuard: true });
  return { ...api, run, actor, v, calls, commands, deps, totals, read, water, setHandler: (h: typeof handler) => { handler = h; },
    hurt: (hp: number) => { minHealth = Math.min(minHealth, hp); actor.health = hp; actor.emit('health'); } };
}
async function settle<T>(promise: Promise<T>, maxMs = 30_000): Promise<T> {
  let done = false; promise.finally(() => { done = true; });
  for (let i = 0; i < maxMs && !done; i += 100) await vi.advanceTimersByTimeAsync(100);
  expect(done).toBe(true); return promise;
}

describe('end_full_chain actual probe scene with mocked I/O', () => {
  it.each([1, 2])('reissues the EXACT island destination after %s reflex cuts', async cuts => {
    const r = rig(); let n = 0;
    r.setHandler(async h => {
      if (h.do === 'go' && h.seconds === 90 && n++ < cuts) {
        r.deps.islandFootings.mockReturnValue([p(99.5)]);
        return { ok: false, lines: ['反射: melee'], ms: 1 };
      }
    });
    const out = await settle(r.run());
    expect(out, out.endReason).toMatchObject({ ok: true });
    expect(out.hands.filter((h: any) => h.name === 'walkWest').map((h: any) => h.hand.to)).toEqual(Array(cuts + 1).fill(p(60, 70, 30)));
    expect(out.walkRetries).toHaveLength(cuts);
  });
  it.each(['limit', 'health', 'other'])('stops island reissue for %s', async reason => {
    const r = rig();
    r.setHandler(async h => {
      if (h.do === 'go' && h.seconds === 90) {
        if (reason === 'health') r.hurt(10);
        return { ok: false, lines: [reason === 'other' ? 'no_path' : '反射: melee'], ms: 1 };
      }
    });
    const out = await settle(r.run());
    expect(out.endReason).toBe(reason === 'health' ? 'island_walk_low_health' : 'island_walk_failed');
    expect(out.hands.filter((h: any) => h.name === 'walkWest')).toHaveLength(reason === 'limit' ? 3 : 1);
  });
  it('checks low health again after the retry backoff, immediately before resending', async () => {
    const r = rig();
    r.setHandler(async h => {
      if (h.do === 'go' && h.seconds === 90) {
        setTimeout(() => r.hurt(9), 200); return { ok: false, lines: ['反射: melee'], ms: 1 };
      }
    });
    const out = await settle(r.run()); expect(out.endReason).toBe('island_walk_low_health');
    expect(out.hands.filter((h: any) => h.name === 'walkWest')).toHaveLength(1);
  });
  it('at twenty WALL seconds selects an observed pillar shadow with shield equipped, despite no ideal flight window', async () => {
    const r = rig(); r.v.dragon.distance = 20;
    r.deps.cageShadowFootings.mockReturnValue([p(52.5)]);
    r.setHandler(async h => { if (h.do === 'go' && h.to.x === 52) r.v.dragon.distance = 100; });
    const run = r.run(); await vi.advanceTimersByTimeAsync(19_900);
    expect(r.calls.some(c => c.hands[0].to?.x === 52)).toBe(false);
    const out = await settle(run, 5000);
    expect(out, out.endReason).toMatchObject({ ok: true });
    expect(out.waitEscalations[0]).toMatchObject({ choice: 'pillar_shadow', ok: true });
    expect(out.waitEscalations[0].waitedMs).toBeGreaterThanOrEqual(20_000);
    expect(out.waitEscalations[0].waitedMs).toBeLessThan(20_300);
    const shadow = out.hands.findIndex((h: any) => h.name === 'crystal_shadow');
    expect(out.hands[shadow - 1].hand).toEqual(plan.chainHands.shield());
    expect(r.deps.cageShadowFootings).toHaveBeenCalledWith(r.actor, r.v.dragon.position, r.v.crystals.list[0]?.position ?? crystal().position, 64);
  });
  it('does not fail for an unavailable retreat: at twenty seconds encloses all four sides and roof, then opens its own blocks to resume', async () => {
    const r = rig(); r.v.dragon.distance = 20; r.v.dragon.approach.wait = []; r.v.perch = p(60.5, 70, 30.5);
    r.setHandler(async h => { if (h.do === 'place') r.v.dragon.distance = 100; });
    const out = await settle(r.run(), 25_000);
    expect(out, out.endReason).toMatchObject({ ok: true });
    expect(out.retreatPlans[0].candidates).toEqual([]);
    expect(out.waitEscalations[0]).toMatchObject({ choice: 'enclosure', complete: true });
    const built = out.hands.find((h: any) => h.name === 'crystal_shelter');
    expect(built.hand.at).toContainEqual(p(60, 72, 30));
    for (const [x, z] of [[61, 30], [59, 30], [60, 31], [60, 29]]) {
      expect(built.hand.at).toContainEqual(p(x, 70, z)); expect(built.hand.at).toContainEqual(p(x, 71, z));
    }
    const opened = out.hands.find((h: any) => h.name === 'shelter_open');
    expect(opened.hand.at.every((p: any) => p.y >= 70)).toBe(true);
    expect(out.hands.findIndex((h: any) => h.name === 'shelter_open')).toBeLessThan(out.hands.findIndex((h: any) => h.name === 'shoot_crystal'));
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['unknown', 'stock'])('reports why enclosure cannot complete: %s', async reason => {
    const r = rig({ blocks: reason === 'stock' ? 1 : 64 }); r.v.dragon.distance = 20;
    if (reason === 'unknown') r.deps.crystalShelterWork.mockReturnValue(null);
    const out = await settle(r.run(), 25_000);
    expect(out.endReason).toBe(reason === 'unknown' ? 'crystal_shelter_unbuildable' : 'crystal_shelter_stock');
    expect(out.waitEscalations[0]).toMatchObject({ waitedMs: 20_000, choice: 'enclosure', ok: false });
  });
  it('tries an enclosure at the actual supported feet if the observed shadow walk is refused', async () => {
    const r = rig(); r.v.dragon.distance = 20; r.deps.cageShadowFootings.mockReturnValue([p(52.5)]);
    r.setHandler(async h => {
      if (h.do === 'go' && h.to.x === 52) return { ok: false, lines: ['no_path'], ms: 1 };
      if (h.do === 'place') r.v.dragon.distance = 100;
    });
    const out = await settle(r.run(), 25_000); expect(out, out.endReason).toMatchObject({ ok: true });
    expect(out.waitEscalations[0]).toMatchObject({ choice: 'enclosure', fallback: 'shadow_walk_stopped', shadowAttempt: { ok: false }, complete: true });
  });
  it('centres within the current supported cell before enclosure if a reflex left the feet near its edge', async () => {
    const r = rig(); r.v.dragon.distance = 20;
    const run = r.run(); await vi.advanceTimersByTimeAsync(19_000);
    r.actor.entity.position.x += 0.35;
    r.setHandler(async h => { if (h.do === 'place') r.v.dragon.distance = 100; });
    const out = await settle(run, 6000); expect(out, out.endReason).toMatchObject({ ok: true });
    const centre = out.hands.find((h: any) => h.name === 'shelter_center');
    expect(centre.hand).toMatchObject({ do: 'go', to: p(60, 70, 30), seconds: 5 });
    expect(out.waitEscalations[0].complete).toBe(true);
  });
  it('keeps the twenty-second clock through brief windows and repeatedly cancelled travel', async () => {
    const r = rig(); let shadowed = false, clock: ReturnType<typeof setInterval> | undefined;
    r.deps.cageShadowFootings.mockReturnValue([p(52.5)]);
    r.setHandler(async (h, signal) => {
      if (h.do === 'go' && h.to.x === 52) { shadowed = true; if (clock) clearInterval(clock); r.v.dragon.distance = 100; }
      if (h.do === 'go' && h.to.x === 10 && !shadowed) {
        clock ??= setInterval(() => { r.v.dragon.distance = r.v.dragon.distance === 100 ? 20 : 100; }, 1000);
        return new Promise(resolve => signal!.addEventListener('abort', () => resolve({ ok: false, lines: ['cancelled'], ms: 1000 }), { once: true }));
      }
    });
    const out = await settle(r.run(), 30_000);
    expect(out, out.endReason).toMatchObject({ ok: true });
    expect(out.interruptions.length).toBeGreaterThan(2);
    expect(out.waitEscalations[0].waitedMs).toBeGreaterThanOrEqual(20_000);
    expect(out.waitEscalations[0].waitedMs).toBeLessThan(21_000);
    const shadow = out.hands.findIndex((h: any) => h.name === 'crystal_shadow');
    expect(out.hands.slice(shadow + 1).some((h: any) => h.name === 'crystal_retreat')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('observes distance AND heading again after a miss before permitting the second arrow', async () => {
    const r = rig({ miss: true }); let shots = 0;
    r.setHandler(async h => {
      if (h.do === 'shoot' && ++shots === 1) { r.v.dragon.distance = 20; r.v.dragon.yaw = -Math.PI / 2; }
    });
    const run = r.run(); await vi.advanceTimersByTimeAsync(1000); expect(shots).toBe(1);
    r.v.dragon.distance = 100; await vi.advanceTimersByTimeAsync(1000); expect(shots).toBe(1);
    r.v.dragon.yaw = Math.PI / 2;
    const out = await settle(run); expect(out.ok).toBe(true);
    expect(out.crystals[0].shots.map((s: any) => [s.attempt, s.arrows, s.remainingArrows, s.outcome])).toEqual([[1, 1, 63, 'miss'], [2, 1, 62, 'destroyed']]);
    expect(out.crystals[0].shots[1].timing).toMatchObject({ ok: true, reason: 'flight_away' });
  });
  it('finishes the observed shared shootSet from one standing point before approaching a cage', async () => {
    const r = rig(); r.v.crystals.list = [crystal(23, true, 1), crystal(22), crystal(21)]; r.v.crystals.remaining = 3;
    r.v.crystals.openings.push(opening(22), opening(23));
    r.v.crystals.shootSets = [{ at: p(8.5), crystals: [21, 22], walkMeters: 20 }, { at: p(7.5), crystals: [21, 22], walkMeters: 10 }];
    r.setHandler(async h => { if (h.do === 'shoot') setTimeout(() => { r.v.dragon.phase = 0; }, 20); });
    const out = await settle(r.run()); expect(out, out.endReason).toMatchObject({ ok: true });
    const fired = out.hands.filter((h: any) => h.name === 'shoot_crystal');
    expect(fired.map((h: any) => h.hand.target)).toEqual([22, 21, 23]);
    expect(fired.slice(0, 2).map((h: any) => h.position.x)).toEqual([7.5, 7.5]);
    expect(out.walkWest.to).toEqual(p(7.5));
    expect(out.hands.slice(0, out.hands.findIndex((h: any) => h.name === 'go_root')).filter((h: any) => h.name === 'shoot_position')).toHaveLength(0);
    expect(out.shootSetChoices[0]).toMatchObject({ at: p(7.5), walkMeters: 10 });
  });
  it('measures reflex wall time and damage separately per crystal segment and retains hit locations/server ids on failure', async () => {
    const r = rig({ caged: true });
    const seen = new Set<string>();
    r.actor.entities = { 90: { name: 'dragon_fireball' } };
    r.setHandler(async h => {
      const label = h.do === 'vertical' ? h.dir === 'up' ? 'climbing' : 'descending' : h.do === 'dig' ? 'cage' : h.do === 'shoot' ? 'shooting' : h.do === 'go' && h.to.x === 36 ? 'walking' : null;
      if (label && !seen.has(label)) {
        seen.add(label); r.actor.floorReflexes.busy = 'flee';
        await new Promise(resolve => setTimeout(resolve, 600));
        r.actor._client.emit('damage_event', { entityId: 10, sourceDirectId: 90, sourceCauseId: 77, sourceTypeId: 3 });
        r.hurt(r.actor.health - 1); r.actor.floorReflexes.busy = null;
      }
    });
    const out = await settle(r.run()); expect(out, out.endReason).toMatchObject({ ok: true });
    for (const s of ['walking', 'shooting', 'climbing', 'cage', 'descending']) {
      expect(out.crystalExposure.segments[s].reflexSeconds).toBeGreaterThanOrEqual(0.4);
      expect(out.crystalExposure.segments[s].damageTaken).toBe(1);
      expect(out.crystalExposure.hits.find((h: any) => h.segment === s)).toMatchObject({ damage: 1, position: { y: expect.any(Number) }, server: { directName: 'dragon_fireball', direct: 90 } });
    }
    expect(r.actor._client.listenerCount('damage_event')).toBe(0); expect(r.actor.listenerCount('health')).toBe(0);
    const dead = rig(); dead.setHandler(async h => { if (h.do === 'shoot') { dead.hurt(0); dead.die(); return { ok: false, lines: ['dead'], ms: 0 }; } });
    const failed = await settle(dead.run()); expect(failed.endReason).toBe('actor_dead');
    expect(failed.crystalExposure.segments.shooting.damageTaken).toBe(20);
    expect(failed.crystalExposure.hits[0].server).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it('uses the default fast water policy, recovers the same source and shoots only after returning to ground', async () => {
    const r = rig({ caged: true, bucket: true }); const out = await settle(r.entry());
    expect(out, out.endReason).toMatchObject({ ok: true, cagePolicy: plan.FAST_CAGE_POLICY, cageTargetMet: true });
    expect(out.hands.filter((h: any) => /water_/u.test(h.name)).map((h: any) => h.name))
      .toEqual(['water_dig_pool', 'water_prepare', 'water_drop', 'water_exit_pool', 'water_scoop']);
    expect(out.hands.some((h: any) => /guard|shaft_down/u.test(h.name))).toBe(false);
    expect(out.crystals[0].cageAttempts[0]).toMatchObject({ descent: { mode: 'water_drop' }, waterRecovered: true, landingWaterSeen: true, waterMisses: 0, unintendedFalls: 0, ok: true });
    expect(out.crystals[0].cageMetrics).toMatchObject({ targetMet: true, descentDamage: 0, damageTaken: 0 });
    expect(out.crystals[0].shots[0].position.y).toBe(70); expect(r.water.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false, true])('compares both natural cages without shooting, guard=%s, with no ascent ring', async guard => {
    const name = guard ? 'cage_descent_compare_shaft_guard' : 'cage_descent_compare_shaft_fast';
    const r = rig({ caged: true, scene: name });
    r.v.crystals.list.push({ ...crystal(22, true, 40), position: p(45, 90) }); r.v.crystals.remaining = 2;
    const out = await settle(r.scenes[name]());
    expect(out, out.endReason).toMatchObject({ ok: true, endReason: 'cages_returned', cageTargetMet: true, crystalsRemaining: 2 });
    expect(out.crystals.filter((c: any) => c.cageDone)).toHaveLength(2);
    expect(out.hands.some((h: any) => /shoot|climb_guard|attack/u.test(h.name))).toBe(false);
    expect(out.hands.some((h: any) => h.name === 'guard_ring')).toBe(guard);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('refuses a comparison missing a second natural cage', async () => {
    const r = rig({ caged: true, scene: 'cage_descent_compare_shaft_fast' });
    expect(await settle(r.scenes.cage_descent_compare_shaft_fast())).toMatchObject({ ok: false, endReason: 'two_natural_cages_required' });
    expect(r.calls.some(c => c.hands[0].do === 'vertical')).toBe(false);
  });
  it('keeps waiting time in the 30-second exposure limit and marks a completed but slow comparison unsuccessful', async () => {
    const r = rig({ caged: true, scene: 'cage_descent_compare_shaft_fast' }); let delayed = false;
    r.v.crystals.list.push({ ...crystal(22, true, 40), position: p(45, 90) }); r.v.crystals.remaining = 2;
    r.setHandler(async h => { if (h.do === 'vertical' && h.dir === 'up' && !delayed) { delayed = true; await new Promise(resolve => setTimeout(resolve, 31_000)); } });
    const out = await settle(r.scenes.cage_descent_compare_shaft_fast(), 45_000);
    expect(out).toMatchObject({ ok: false, endReason: 'cages_returned', comparisonComplete: true, cageTargetMet: false });
    expect(out.crystals[0].cageMetrics.pillarMs).toBeGreaterThanOrEqual(31_000);
  });
  it('does not call a shaft fallback a completed water comparison', async () => {
    const r = rig({ caged: true, scene: 'cage_descent_compare' });
    r.v.crystals.list.push({ ...crystal(22, true, 40), position: p(45, 90) }); r.v.crystals.remaining = 2;
    const out = await settle(r.scenes.cage_descent_compare());
    expect(out).toMatchObject({ ok: false, endReason: 'cages_returned', comparisonComplete: false });
    expect(out.crystals[0].cageAttempts[0].descent).toMatchObject({ mode: 'shaft_down', reason: 'no_water_bucket' });
  });
  it('retains an unintended falling episode through recovery and records a death even when check stops the attempt immediately', async () => {
    const r = rig({ caged: true }); let pushed = false;
    r.setHandler(async h => {
      if (h.do === 'vertical' && h.dir === 'up' && !pushed) {
        pushed = true; r.actor.entity.position = new Vec3(33.5, 78, 30.5); r.actor.entity.velocity = new Vec3(0, -0.8, 0);
        return { ok: false, lines: ['被弾'], ms: 0 };
      }
      r.actor.entity.velocity = new Vec3(0, 0, 0);
    });
    const out = await settle(r.run()); expect(out.ok).toBe(true);
    expect(out.crystals[0].cageMetrics).toMatchObject({ unintendedFalls: 1, targetMet: false });
    const dead = rig({ caged: true }); dead.setHandler(async h => { if (h.do === 'vertical') dead.die(); });
    const stopped = await settle(dead.run()); expect(stopped.endReason).toBe('actor_dead');
    expect(stopped.crystals[0].cageAttempts[0]).toMatchObject({ deaths: 1, ok: false });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('falls back before dropping if the prepared water column changed, recording the actual shaft choice', async () => {
    const r = rig({ caged: true, bucket: true, policy: plan.FAST_CAGE_POLICY });
    const check = r.deps.cageWaterExit.getMockImplementation();
    r.deps.cageWaterExit.mockImplementation((...args: any[]) => r.actor.entity.position.y >= 90 ? null : check(...args));
    const out = await settle(r.run());
    expect(out, out.endReason).toMatchObject({ ok: true });
    expect(out.crystals[0].cageAttempts[0]).toMatchObject({ actualDescent: 'shaft_down', fallback: 'water_or_column_changed', waterRecovered: true });
    expect(out.hands.some((h: any) => h.name === 'water_drop')).toBe(false);
  });
  it('fails a lost water source with an empty bucket instead of reporting recovery or starting another cage', async () => {
    const r = rig({ caged: true, bucket: true, policy: plan.FAST_CAGE_POLICY });
    const check = r.deps.cageWaterExit.getMockImplementation();
    r.deps.cageWaterExit.mockImplementation((...args: any[]) => {
      if (r.actor.entity.position.y >= 90) { r.water.clear(); return null; }
      return check(...args);
    });
    const out = await settle(r.run());
    expect(out).toMatchObject({ ok: false, endReason: 'water_source_lost_without_bucket' });
    expect(out.crystals[0].cageAttempts[0]).toMatchObject({ waterRecovered: false, ok: false });
    expect(out.hands.some((h: any) => h.name === 'water_drop' || h.name === 'shoot_crystal')).toBe(false);
  });
  it('records a missed pool and damage, stops without shooting and does not report a successful descent', async () => {
    const r = rig({ caged: true, bucket: true, policy: plan.FAST_CAGE_POLICY });
    r.setHandler(async h => {
      if (h.do === 'go' && h.to.y === 69) {
        r.actor.entity.position = new Vec3(38.5, 69, 30.5); r.hurt(12); r.actor.emit('health');
        return { ok: true, lines: ['arrived elsewhere'], ms: 10 };
      }
    });
    const out = await settle(r.run());
    expect(out).toMatchObject({ ok: false, endReason: 'water_landing_missed', cageTargetMet: false });
    expect(out.crystals[0].cageMetrics).toMatchObject({ waterMisses: 1, descentDamage: 8, targetMet: false });
    expect(out.hands.some((h: any) => h.name === 'shoot_crystal')).toBe(false);
  });
  it.each(['up', 'dig', 'down'])('aborts %s during an observed charge, then rechecks the column and resumes after flight is clear', async mode => {
    const r = rig({ caged: true }); let cut = false, pending: AbortSignal | undefined;
    r.setHandler(async (h, signal) => {
      if (!cut && ((mode === 'dig' && h.do === 'dig') || (h.do === 'vertical' && h.dir === mode))) {
        cut = true; pending = signal;
        const at = r.actor.entity.position;
        r.v.dragon.position = { x: at.x + 25, y: at.y, z: at.z };
        const move = setInterval(() => { r.v.dragon.position.x -= 1; }, 100);
        setTimeout(() => { clearInterval(move); r.v.dragon.position = p(200, 100); }, 1000);
        return new Promise(resolve => signal!.addEventListener('abort', () => resolve({ ok: false, lines: ['cancelled'], ms: 100 }), { once: true }));
      }
    });
    const out = await settle(r.run());
    expect(pending?.aborted).toBe(true); expect(out, out.endReason).toMatchObject({ ok: true });
    expect(out.interruptions.some((i: any) => ['dragon_rush', 'motion_unknown'].includes(i.reason))).toBe(true);
    expect(r.deps.cageRecoveryFootings.mock.calls.length).toBeGreaterThan(3); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not relaunch a water drop after a cancellation in mid-air; the actual wet landing authorizes cleanup', async () => {
    const r = rig({ caged: true, bucket: true, policy: plan.FAST_CAGE_POLICY }); let launched = false;
    r.setHandler(async (h, signal) => {
      if (h.do === 'go' && h.to.y === 69) {
        expect(launched).toBe(false); launched = true;
        r.actor.entity.position = new Vec3(37.5, 80, 30.5); r.actor.entity.onGround = false;
        const dragon = r.v.dragon; delete r.v.dragon;
        setTimeout(() => { r.actor.entity.position.y = 69; r.actor.entity.onGround = true; r.actor.entity.isInWater = true; r.v.dragon = dragon; }, 400);
        return new Promise(resolve => signal!.addEventListener('abort', () => resolve({ ok: false, lines: ['cancelled'], ms: 100 }), { once: true }));
      }
    });
    const out = await settle(r.run());
    expect(out, out.endReason).toMatchObject({ ok: true });
    expect(out.hands.filter((h: any) => h.name === 'water_drop')).toHaveLength(1);
    expect(out.crystals[0].cageAttempts[0]).toMatchObject({ dropCut: 'cage_motion_cut', landingWaterSeen: true, waterRecovered: true });
  });
  it('refuses a run without floor reflexes before provisioning or moving', async () => {
    const r = rig(); delete r.actor.floorReflexes;
    expect(await r.run()).toMatchObject({ ok: false, endReason: 'floor_reflex_required', reflex: 'unavailable' });
    expect(r.calls).toHaveLength(0); expect(r.deps.gear).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('runs crossing, island walk, an open crystal (including a miss), wait, basin, attack and matching proof', async () => {
    const r = rig({ miss: true }); const out: any = await settle(r.run());
    expect(out).toMatchObject({ ok: true, endReason: 'dragon_dead', deaths: 0, minHealth: 20, bossVerified: true, crystalsRemaining: 0 });
    expect(out.stages.map((s: any) => s.stage)).toEqual(['enter', 'setup', 'crossing', 'walkWest', 'crystals', 'dragon', 'verify']);
    expect(out.crystals[0]).toMatchObject({ id: 21, arrows: 2, caged: false });
    expect(out.crystals[0].shots.map((s: any) => s.outcome)).toEqual(['miss', 'destroyed']);
    expect(out.crystals[0].destroyedSeconds).toBeTypeOf('number');
    expect(out.hands.find((h: any) => h.name === 'wait_landing').hand.to).toEqual(plan.chainCell(r.v.dragon.approach.wait[0]));
    expect(out.hands.find((h: any) => h.name === 'enter_basin').hand.to).toEqual(plan.chainCell(r.v.dragon.approach.basin[0]));
    expect(out.hands.findIndex((h: any) => h.hand.do === 'attack')).toBeGreaterThan(out.hands.findLastIndex((h: any) => h.hand.do === 'shoot'));
    expect(r.commands.some(s => /\btp\b|\bkill\b|\bfill\b|\bdata\b|\bsummon\b/u.test(s))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps the first successful open-crystal shot at one arrow and does no cage work', async () => {
    const r = rig(), out = await settle(r.run());
    expect(out).toMatchObject({ ok: true, arrowsUsed: 1 });
    expect(out.crystals[0].shots).toHaveLength(1);
    expect(r.calls.some(c => ['vertical', 'place', 'dig'].includes(c.hands[0].do))).toBe(false);
  });
  it('reuses the cage root/up/ring/bars/close/shaft sequence and shoots only after descending to a distant opening', async () => {
    const r = rig({ caged: true }); const out: any = await settle(r.run());
    expect(out.ok).toBe(true);
    expect(out.hands.filter((h: any) => ['go_root', 'climb_guard_ring', 'guard_ring', 'dig_bars', 'guard_close', 'shaft_down', 'shoot_crystal'].includes(h.name)).map((h: any) => h.name))
      .toEqual(['go_root', 'climb_guard_ring', 'guard_ring', 'dig_bars', 'guard_close', 'shaft_down', 'shoot_crystal']);
    expect(out.hands.filter((h: any) => h.name === 'pillar_up').map((h: any) => h.hand.toY)).toEqual([74, 78, 82, 86, 88, 90]);
    expect(out.crystals[0].shots[0].position.y).toBe(70); expect(out.crystals[0].caged).toBe(true);
  });
  it('records an actual blocked shot without inventing a destroyed crystal or spending an arrow, then tries the next observed opening', async () => {
    const r = rig(); let blocked = false;
    r.setHandler(async h => {
      if (h.do === 'shoot' && !blocked) { blocked = true; return { ok: false, lines: ['line_blocked: (38,90,30) iron_bars'], ms: 0 }; }
    });
    const out = await settle(r.run());
    expect(out.ok).toBe(true); expect(out.crystals[0].shots.map((s: any) => s.outcome)).toEqual(['line_blocked', 'destroyed']);
    expect(out.crystals[0].shots[0].arrows).toBe(0); expect(out.crystals[0].arrows).toBe(1);
    expect(out.crystals[0].shots[1].position.x).toBe(12.5);
  });
  it('finishes the same missed crystal before selecting a now-nearer crystal', async () => {
    const r = rig({ miss: true }); r.v.crystals.list.push(crystal(22, false, 40)); r.v.crystals.remaining = 2;
    r.v.crystals.openings.push(opening(22));
    r.setHandler(async h => {
      if (h.do === 'shoot') {
        const first = r.v.crystals.list.find((c: any) => c.id === 21); if (first) first.distance = 50;
        const next = r.v.crystals.list.find((c: any) => c.id === 22); if (next) next.distance = 1;
        setTimeout(() => { r.v.dragon.phase = 0; }, 20);
      }
    });
    const out = await settle(r.run());
    expect(out.ok).toBe(true);
    expect(out.hands.filter((h: any) => h.name === 'shoot_crystal').map((h: any) => h.hand.target)).toEqual([21, 21, 22]);
    expect(out.crystals.find((c: any) => c.id === 21).shots.map((s: any) => s.position.x)).toEqual([10.5, 12.5]);
  });
  it('reuses the same valid opening if no alternative exists, with at most two attempts total', async () => {
    const r = rig({ misses: 1 }); r.v.crystals.openings[0].positions = [p(10.5)];
    const out = await settle(r.run());
    expect(out.ok).toBe(true); expect(out.crystals[0].shots.map((s: any) => s.outcome)).toEqual(['miss', 'destroyed']);
    expect(out.crystals[0].arrows).toBe(2);
    const limited = rig({ misses: 4 });
    expect(await settle(limited.run())).toMatchObject({ ok: false, endReason: 'crystal_shot_limit:21', arrowsUsed: 2 });
    expect(limited.calls.filter(c => c.hands[0].do === 'shoot')).toHaveLength(2);
    const empty = rig({ misses: 4, arrows: 1 });
    expect(await settle(empty.run())).toMatchObject({ ok: false, endReason: 'arrows_exhausted', arrowsUsed: 1 });
  });
  it.each(['near', 'facing', 'ball'] as const)('waits at preselected ground while %s prevents travel, then resumes on distant flight away', async reason => {
    const r = rig();
    if (reason === 'near') r.v.dragon.distance = 20;
    if (reason === 'facing') r.v.dragon.yaw = -Math.PI / 2;
    if (reason === 'ball') r.v.dragonFireballs = 1;
    const run = r.run(); await vi.advanceTimersByTimeAsync(1500);
    expect(r.calls.some(c => c.hands[0].do === 'shoot')).toBe(false);
    expect(r.calls.some(c => c.hands[0].do === 'vertical')).toBe(false);
    r.v.dragon.distance = 100; r.v.dragon.yaw = Math.PI / 2; r.v.dragonFireballs = 0;
    const out = await settle(run); expect(out.ok).toBe(true);
    expect(out.retreatPlans[0].seconds).toBeLessThanOrEqual(out.movementDecisions[0].seconds);
    expect(out.waitingChosen[0].to).toEqual(p(60.5, 70, 30.5));
    expect(out.movementDecisions.some((d: any) => d.ok)).toBe(true);
  });
  it('aborts travel when a fireball appears and returns to the reached footing before resuming', async () => {
    const r = rig(); let cut = false, pending: AbortSignal | undefined;
    r.setHandler(async (h, signal) => {
      if (!cut && h.do === 'go' && h.to.x === 10) {
        cut = true; pending = signal;
        r.actor.entity.position = new Vec3(25.5, 70, 30.5);
        setTimeout(() => { r.v.dragonFireballs = 1; }, 50);
        return new Promise(resolve => signal!.addEventListener('abort', () => resolve({ ok: false, lines: ['cancelled'], ms: 100 }), { once: true }));
      }
    });
    const run = r.run(); await vi.advanceTimersByTimeAsync(1000);
    expect(pending?.aborted).toBe(true);
    expect(r.calls.filter(c => c.hands[0].do === 'shoot')).toHaveLength(0);
    expect(r.actor.entity.position.x).toBe(60.5);
    r.v.dragonFireballs = 0;
    const out = await settle(run); expect(out.ok).toBe(true);
    expect(out.interruptions.some((i: any) => i.reason === 'fireball')).toBe(true);
  });
  it('lands after a displaced ascent before recalculating the crystal root and climbing again', async () => {
    const r = rig({ caged: true }); let pushed = false;
    r.deps.cageRoots.mockImplementation((_bot: any, observed: any) => {
      expect(observed).toEqual(r.v.crystals.list[0].position);
      return [p(pushed ? 35 : 36, 70, 30)];
    });
    r.setHandler(async h => {
      if (h.do === 'vertical' && h.dir === 'up' && !pushed) {
        pushed = true; r.actor.entity.position = new Vec3(33.5, 86, 30.5); r.actor.entity.onGround = false;
        setTimeout(() => { r.actor.entity.position.y = 70; r.actor.entity.onGround = true; }, 1200);
        return { ok: false, lines: ['被弾'], ms: 0 };
      }
    });
    const out = await settle(r.run());
    expect(out.ok).toBe(true); expect(out.crystals[0].cageRestarts).toBe(1);
    expect(out.cageRecoveries[0]).toMatchObject({ ok: true, reason: 'cage_displaced', footing: { kind: 'ground' } });
    const rootCalls = out.hands.filter((h: any) => h.name === 'go_root');
    expect(rootCalls.map((h: any) => h.hand.to.x)).toEqual([36, 35]);
    expect(out.hands.some((h: any) => h.hand.do === 'vertical' && h.position.y === 86 && h.position.x === 33.5)).toBe(false);
    expect(rootCalls[1].seconds).toBeGreaterThanOrEqual(out.cageRecoveries[0].seconds + 1.2);
  });
  it('uses a verified reachable cobblestone shaft for descent and never reissues a displaced vertical', async () => {
    const r = rig({ caged: true }); let pushed = false;
    r.setHandler(async h => {
      if (h.do === 'vertical' && h.dir === 'up' && !pushed) {
        pushed = true; r.actor.entity.position = new Vec3(33.5, 78, 30.5);
        return { ok: false, lines: ['被弾'], ms: 0 };
      }
    });
    const out = await settle(r.run()); expect(out.ok).toBe(true);
    const down = out.hands.find((h: any) => h.name === 'cage_recovery_down');
    expect(down.position).toEqual(p(33.5, 78, 30.5)); expect(down.hand.toY).toBe(70);
    expect(out.cageRecoveries[0].footing.kind).toBe('shaft');
  });
  it('does not trust an up hand reporting done when the body is above its goal in a different column (r137)', async () => {
    const r = rig({ caged: true }); let pushed = false;
    r.setHandler(async h => {
      if (h.do === 'vertical' && h.dir === 'up' && !pushed) {
        pushed = true; r.actor.entity.position = new Vec3(33.5, 86, 30.5);
        return { ok: true, lines: ['vertical 済み は既に y=74 以上'], ms: 0 };
      }
    });
    const out = await settle(r.run()); expect(out.ok).toBe(true);
    expect(out.cageRecoveries[0].reason).toBe('cage_displaced');
    expect(out.crystals[0].cageRestarts).toBe(1);
    expect(out.hands.find((h: any) => h.position.x === 33.5)?.name).toBe('cage_recovery_footing');
  });
  it.each(['stock', 'geometry'] as const)('records why the optional ascent ring cannot be built: %s', async reason => {
    const r = rig({ caged: true, blocks: reason === 'stock' ? 20 : 64 });
    if (reason === 'geometry') r.deps.cageGuardWork.mockReturnValueOnce(null);
    const out = await settle(r.run()); expect(out.ok).toBe(true);
    expect(out.crystals[0].climbGuard).toMatchObject({ used: false, reason: reason === 'stock' ? 'reserve_top_guard_and_ascent' : 'unbuildable_ring' });
    expect(out.hands.some((h: any) => h.name === 'climb_guard_ring')).toBe(false);
    expect(out.hands.some((h: any) => h.name === 'guard_ring')).toBe(true);
  });
  it('reserves remaining cages before buying an optional ascent ring, reading their roots while still on ground', async () => {
    const r = rig({ caged: true, blocks: 30 });
    const other = { ...crystal(22, true, 40), position: p(40, 110) };
    r.v.crystals.list.push(other); r.v.crystals.remaining = 2; r.v.crystals.openings.push(opening(22));
    r.deps.cageRoots.mockImplementation(() => {
      expect(r.actor.entity.position.y).toBe(70); return [p(36, 70, 30)];
    });
    r.setHandler(async h => { if (h.do === 'shoot') setTimeout(() => { r.v.dragon.phase = 0; }, 20); });
    const out = await settle(r.run()); expect(out.ok).toBe(true);
    expect(out.crystals[0].climbGuard).toMatchObject({ blocks: 30, future: 52, required: 56, used: false, reason: 'reserve_top_guard_and_ascent' });
  });
  it('preserves stock for unseen cages instead of assuming the loaded list is complete', async () => {
    const r = rig({ caged: true }); r.v.crystals.unseen = [{ x: 100, z: 100 }];
    r.setHandler(async h => { if (h.do === 'shoot') r.v.crystals.unseen = []; });
    const out = await settle(r.run()); expect(out.ok).toBe(true);
    expect(out.crystals[0].climbGuard).toMatchObject({ used: false, reason: 'future_cage_stock_unknown' });
  });
  it('limits cage restarts to two and safely reports a missing descent without a speculative shaft', async () => {
    const r = rig({ caged: true });
    r.setHandler(async h => {
      if (h.do === 'vertical' && h.dir === 'up') {
        r.actor.entity.position = new Vec3(33.5, 70, 30.5);
        return { ok: false, lines: ['被弾'], ms: 0 };
      }
    });
    const out = await settle(r.run()); expect(out).toMatchObject({ ok: false, endReason: 'cage_restart_limit' });
    expect(out.crystals[0].cageRestarts).toBe(2);
    expect(out.hands.filter((h: any) => h.name === 'go_root')).toHaveLength(3);
    const blocked = rig({ caged: true }); let pushed = false;
    blocked.setHandler(async h => {
      if (h.do === 'vertical' && h.dir === 'up') {
        pushed = true; blocked.actor.entity.position = new Vec3(33.5, 86, 30.5);
        return { ok: false, lines: ['被弾'], ms: 0 };
      }
    });
    const normal = blocked.deps.cageRecoveryFootings.getMockImplementation();
    blocked.deps.cageRecoveryFootings.mockImplementation((...args: any[]) => pushed ? [] : normal(...args));
    expect(await settle(blocked.run())).toMatchObject({ ok: false, endReason: 'no_safe_cage_descent' });
    expect(blocked.calls.some(c => c.hands[0].do === 'vertical' && c.hands[0].dir === 'down')).toBe(false);
  });
  it('revalidates support after the recovery walk and refuses a shaft if another push changed the position', async () => {
    const r = rig({ caged: true }); let pushed = false;
    r.setHandler(async h => {
      if (h.do === 'vertical' && h.dir === 'up' && !pushed) {
        pushed = true; r.actor.entity.position = new Vec3(33.5, 78, 30.5);
        return { ok: false, lines: ['被弾'], ms: 0 };
      }
      if (pushed && h.do === 'go' && h.to.x === 33) {
        r.actor.entity.position.x = 32.5; return { ok: true, lines: ['go done then pushed'], ms: 0 };
      }
    });
    expect(await settle(r.run())).toMatchObject({ ok: false, endReason: 'cage_recovery_support_changed' });
    expect(r.calls.some(c => c.hands[0].do === 'vertical' && c.hands[0].dir === 'down')).toBe(false);
  });
  it('aborts an in-flight crystal go on phase 6, retreats, and does no crystal work until the sit ends', async () => {
    const r = rig(); let cut = false, pending: AbortSignal | undefined;
    r.setHandler(async (h, signal) => {
      if (!cut && h.do === 'go' && h.to.x === 10) {
        cut = true; pending = signal;
        setTimeout(() => { r.v.dragon.phase = 6; }, 50);
        return new Promise(resolve => signal!.addEventListener('abort', () => resolve({ ok: false, lines: ['cancelled'], ms: 100 }), { once: true }));
      }
    });
    const run = r.run(); await vi.advanceTimersByTimeAsync(1000);
    expect(pending?.aborted).toBe(true); expect(r.calls.some(c => c.hands[0].do === 'shoot')).toBe(false);
    r.v.dragon.phase = 0; const out: any = await settle(run);
    expect(out.ok).toBe(true); expect(out.interruptions[0].reason).toBe('phase_6');
  });
  it('cuts cage climbing at phase 6 and descends the verified shaft before retreat', async () => {
    const r = rig({ caged: true }); let cut = false;
    r.setHandler(async (h, signal) => {
      if (h.do === 'vertical' && h.dir === 'up' && !cut) {
        cut = true; r.actor.entity.position.y = 80;
        setTimeout(() => { r.v.dragon.phase = 6; }, 50);
        return new Promise(resolve => signal!.addEventListener('abort', () => resolve({ ok: false, lines: ['cancelled'], ms: 100 }), { once: true }));
      }
    });
    const run = r.run(); await vi.advanceTimersByTimeAsync(1000);
    expect(r.calls.some(c => c.hands[0].do === 'vertical' && c.hands[0].dir === 'down')).toBe(true);
    expect(r.calls.some(c => c.hands[0].do === 'dig')).toBe(false);
    r.v.dragon.phase = 0; expect((await settle(run) as any).ok).toBe(true);
  });
  it('aborts a long swing at takeoff and walks to the observed wait before another attack', async () => {
    const r = rig({ empty: true }); let attackSignal: AbortSignal | undefined, attacks = 0;
    r.setHandler(async (h, signal) => {
      if (h.do === 'attack' && attacks++ === 0) {
        attackSignal = signal; setTimeout(() => { r.v.dragon.phase = 4; }, 50);
        return new Promise(resolve => signal!.addEventListener('abort', () => resolve({ ok: false, lines: ['cancelled'], ms: 100 }), { once: true }));
      }
    });
    const out: any = await settle(r.run());
    expect(attackSignal?.aborted).toBe(true); expect(out.ok).toBe(true);
    expect(out.hands.some((h: any) => h.name === 'leave_basin' && h.hand.to.x === 14)).toBe(true);
  });
  it('retains a wait read from the observation if the optional wait field disappears on takeoff', async () => {
    const r = rig({ empty: true }); let attacks = 0;
    const waiting = r.v.dragon.approach.wait;
    r.setHandler(async h => {
      if (h.do === 'attack' && attacks++ === 0) { r.v.dragon.phase = 4; delete r.v.dragon.approach.wait; return { ok: false, lines: ['takeoff'], ms: 0 }; }
      if (h.do === 'go' && h.to.x === 14) r.v.dragon.approach.wait = waiting;
    });
    const out = await settle(r.run());
    expect(out.ok).toBe(true); expect(out.waitingChosen.find((w: any) => w.reason === 'takeoff')).toMatchObject({ to: p(14.5), retainedObservation: true });
  });
  it('never attacks while unknown crystals remain; the 15-minute crystal cap stops an in-flight hand', async () => {
    const r = rig(); r.v.crystals.list = []; r.v.crystals.unseen = [{ x: 41, z: 9 }];
    let signal: AbortSignal | undefined;
    r.setHandler(async (h, s) => {
      if (h.do === 'go' && r.calls.filter(c => c.hands[0].do === 'go').length >= 3) { signal = s;
        return new Promise(resolve => s!.addEventListener('abort', () => resolve({ ok: false, lines: ['cancelled'], ms: 0 }), { once: true })); }
    });
    const run = r.run(); await vi.advanceTimersByTimeAsync(plan.CRYSTAL_LIMIT_MS + 1000);
    const out: any = await run; expect(signal?.aborted).toBe(true);
    expect(out).toMatchObject({ ok: false, endReason: 'crystal_time_limit' });
    expect(r.calls.some(c => c.hands[0].do === 'attack')).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
  it('stops at the overall 40-minute cap during dragon waiting and retains the health timeline', async () => {
    const r = rig({ empty: true }); delete r.v.dragon.approach; r.v.perch = p(60.5, 74);
    const run = r.run(); await vi.advanceTimersByTimeAsync(plan.CHAIN_LIMIT_MS + 200);
    const out: any = await run; expect(out).toMatchObject({ ok: false, endReason: 'time_limit', seconds: 2400 });
    expect(out.healthTimeline.length).toBeGreaterThanOrEqual(480); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects another dragon\'s proof and reports deaths/lowest health and cumulative reflex counts', async () => {
    const r = rig({ missingProof: true }); r.totals.retreat = 5;
    const run = r.run(); await vi.advanceTimersByTimeAsync(100); r.totals.retreat = 8; r.hurt(12);
    const out: any = await settle(run);
    expect(out).toMatchObject({ ok: false, endReason: 'boss_unverified', bossVerified: false, minHealth: 12, reflexKinds: { retreat: 3 } });
    const dead = rig(); const dying = dead.run(); await vi.advanceTimersByTimeAsync(30); dead.die();
    expect(await settle(dying)).toMatchObject({ ok: false, endReason: 'actor_dead', deaths: 1 });
  });
});

describe('shared cage/arrival geometry', () => {
  it('builds a supported enclosure with existing place and opens it with dig using client physics', async () => {
    vi.useFakeTimers(); vi.spyOn(performance, 'now').mockReturnValue(0);
    const s = makeHandsSim((_x, y, _z) => y <= 69 ? 'end_stone' : 'air',
      { start: [36.5, 70, 30.5], items: [{ name: 'cobblestone', count: 20 }, { name: 'iron_pickaxe', count: 1 }] });
    const context = () => ({ bot: s.bot, stop: new AbortController().signal, deadline: Date.now() + 30_000, facing: 'north' as const, base: plan.chainCell(s.bot.entity.position) });
    const clock = setInterval(s.tick, 50);
    try {
      const cells = crystalShelterWork(s.bot)!; expect(cells).toHaveLength(10); accepted(plan.chainHands.place(cells));
      const built = await settle(place(context(), { at: cells, block: 'cobblestone' })); expect(built, JSON.stringify(built)).toMatchObject({ ok: true });
      expect(crystalShelterWork(s.bot)).toEqual([]);
      expect(s.world.nameAt(36, 72, 30)).toBe('cobblestone');
      expect(s.world.nameAt(36, 70, 30)).toBe('air'); expect(s.world.nameAt(36, 71, 30)).toBe('air');
      const exit = [...cells].reverse().sort((a, b) => b.y - a.y); accepted(plan.chainHands.dig(exit));
      const opened = await settle(dig(context(), { at: exit, tool: 'iron_pickaxe', collect: false }));
      expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true });
      expect(s.world.nameAt(36, 69, 30)).toBe('end_stone');
      expect(cageDryFooting(s.bot)).toBe(true);
    } finally { clearInterval(clock); }
  });
  it('refuses enclosure geometry on an edge, in air, or across unknown/occupied cells; retains existing floor', () => {
    const s = makeHandsSim((_x, y, _z) => y <= 69 ? 'end_stone' : 'air', { start: [36.5, 70, 30.5] });
    const shape = crystalShelterCells(s.bot.entity.position); expect(shape).toHaveLength(15);
    expect(shape).toContainEqual(p(36, 69, 30));
    expect(shape.some(q => q.x === 36 && q.z === 30 && (q.y === 70 || q.y === 71))).toBe(false);
    for (const name of [null, 'iron_bars', 'water']) { s.world.set(37, 71, 30, name); expect(crystalShelterWork(s.bot)).toBeNull(); }
    s.world.set(37, 71, 30, 'air'); s.bot.entity.position.x = 36.85; expect(crystalShelterWork(s.bot)).toBeNull();
    s.bot.entity.position.x = 36.5; s.bot.entity.onGround = false; expect(crystalShelterWork(s.bot)).toBeNull();
  });
  it.each([false, true])('prepares a pool, climbs, drops into water and scoops using existing hands and real physics, guard=%s', async guard => {
    vi.useFakeTimers(); vi.spyOn(performance, 'now').mockReturnValue(0);
    const s = makeHandsSim((_x, y, _z) => y <= 69 ? 'end_stone' : 'air',
      { start: [36.5, 70, 30.5], items: [{ name: 'cobblestone', count: 64 }, { name: 'iron_pickaxe', count: 1 }, { name: 'water_bucket', count: 1 }] });
    const root = p(36, 70, 30), source = cageWaterLandings(s.bot, root, 90)[0];
    expect(source).toEqual(p(37, 69, 30));
    const context = () => ({ bot: s.bot, stop: new AbortController().signal, deadline: Date.now() + 60_000, facing: 'north' as const, base: plan.chainCell(s.bot.entity.position) });
    const timer = setInterval(s.tick, 50);
    let touchedWater = false, descending = false;
    const columns: string[] = [];
    const watch = () => {
      touchedWater ||= s.bot.entity.isInWater;
      const q = s.bot.entity.position;
      if (descending && q.y < 89 && q.y > source.y + 1 && s.bot.entity.velocity.y < -0.2) columns.push(`${Math.floor(q.x)},${Math.floor(q.z)}`);
    };
    s.bot.on('physicsTick', watch);
    try {
      expect((await settle(dig(context(), { at: [source], tool: 'iron_pickaxe', collect: false }))).ok).toBe(true);
      expect((await settle(use(context(), { item: 'water_bucket', at: source, against: 'down' }))).ok).toBe(true);
      expect(cageWaterSource(s.bot, source)).toBe(true); expect(s.world.nameAt(root.x, root.y, root.z)).toBe('air');
      expect((await settle(vertical(context(), plan.chainHands.up(90) as any))).ok).toBe(true);
      if (guard) {
        const cells = cageGuardCells(s.bot.entity.position, [p(38, 90, 30)]);
        expect((await settle(place(context(), { at: cells.ring, block: 'cobblestone' }))).ok).toBe(true);
        expect((await settle(place(context(), { at: cells.close, block: 'cobblestone' }))).ok).toBe(true);
        const remove = cageWaterExit(s.bot, root, source, 90)!; expect(remove).toHaveLength(3);
        expect((await settle(dig(context(), { at: remove, tool: 'iron_pickaxe', collect: false }))).ok).toBe(true);
      }
      expect(cageWaterExit(s.bot, root, source, 90)).toEqual([]);
      const h = plan.chainHands.down(70, source); accepted(h);
      descending = true;
      const dropped = await settle(go(context(), { ...h, goals: [source] } as any));
      expect(dropped, JSON.stringify(dropped)).toMatchObject({ ok: true });
      expect(touchedWater).toBe(true); expect(plan.chainOnShaft(s.bot.entity.position, source)).toBe(true);
      expect(columns.length).toBeGreaterThan(0); expect(new Set(columns)).toEqual(new Set([`${source.x},${source.z}`]));
      const dry = cagePoolExits(s.bot, source)[0]; expect(dry).toBeDefined(); expect(plan.chainOnShaft(dry, root)).toBe(false);
      expect((await settle(go(context(), { goals: [dry], range: 0, seconds: 10, waterOk: true, maxDig: 0, maxPlace: 0, maxDrop: 1 }))).ok).toBe(true);
      expect(cageDryFooting(s.bot)).toBe(true);
      expect((await settle(use(context(), { item: 'bucket', at: source }))).ok).toBe(true);
      expect(cageWaterSource(s.bot, source)).toBe(false); expect(s.count('water_bucket')).toBe(1);
    } finally { clearInterval(timer); s.bot.removeListener('physicsTick', watch); }
  });
  it('offers only contained, loaded, adjacent natural pools and rejects a blocked drop or changed water source', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const s = makeHandsSim((_x, y, _z) => y <= 69 ? 'end_stone' : 'air', { start: [36.5, 70, 30.5] });
    const root = p(36, 70, 30), source = p(37, 69, 30);
    expect(cageWaterLandings(s.bot, root, 90)).toHaveLength(4);
    expect(cageWaterLandings(s.bot, root, 72)).toEqual([]);
    s.world.set(37, 82, 30, null); expect(cageWaterLandings(s.bot, root, 90)).not.toContainEqual(source);
    s.world.set(37, 82, 30, 'air'); s.world.set(37, 68, 30, 'air');
    expect(cageWaterLandings(s.bot, root, 90)).not.toContainEqual(source);
    s.world.set(37, 68, 30, 'end_stone'); s.world.set(38, 69, 30, 'air');
    expect(cageWaterLandings(s.bot, root, 90)).not.toContainEqual(source);
    s.world.set(38, 69, 30, 'end_stone'); s.world.set(37, 69, 30, 'water');
    expect(cageWaterExit(s.bot, root, source, 90)).toEqual([]);
    for (const obstruction of ['iron_bars', 'obsidian', 'cobblestone', null]) {
      s.world.set(37, 78, 30, obstruction); expect(cageWaterExit(s.bot, root, source, 90)).toBeNull();
    }
    s.world.set(37, 78, 30, 'air'); s.world.set(37, 69, 30, 'water~1');
    expect(cageWaterExit(s.bot, root, source, 90)).toBeNull();
    s.world.set(37, 69, 30, 'water'); s.world.set(37, 68, 30, 'air');
    expect(cageWaterExit(s.bot, root, source, 90)).toBeNull();
  });
  it('requires dry support for scooping and derives a supported tower shadow from the observed dragon side', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const s = makeHandsSim((x, y, z) => y <= 69 ? 'end_stone' : x >= 39 && x <= 41 && z >= 29 && z <= 31 && y <= 90 ? 'obsidian' : 'air', { start: [36.5, 70, 30.5] });
    expect(cageDryFooting(s.bot)).toBe(true);
    const shadow = cageShadowFootings(s.bot, p(60, 80, 30.5), p(40.5, 90, 30.5));
    expect(shadow.length).toBeGreaterThan(0); expect(shadow.every(q => q.x < 40.5)).toBe(true);
    const reverse = cageShadowFootings(s.bot, p(20, 80, 30.5), p(40.5, 90, 30.5));
    expect(reverse.length).toBeGreaterThan(0); expect(reverse.every(q => q.x > 40.5)).toBe(true);
    s.world.set(36, 69, 30, 'water'); expect(cageDryFooting(s.bot)).toBe(false);
    s.world.set(36, 69, 30, 'end_stone'); s.bot.entity.position.y = 72; expect(cageDryFooting(s.bot)).toBe(false);
  });
  it('can build the upper-ascent ring, climb two more levels, guard the top and descend using real client physics and existing hands', async () => {
    vi.useFakeTimers();
    const s = makeHandsSim((x, y, z) => y === 69 ? 'end_stone' : x === 36 && z === 30 && y >= 70 && y < 88 ? 'cobblestone' : 'air',
      { start: [36.5, 88, 30.5], items: [{ name: 'cobblestone', count: 64 }, { name: 'iron_pickaxe', count: 1 }] });
    const context = () => ({ bot: s.bot, stop: new AbortController().signal, deadline: Date.now() + 60_000, facing: 'north' as const, base: plan.chainCell(s.bot.entity.position) });
    const timer = setInterval(s.tick, 50);
    try {
      const guard = cageGuardCells(s.bot.entity.position, [p(38, 90, 30)]);
      expect((await settle(place(context(), { at: guard.ring, block: 'cobblestone' }))).ok).toBe(true);
      const up: any = plan.chainHands.up(90); expect((await settle(vertical(context(), up))).ok).toBe(true);
      const top = cageGuardCells(s.bot.entity.position, [p(38, 90, 30)]), work = cageGuardWork(s.bot, top.ring)!;
      expect(work).toHaveLength(7);
      expect((await settle(place(context(), { at: work, block: 'cobblestone' }))).ok).toBe(true);
      const down: any = plan.chainHands.down(70), descended = await settle(vertical(context(), down));
      expect(descended, JSON.stringify(descended)).toMatchObject({ ok: true });
      expect(s.bot.entity.position.y).toBeCloseTo(70, 1);
    } finally { clearInterval(timer); }
  });
  it('offers reached natural ground after landing, and a continuous cobblestone shaft onto it', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const s = makeSim((_x, y, _z) => y === 69 ? 'end_stone' : 'air', { start: [36.5, 70, 30.5] });
    s.bot.entity.onGround = false; expect(cageRecoveryFootings(s.bot)).toEqual([]);
    s.bot.entity.onGround = true;
    expect(cageRecoveryFootings(s.bot)[0]).toEqual({ at: p(36.5, 70, 30.5), ground: p(36.5, 70, 30.5), kind: 'ground' });
    for (let y = 70; y < 78; y++) s.world.set(36, y, 30, 'cobblestone');
    s.bot.entity.position.y = 78;
    expect(cageRecoveryFootings(s.bot)[0]).toEqual({ at: p(36.5, 78, 30.5), ground: p(36.5, 70, 30.5), kind: 'shaft' });
    s.world.set(36, 74, 30, 'air'); expect(cageRecoveryFootings(s.bot)).toEqual([]);
    s.world.set(36, 74, 30, 'obsidian'); expect(cageRecoveryFootings(s.bot)).toEqual([]);
  });
  it('does not offer an obsidian pillar, liquid shaft, void floor or unsupported natural rim as a recovery descent', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const s = makeSim((_x, _y, _z) => 'air', { start: [36.5, 78, 30.5] });
    s.bot.entity.onGround = true;
    for (let y = 69; y < 78; y++) s.world.set(36, y, 30, 'obsidian');
    expect(cageRecoveryFootings(s.bot)).toEqual([]);
    for (let y = 70; y < 78; y++) s.world.set(36, y, 30, 'cobblestone');
    s.world.set(36, 69, 30, 'end_stone'); expect(cageRecoveryFootings(s.bot)).toEqual([]);
    s.world.set(36, 74, 30, 'lava'); expect(cageRecoveryFootings(s.bot)).toEqual([]);
  });
  it('keeps full existing support in an ascent ring and rejects an unbuildable or unloaded ring', () => {
    const s = makeSim((_x, y, _z) => y < 87 ? 'obsidian' : 'air', { start: [36.5, 88, 30.5] });
    const cells = cageGuardCells(s.bot.entity.position, [p(38, 90, 30)]).ring;
    s.world.set(cells[0].x, cells[0].y, cells[0].z, 'obsidian');
    expect(cageGuardWork(s.bot, cells)).toEqual(cells.slice(1));
    s.world.set(cells[1].x, cells[1].y, cells[1].z, 'lava'); expect(cageGuardWork(s.bot, cells)).toBeNull();
    s.world.set(cells[1].x, cells[1].y, cells[1].z, 'iron_bars'); expect(cageGuardWork(s.bot, cells)).toBeNull();
    s.world.set(cells[1].x, cells[1].y, cells[1].z, null); expect(cageGuardWork(s.bot, cells)).toBeNull();
  });
  it('offers the visible front bar column instead of the preferred ballistic blocker behind it (r136)', () => {
    const s = makeSim((_x, y, _z) => y === 89 ? 'end_stone' : 'air', { start: [36.5, 90, 30.5] });
    for (const x of [38, 39]) for (const y of [90, 91]) s.world.set(x, y, 30, 'iron_bars');
    const wall = cageWall(s.bot, p(40.5, 90, 30.5), p(39, 91, 30));
    expect(wall.length).toBeGreaterThan(0); expect(wall.every(c => c.x === 38)).toBe(true);
  });
  it('offers only loaded natural island footings with a support rim, without fixed arrival coordinates', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const s = makeSim((x, y, z) => x >= 209 && x <= 230 && z >= -20 && z <= 0 && y === 73 ? 'end_stone' : 'air', { start: [201.5, 65, -10.5] });
    const found = islandFootings(s.bot, s.bot.entity.position, 30);
    expect(found.length).toBeGreaterThan(0); expect(found.every(q => q.x >= 211.5 && q.y === 74)).toBe(true);
    expect(s.bot.entity.position).toEqual(new Vec3(201.5, 65, -10.5));
  });
  it('shares the cage column, reachable bars and supported ring ordering', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const s = makeSim((_x, y, _z) => y === 69 ? 'end_stone' : 'air', { start: [36.5, 70, 30.5] });
    expect(cageRoots(s.bot, p(40.5, 90, 30.5)).length).toBeGreaterThan(0);
    s.bot.entity.position.y = 90; s.world.set(38, 90, 30, 'iron_bars'); s.world.set(38, 91, 30, 'iron_bars');
    expect(cageWall(s.bot, p(40.5, 90, 30.5))).toHaveLength(2);
    const guard = cageGuardCells(s.bot.entity.position, [p(38, 90, 30)]);
    expect(guard.ring).toHaveLength(10); expect(guard.ring.slice(0, 4).every(q => q.y === 89)).toBe(true); expect(guard.close).toHaveLength(2);
  });
});
