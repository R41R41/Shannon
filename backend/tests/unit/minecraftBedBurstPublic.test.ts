import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Geometry has its own real-world-grid suite. These mocks isolate the public owner/receipt/one-approach state machine.
vi.mock('../../src/services/minebot/utils/dragonBedGeometry.js', async original => ({ ...await original<any>(),
  landingBedFireClear: vi.fn(() => true), landingBedRefusalSearch: vi.fn(function* (...args: any[]) {
    yield; if (args[7]) args[7].self = { distance: 5, exposure: 0, expected: 1, shielded: 1, box: { minX: 3.2, maxX: 3.8, minY: 62, maxY: 63.8, minZ: 6.2, maxZ: 6.8 }, model: 'normal_before_armour' }; return null;
  }),
  bedExposureSearch: vi.fn(function* () { yield; return 1; }),
}));
vi.mock('../../src/services/minebot/utils/dragonDanger.js', async original => ({ ...await original<any>(), dragonHazards: vi.fn(() => []) }));
vi.mock('../../src/services/minebot/utils/dragonState.js', async original => ({ ...await original<any>(), fountainOf: vi.fn(() => ({ x: .5, y: 64, z: .5 })) }));
vi.mock('../../src/services/minebot/utils/dragonLandingPath.js', async original => ({ ...await original<any>(),
  dragonLandingTarget: vi.fn(() => ({ x: .5, y: 64, z: .5 })), landingStandContacts: vi.fn(() => []),
  predictLandingPath: vi.fn(() => [{ phase: 3 }]),
  landingShotWindow: vi.fn(() => [0, 1].map(tick => ({ phase: 3, tick, observedTick: 0, forecastTick: 0, head: { x: 3.5, y: 65.5, z: 2.5 },
    headBox: { minX: 3, maxX: 4, minY: 65.5, maxY: 66.5, minZ: 2, maxZ: 3 } }))),
}));
vi.mock('../../src/services/minebot/utils/primitives/go.js', async original => ({ ...await original<any>(),
  go: vi.fn(async (ctx: any) => { ctx.bot.setControlState('back', true); return { ok: true, text: 'retreated' }; }),
}));

import { createMotorPort, executeAction } from '../../src/services/minebot/execution/ActionExecution.js';
import { bedBurstWorld } from '../../src/services/minebot/utils/bedBurstRuntime.js';
import { watchBedBurstDiagnostics } from '../../src/services/minebot/utils/bedBurstDiagnostics.js';
import { bedBurst } from '../../src/services/minebot/utils/primitives/bedBurst.js';
import { bedBurstProblem } from '../../src/services/minebot/utils/bedBurst.js';
import { handProblem } from '../../src/services/minebot/utils/actHandRules.js';
import { ACT_HANDS, runAct } from '../../src/services/minebot/instantSkills/act.js';
import { takeActReport } from '../../src/services/minebot/utils/actReport.js';
import { go } from '../../src/services/minebot/utils/primitives/go.js';
import { bedExposureSearch, landingBedFireClear, landingBedRefusalSearch } from '../../src/services/minebot/utils/dragonBedGeometry.js';
import { landingShotWindow } from '../../src/services/minebot/utils/dragonLandingPath.js';

