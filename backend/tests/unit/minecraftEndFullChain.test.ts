import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as plan from '../../src/services/minebot/utils/endFullChainPlan.js';
import { cageGuardCells, cageRoots, cageWall, islandFootings } from '../../src/services/minebot/utils/endFightGeometry.js';
import { ACT_HANDS } from '../../src/services/minebot/instantSkills/act.js';
import { handProblem } from '../../src/services/minebot/utils/actHandRules.js';
import { goProblem } from '../../src/services/minebot/utils/primitives/go.js';
import { feetCentre } from '../../src/services/minebot/utils/dragonWalk.js';
import { makeSim } from '../helpers/physicsBody.js';

const source = fs.readFileSync(new URL('../../scripts/minecraft-end-fight-probe.ts', import.meta.url), 'utf8');
const section = source.split('// ===== end_full_chain:')[1].split('// ===== end end_full_chain =====')[0];
const result = ts.transpileModule('// ' + section, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
const p = (x: number, y = 70, z = 30) => ({ x, y, z });
const crystal = (id = 21, caged: boolean | null = false, distance = 30) => ({ id, caged, distance, position: p(40, 90) });
const opening = (id = 21) => ({ id, caged: false, positions: [p(10.5), p(12.5)], afterCageRemoved: [p(14.5)], blockedBy: { ...p(38, 90), name: 'iron_bars' } });
function view(): any {
  return { position: p(5.5), health: 20, food: 20, inventory: [{ name: 'arrow', count: 64 }],
    perch: p(2.5, 74), dragon: { id: 77, phase: 0, health: 200, approach: { wait: [p(14.5)], basin: [p(4.5)] } },
    crystals: { remaining: 1, gone: 0, list: [crystal()], unseen: [], openings: [opening()], shootSets: [] } };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function accepted(hand: any) {
  expect(ACT_HANDS.safeParse([hand]).success).toBe(true);
  expect(handProblem(hand)).toBeNull();
  if (hand.do === 'go') expect(goProblem(hand)).toBeNull();
}

describe('end_full_chain stand-in HEAD choices', () => {
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
  it('accepts every generated go/shoot/vertical/dig/place argument through the real act schema and range checks', () => {
    const h = plan.chainHands, guard = cageGuardCells(p(36.5, 90), [p(38, 90)]);
    for (const hand of [h.crossing(p(90)), h.go(p(10)), h.go(p(10), 12, 0), h.up(90), h.down(70), h.dig([p(38, 90)]),
      h.place(guard.ring), h.place(guard.close), h.shoot(21), h.attack(), { do: 'equip', item: 'shield', slot: 'offhand' }, { do: 'eat' }]) accepted(hand);
    expect(goProblem(h.go(p(10), 4))).toMatch(/5〜120/u);
    for (const seconds of [5, 120]) accepted(h.go(p(10), seconds));
  });
});

async function runSelection(wanted: string[], ok = true, writeFails = false) {
  const report: any = { scenes: {}, errors: [] }, calls: string[] = [], writes: string[] = [];
  const scenes = Object.fromEntries(['enter', 'parts', 'end_full_chain', 'dragon_kill_basin_walk'].map(name => [name, async () => { calls.push(name); return { ok }; }]));
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

function rig(options: { caged?: boolean; empty?: boolean; missingProof?: boolean; miss?: boolean } = {}) {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const actor: any = new EventEmitter(); actor.health = 20; actor.game = { dimension: 'the_end' }; actor.floorReflexes = {};
  actor.entity = { position: new Vec3(120.5, 70, 30.5) };
  const v = view(); if (options.caged) v.crystals.list[0].caged = true;
  if (options.empty) { v.crystals.list = []; v.crystals.remaining = 0; v.dragon.phase = 3; }
  let arrows = 64, minHealth = 20, missed = false;
  const calls: any[] = [], commands: string[] = [], totals: Record<string, number> = {};
  actor.reflexLedger = { counts: () => ({ ...totals }) };
  const read = () => ({ ...v, position: { ...actor.entity.position }, health: actor.health, inventory: [{ name: 'arrow', count: arrows }] });
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
      if (h.do === 'vertical') actor.entity.position.y = h.toY;
      if (h.do === 'shoot') {
        arrows--;
        if (options.miss && !missed) { missed = true; line = '外れた（クリスタルは残っている）'; }
        else { v.crystals.list = v.crystals.list.filter((c: any) => c.id !== h.target); v.crystals.remaining = v.crystals.list.length;
          v.dragon.phase = 3; if (v.crystals.remaining === 0) setTimeout(() => { v.dragon.phase = 6; }, 600);
          line = 'クリスタルを壊した（爆発した）'; }
      }
      if (h.do === 'attack') { v.dragon.health = 0; v.dragon.phase = 9; actor.emit('entityDead', { id: 77 }); }
    }
    await new Promise(resolve => setTimeout(resolve, 10));
    return { ok: true, lines: [line], parsed: { ok: true }, ms: 10 };
  };
  const deps: Record<string, any> = { ...plan, actor, wanted: ['enter', 'end_full_chain'], report: { scenes: { enter: {} } },
    scenes: {}, chainArrivalAt: Date.now(), chainArrivalMinHealth: 20, chainArrivalCounts: null, chainArrivalTimeline: [], disconnected: null, body: { observe: () => ({ state: { world: read() } }) },
    trackMinHealth: () => ({ stop: () => minHealth }), feetCentre, act,
    islandFootings: vi.fn((_bot, to) => [to.x === 120.5 ? p(91.5) : p(60.5)]),
    cageRoots: vi.fn(() => [p(36, 70, 30)]), cageWall: vi.fn(() => [p(38, 90, 30)]), cageGuardCells,
    ask: async (s: string) => { commands.push(s); }, gear: vi.fn(), wearIron: vi.fn(), protect: vi.fn(), releaseReflex: vi.fn(), ACTOR: 'MinebotTrial',
    evidence: vi.fn(async () => ({ boss: { verified: true, witness: { entityId: options.missingProof ? 76 : 77 } } })),
    sleep: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)) };
  const factory = new Function(...Object.keys(deps), `let actorDeaths = 0; ${result.outputText}\nreturn { run: scenes.end_full_chain, die: () => { actorDeaths++; } };`);
  const api = factory(...Object.values(deps)) as { run: () => Promise<Record<string, any>>; die: () => void };
  return { ...api, actor, v, calls, commands, deps, totals, read, setHandler: (h: typeof handler) => { handler = h; },
    hurt: (hp: number) => { minHealth = Math.min(minHealth, hp); actor.health = hp; } };
}
async function settle<T>(promise: Promise<T>, maxMs = 30_000): Promise<T> {
  let done = false; promise.finally(() => { done = true; });
  for (let i = 0; i < maxMs && !done; i += 100) await vi.advanceTimersByTimeAsync(100);
  expect(done).toBe(true); return promise;
}

describe('end_full_chain actual probe scene with mocked I/O', () => {
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
  it('reuses the cage root/up/ring/bars/close/shaft sequence and shoots only after descending to a distant opening', async () => {
    const r = rig({ caged: true }); const out: any = await settle(r.run());
    expect(out.ok).toBe(true);
    expect(out.hands.filter((h: any) => ['go_root', 'pillar_up', 'guard_ring', 'dig_bars', 'guard_close', 'shaft_down', 'shoot_crystal'].includes(h.name)).map((h: any) => h.name))
      .toEqual(['go_root', 'pillar_up', 'guard_ring', 'dig_bars', 'guard_close', 'shaft_down', 'shoot_crystal']);
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