const foot = { x: 3, y: 65, z: 3 }, head = { x: 3, y: 65, z: 2 };
const args = { at: [foot, head], target: '#17', count: 2, seconds: 20 };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const ok = { success: true, result: 'ok' };
function fixture(phase = 3, explode = true, damage = true, initialPacket = true) {
  const writes: any[] = [], target = { id: 17, name: 'ender_dragon', position: new Vec3(0, 64, 0), yaw: 0, metadata: { 16: phase, 9: 200 } };
  const client: any = new EventEmitter(); let clicks = 0, hp = 200;
  const bot: any = Object.assign(new EventEmitter(), { _client: client, entities: { 17: target }, game: { dimension: 'the_end', minY: 0, height: 256 }, version: '1.21.11',
    entity: { id: 1, position: new Vec3(3.5, 62, 6.5), yaw: 0, pitch: 0, onGround: true }, health: 20, food: 20, player: { ping: 20 },
    inventory: { items: () => [{ name: 'red_bed', count: 10, type: 1 }], emptySlotCount: () => 20 }, heldItem: { name: 'red_bed', count: 10 },
    controlState: {}, executingSkill: false, interruptExecution: false,
    clearControlStates: vi.fn(), setControlState: vi.fn(), stopDigging: vi.fn(), deactivateItem: vi.fn(),
    equip: vi.fn(async (item: any) => { bot.heldItem = item; }), look: vi.fn(async () => {}),
    pathfinder: { stop: vi.fn(), setGoal: vi.fn() },
    blockAt: (p: any) => { const solid = p.y === 61 || (p.y === 64 && p.x === 3 && [2, 3].includes(p.z));
      return { name: solid ? 'bedrock' : 'air', boundingBox: solid ? 'block' : 'empty', shapes: [], position: new Vec3(p.x, p.y, p.z) }; } });
  const world = bedBurstWorld(bot); world.dragon(17);
  const health = () => client.emit('entity_metadata', { entityId: 17, metadata: [{ key: 9, value: hp }] }); health();
  client.write = vi.fn((name: string, data: any) => {
    writes.push({ name, data, tick: observed.tick() });
    if (name === 'block_place' && ++clicks % 2 === 0 && explode) queueMicrotask(() => {
      client.emit('explosion', { center: { x: 3.5, y: 65.5, z: 2.5 } }); if (damage) { hp -= 40; health(); }
    });
  });
  // Keep the observer outside the write override (as it is with Mineflayer's native writer).
  world.stop(); target.metadata[16] = 2; const observed = bedBurstWorld(bot); observed.dragon(17);
  observed.rememberSite(17, { foot, head, stand: { x: 3.5, y: 62, z: 6.5 }, screen: [], supports: [{ ...foot, y: foot.y - 1 }, { ...head, y: head.y - 1 }],
    headDistance: 1, selfExposure: 0, headDamage: 50, score: 0 }, { x: .5, y: 64, z: .5 });
  target.metadata[16] = phase; client.emit('entity_metadata', { entityId: 17, metadata: [{ key: 16, value: phase }] }); if (initialPacket) health();
  const tick = async (n = 1) => { for (let i = 0; i < n; i++) { bot.emit('physicsTick'); await vi.advanceTimersByTimeAsync(50); await flush(); } };
  const run = (patch = {}) => executeAction(bot, 'act', 0, async () => {
    const outcome = await bedBurst({ bot: createMotorPort(bot), stop: new AbortController().signal, deadline: Date.now() + 30000,
      facing: 'north', base: { x: 3, y: 62, z: 6 } }, { ...args, ...patch }); return { ...ok, result: JSON.stringify(outcome) };
  });
  return { bot, client, target, writes, world: observed, tick, run, phase: (value: number) => {
    target.metadata[16] = value; client.emit('entity_metadata', { entityId: 17, metadata: [{ key: 16, value }] }); }, health };
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('public bed_burst contract', () => {
  it('adds only a kind, keeping the strict existing fields and maximum twelve hands', () => {
    expect(ACT_HANDS.safeParse([{ do: 'bed_burst', ...args }]).success).toBe(true);
    expect(handProblem({ do: 'bed_burst', ...args })).toBe(null);
    expect(ACT_HANDS.safeParse(Array.from({ length: 13 }, () => ({ do: 'bed_burst', ...args }))).success).toBe(false);
    expect(handProblem({ do: 'bed_burst', ...args, item: 'red_bed' })).toMatch('使えない');
  });
  it.each([{ target: 17 }, { target: 'ender_dragon' }, { target: '#9007199254740992' }, { target: '#-1' }, { count: 0 }, { count: 6 }, { count: 1.1 },
    { seconds: 0 }, { seconds: 21 }, { seconds: Infinity }, { rel: true }, { at: [foot] }, { at: [foot, foot] },
    { at: [{ ...foot, x: 3.5 }, head] }, { at: [{ front: 1 }, { front: 2 }] }])('refuses malformed mechanical input %j', patch => {
    expect(bedBurstProblem({ ...args, ...patch })).not.toBe(null);
  });
});

describe('one approach, evidence and retreat through the public act dispatcher', () => {
  it('runs red-bed bursts with the measured gap, then executes the next go under the same act owner', async () => {
    vi.useFakeTimers(); const f = fixture(); const since = Date.now();
    const diagnostics: any[] = [], stop = watchBedBurstDiagnostics(f.bot, e => diagnostics.push(e));
    for (let i = 1; i <= 20; i++) {
      await f.tick(); f.target.position.set(i / 10, 64, 0);
      f.client.emit('sync_entity_position', { entityId: 17, yaw: 180, dx: .1, dy: 0, dz: 0 });
    }
    const run = executeAction(f.bot, 'act', 0, () => runAct(createMotorPort(f.bot), [{ do: 'bed_burst', ...args }, { do: 'go', to: { x: 15, y: 62, z: 6 } }]));
    await flush(); await f.tick(22); await run;
    const uses = f.writes.filter(w => w.name === 'block_place' && w.data.cursorY === .5625);
    expect(uses).toHaveLength(2); expect(uses[1].tick - uses[0].tick).toBeGreaterThanOrEqual(11);
    expect(go).toHaveBeenCalledTimes(1); const report = takeActReport(f.bot, since)!;
    expect(report.lines.map(l => l.do)).toEqual(['bed_burst', 'go']);
    expect(report.lines[0]).toMatchObject({ goal: 'done', end: 'finished', progress: { unit: 'item', done: 2 }, code: 'landing_train_finished' });
    expect(diagnostics.some(e => e.stage === 'wait' && e.code === 'eleven_tick_gap')).toBe(true);
    const ready = diagnostics.find(e => e.code === 'ready');
    expect(ready.heads).toHaveLength(2);
    expect(ready.heads.map((h: any) => h.kind)).toEqual(['head_model_at_latest_body_packet', 'forecast_head_model']);
    expect(ready.heads.every((h: any) => h.exposure === 1 && h.damage === 71 && h.headBox.maxY === 66.5)).toBe(true);
    expect(ready.self).toMatchObject({ exposure: 0, expected: 1, model: 'normal_before_armour', actor: { x: 3.5, y: 62, z: 6.5 } });
    expect(ready.selfCheckedAtThisTick).toBe(true);
    const gap = diagnostics.find(e => e.code === 'eleven_tick_gap');
    expect(gap.bodyPoseHistory.map((p: any) => p.tick)).toEqual(Array.from({ length: 16 }, (_, i) => i + 5));
    expect(gap.bodyPoseHistory.at(-1)).toMatchObject({ position: { x: 2, y: 64, z: 0 }, velocity: { x: .1, y: 0, z: 0 }, velocityTick: 20 });
    expect(gap.bodyPoseHistorySource).toContain('not_native_part_truth');
    expect(diagnostics.at(-1)).toMatchObject({ stage: 'finish', code: 'landing_train_finished', done: 2 });
    const n = f.writes.length; await f.tick(3); expect(f.writes).toHaveLength(n); stop(); f.world.stop();
  });
  it('keeps writes and geometry work identical with no observer, a normal observer, or a throwing/mutating observer', async () => {
    vi.useFakeTimers(); const summaries: any[] = [];
    for (const mode of ['off', 'on', 'throw']) {
      const f = fixture(), beforeExposure = vi.mocked(bedExposureSearch).mock.calls.length, beforeChecks = vi.mocked(landingBedRefusalSearch).mock.calls.length;
      const stop = mode === 'off' ? () => {} : watchBedBurstDiagnostics(f.bot, e => { if (mode === 'throw') { (e.heads as any[])?.splice(0); (e.bodyPoseHistory as any[])?.splice(0); throw Error('observer'); } });
      const run = f.run(); await flush(); await f.tick(22); const outcome = JSON.parse((await run).result);
      summaries.push({ writes: f.writes, code: outcome.code, progress: outcome.progress,
        exposureCalls: vi.mocked(bedExposureSearch).mock.calls.length - beforeExposure, checks: vi.mocked(landingBedRefusalSearch).mock.calls.length - beforeChecks });
      stop(); f.world.stop();
    }
    expect(summaries[1]).toEqual(summaries[0]); expect(summaries[2]).toEqual(summaries[0]);
  });
  it('accepts the current phase2→3 entry and stops if that approach leaves before 3', async () => {
    vi.useFakeTimers(); const f = fixture(2); const run = f.run({ count: 1 }); await flush(); await f.tick(2);
    expect(f.writes).toEqual([]); f.phase(3); await f.tick(7); const out = JSON.parse((await run).result);
    expect(out.progress.done).toBe(1); f.world.stop();
    const g = fixture(2); const stopped = g.run(); await flush(); await g.tick(); g.phase(0); g.phase(2); await g.tick();
    expect(JSON.parse((await stopped).result).code).toBe('landing_window_ended'); expect(g.writes).toEqual([]); g.world.stop();
  });
  it('unknown use permits the immediately following retreat but never counts a blast', async () => {
    vi.useFakeTimers(); const f = fixture(3, false); const since = Date.now();
    const run = executeAction(f.bot, 'act', 0, () => runAct(createMotorPort(f.bot), [{ do: 'bed_burst', ...args }, { do: 'go', to: { x: 15, y: 62, z: 6 } }]));
    await flush(); await f.tick(8); await run; const report = takeActReport(f.bot, since)!;
    expect(report.lines[0]).toMatchObject({ goal: 'unknown', end: 'finished', progress: { done: 0 } }); expect(go).toHaveBeenCalledOnce();
    expect(f.world.dragon(17)?.uses).toBe(1); f.world.stop();
  });
  it('does not repeat without observed HP loss or reset the five-bed cap with another hand', async () => {
    vi.useFakeTimers(); const f = fixture(3, true, false); const run = f.run(); await flush(); await f.tick(9);
    expect(JSON.parse((await run).result)).toMatchObject({ goal: 'unknown', code: 'landing_previous_health_unconfirmed', progress: { done: 1 } });
    expect(f.world.dragon(17)?.uses).toBe(1); f.world.stop();
    const g = fixture(); g.world.dragon(17)!.uses = 5; const capped = g.run(); await flush();
    expect(JSON.parse((await capped).result).code).toBe('landing_five_bed_limit'); expect(g.writes).toEqual([]); g.world.stop();
  });
  it('uses cached native HP only for the first baseline; no new metadata packet is needed before the first use', async () => {
    vi.useFakeTimers(); const f = fixture(3, true, true, false); expect(f.world.dragon(17)!.health.map(h => h.source)).toEqual(['snapshot']);
    const run = f.run(); await flush(); await f.tick(22);
    expect(JSON.parse((await run).result).progress.done).toBe(2); f.world.stop();
  });
  it('refuses an absent blueprint or a different stand even when foot/head are the same', async () => {
    vi.useFakeTimers(); const f = fixture();
    const layout = f.world.site(17, foot, head)!; f.phase(2); f.world.rememberSite(17, { ...layout, stand: { x: 15, y: 62, z: 6 } }, { x: .5, y: 64, z: .5 }); f.phase(3);
    const run = f.run(); await flush(); expect(JSON.parse((await run).result).reason).toBe('landing_layout_unobserved'); expect(f.writes).toEqual([]); f.world.stop();
  });
  it('freezes arrival at the phase2→3 boundary rather than accepting a late arrival', async () => {
    vi.useFakeTimers(); const f = fixture(2); const run = f.run(); await flush(); await f.tick();
    f.bot.entity.position = new Vec3(15, 62, 6.5); f.phase(3); f.bot.entity.position = new Vec3(3.5, 62, 6.5); await f.tick();
    expect(JSON.parse((await run).result).code).toBe('landing_not_prepared_in_phase2'); expect(f.writes).toEqual([]); f.world.stop();
  });
  it('vetoes a changed central heightmap while waiting and a shield/reflex that still owns the hand', async () => {
    vi.useFakeTimers(); const f = fixture(2); const run = f.run(); await flush();
    f.bot.emit('blockUpdate', { name: 'air', boundingBox: 'empty' }, { name: 'obsidian', boundingBox: 'block', position: { x: 0, y: 65, z: 0 } });
    await f.tick(); expect(JSON.parse((await run).result).code).toBe('landing_target_changed'); expect(f.writes).toEqual([]); f.world.stop();
    const g = fixture(); g.bot.shieldBlock = { up: true }; const blocked = g.run(); await flush();
    expect(JSON.parse((await blocked).result).code).toBe('reflex_or_shield_owns_body'); expect(g.writes).toEqual([]); g.world.stop();
  });
  it('retains the runtime safety veto and never promotes a missing prediction to permission', async () => {
    vi.useFakeTimers(); const f = fixture(); vi.mocked(landingBedRefusalSearch).mockImplementationOnce(function* () { return 'landing_stand_in_dragon'; });
    const run = f.run(); await flush(); expect(JSON.parse((await run).result).code).toBe('landing_stand_in_dragon'); expect(f.writes).toEqual([]); f.world.stop();
    const g = fixture(); vi.mocked(landingShotWindow).mockReturnValue([]); const missing = g.run({ seconds: 1 }); await flush(); await g.tick(21);
    expect(JSON.parse((await missing).result).code).toBe('landing_time_limit'); expect(g.writes).toEqual([]); g.world.stop();
  });
  it('observes a closed head window without authorizing use and distinguishes fire from unread at the final refusal', async () => {
    vi.useFakeTimers(); const f = fixture(), rows: any[] = [], stop = watchBedBurstDiagnostics(f.bot, e => rows.push(e));
    vi.mocked(landingShotWindow).mockReturnValue([]); const run = f.run({ seconds: 1 }); await flush(); await f.tick(21);
    expect(JSON.parse((await run).result).code).toBe('landing_time_limit'); expect(f.writes).toEqual([]);
    expect(rows.some(e => e.stage === 'ready' && e.code === 'head_history_unavailable')).toBe(true); stop(); f.world.stop();
    const g = fixture(), final: any[] = [], stopG = watchBedBurstDiagnostics(g.bot, e => final.push(e));
    g.bot.blockAt = (p: any) => p.x === 3 && p.y === 61 && p.z === 6 ? null : { name: p.x === 4 && p.y === 62 && p.z === 6 ? 'fire' : 'air' };
    vi.mocked(landingBedFireClear).mockReturnValueOnce(false); const refused = g.run(); await flush();
    expect(JSON.parse((await refused).result).code).toBe('landing_fire_or_unloaded_neighbour'); expect(g.writes).toEqual([]);
    expect(final.at(-1).fireCells.filter((c: any) => !c.loaded)).toHaveLength(1);
    expect(final.at(-1).fireCells.filter((c: any) => c.fire)).toHaveLength(1); stopG(); g.world.stop();
  });
  it('refuses act repeat before any hand moves', async () => {
    vi.useFakeTimers(); const f = fixture(); const outcome = await runAct(f.bot, [{ do: 'bed_burst', ...args }], undefined, undefined, { repeat: 2 });
    expect(outcome).toMatchObject({ success: false, failureType: 'invalid_input' }); expect(f.writes).toEqual([]); f.world.stop();
  });
});
